# 21 — Network Cue Relay

> **Stats_X v1.404 — Unreal Engine 5.7**
> Layer: **Presentation / Network** — `AStatsX_NetCueRelay` actor reference, montage lifecycle integration, custom cue extension, and profiling.

---

## 1. Purpose

This document is the **actor-level reference** for `AStatsX_NetCueRelay` —
the lightweight `AInfo` subclass that transports cosmetic cues from the
server to clients.  While [18 — Cosmetic Cue Routing](18_Cosmetic_Cue_Routing.md)
covers the routing pipeline end-to-end, this document focuses on:

- The relay actor's internal state machine and configuration knobs.
- Montage lifecycle integration via `UForge_MontageCallbackHelper`.
- The `EStatsXCosmeticCueType::Custom` extension point.
- Complete profiling stat reference.
- Capacity and safety limits.

---

## 2. Relay Actor Class Card

```
Source  Public/Net/StatsX_NetCueRelay.h:138-197
        Private/Net/StatsX_NetCueRelay.cpp:178-838
```

```
UCLASS(NotBlueprintable, NotPlaceable, Transient)
class AStatsX_NetCueRelay : public AInfo
```

| Property | Value | Notes |
|---|---|---|
| Base class | `AInfo` | No visual, no collision, no movement |
| `bReplicates` | `true` | Network-replicated actor |
| `bAlwaysRelevant` | `false` (route) / `true` (global) | See §3 |
| `bOnlyRelevantToOwner` | `false` | Visible to all clients in relevancy range |
| `bNetUseOwnerRelevancy` | `true` (route) / `false` (global) | See §3 |
| `SetReplicateMovement` | `false` | No movement replication |
| `NetUpdateFrequency` | `30.f` | Target updates/second |
| `MinNetUpdateFrequency` | `10.f` | Floor under adaptive frequency |
| `SetActorHiddenInGame` | `true` | Invisible in game |
| `SetCanBeDamaged` | `false` | No damage processing |

---

## 3. Configuration Modes

### 3.1 Route-Actor Relay

```
Source  Private/Net/StatsX_NetCueRelay.cpp:215-228
```

```cpp
void ConfigureForRouteActor(AActor* InRouteActor)
{
    RouteActor = InRouteActor;
    bGlobalRelay = false;
    bAlwaysRelevant = false;
    bNetUseOwnerRelevancy = true;
    SetOwner(InRouteActor);
    ForceNetUpdate();
}
```

The relay **inherits relevancy from its owner**.  Clients that can see the
route actor automatically receive the relay and its cues.  Clients outside
relevancy range receive nothing — zero wasted bandwidth.

### 3.2 Global Relay

```
Source  Private/Net/StatsX_NetCueRelay.cpp:230-243
```

```cpp
void ConfigureAsGlobalRelay()
{
    RouteActor = nullptr;
    bGlobalRelay = true;
    bAlwaysRelevant = true;
    bNetUseOwnerRelevancy = false;
    SetOwner(nullptr);
    ForceNetUpdate();
}
```

Always relevant to all connected clients.  Used for cues with no actor
affinity or as a fallback when the route-actor relay cap is exceeded.

---

## 4. Replicated Properties

```
Source  Private/Net/StatsX_NetCueRelay.cpp:206-213
```

| Property | Type | Purpose |
|---|---|---|
| `ReplicatedStateCues` | `FStatsXReplicatedStateCueArray` | FFastArraySerializer for state-reliable cues |
| `RouteActor` | `TObjectPtr<AActor>` | Actor whose relevancy this relay tracks |
| `bGlobalRelay` | `uint8 : 1` | True when configured as global fallback |

All three use unconditional `DOREPLIFETIME`.

---

## 5. State Cue Pipeline (Server)

### 5.1 PushCueFromServer

```
Source  Private/Net/StatsX_NetCueRelay.cpp:245-291
```

```
Authority check
  ↓
BuildWireCue(Cue) → FStatsXNetCueWireData
  ↓
┌── StateReliable ─────────────────────────────────┐
│  Build FStatsXCosmeticCueStreamKey                │
│  ↓                                                │
│  StateCueIndexByStream.Find(StreamKey)?           │
│  ├── Found → overwrite item in-place, MarkDirty   │
│  └── Not found → AddDefaulted, MarkDirty, index   │
│  ↓                                                │
│  Overflow check: Items.Num() > MaxStateCueEntries │
│  └── Remove oldest, MarkArrayDirty, RebuildIndex  │
│  ↓                                                │
│  ForceNetUpdate()                                  │
└──────────────────────────────────────────────────┘
┌── BurstUnreliable ───────────────────────────────┐
│  MulticastBurstCue(WireCue)   [NetMulticast RPC] │
└──────────────────────────────────────────────────┘
```

### 5.2 StateCueIndexByStream

```cpp
TMap<FStatsXCosmeticCueStreamKey, int32> StateCueIndexByStream;
```

Server-side O(1) lookup for **latest-value-wins** deduplication.  Rebuilt
from scratch via `RebuildStateCueIndex()` only after overflow eviction
(which shifts array indices).

### 5.3 Overflow Eviction

```
Source  Private/Net/StatsX_NetCueRelay.cpp:277-283
```

When `Items.Num() > MaxStateCueEntries` (default **96**):

1. Compute `RemoveCount = Items.Num() - MaxStateCueEntries`.
2. `RemoveAt(0, RemoveCount, EAllowShrinking::No)` — evict oldest.
3. `MarkArrayDirty()` — full resync to all clients.
4. `RebuildStateCueIndex()` — O(N) index reconstruction.

---

## 6. Client Reception

### 6.1 State Cues

```
Source  Private/Net/StatsX_NetCueRelay.cpp:162-176, 305-315
```

`FFastArraySerializer` drives `PostReplicatedAdd` / `PostReplicatedChange`
on each `FStatsXReplicatedStateCueItem`.  Both delegate to:

```cpp
void HandleReplicatedStateCue(const FStatsXReplicatedStateCueItem& Item)
{
    if (HasAuthority()) return;
    DispatchCueOnClient(BuildRuntimeCue(Item.Cue, StateReliable));
}
```

New clients joining mid-session receive the full state array (join-in-progress
safe).

### 6.2 Burst Cues

```
Source  Private/Net/StatsX_NetCueRelay.cpp:293-303
```

```cpp
UFUNCTION(NetMulticast, Unreliable)
void MulticastBurstCue(const FStatsXNetCueWireData& WireCue);
```

Client implementation skips authority, then calls `DispatchCueOnClient` with
`BurstUnreliable` channel.  No join-in-progress guarantee — burst cues are
for one-shot effects.

### 6.3 DispatchCueOnClient

```
Source  Private/Net/StatsX_NetCueRelay.cpp:317-337
```

Three-stage client dispatch:

| Stage | Action |
|---|---|
| 1. `ExecuteBuiltInCue(Cue)` | Immediate local playback (montage, VFX, SFX) |
| 2. `OnClientCueReceivedNative.Broadcast(Cue)` | Native C++ delegate for custom consumers |
| 3. `Subsystem->EnqueueCosmeticCue(Cue)` | Re-inject into local bus for Blueprint/sink consumers |

---

## 7. Montage Lifecycle Integration

### 7.1 UForge_MontageCallbackHelper

```
Source  Public/Nodes/Nodes_Core.h:24-81
        Private/Nodes/Nodes_Core.cpp:201-340
```

A `UObject` helper created per `OP_PlayMontage` invocation to bridge montage
animation delegates with the ForgeVM execution context.

| Field | Type | Purpose |
|---|---|---|
| `StatusID` | `int64` | Owning status instance |
| `NodePC` | `int32` | Instruction that spawned this montage |
| `ImmediatePC` | `int32` | PC for immediate return after play |
| `OnBlendInPC` | `int32` | PC to resume on blend-in |
| `OnBlendOutPC` | `int32` | PC to resume on blend-out |
| `OnInterruptedPC` | `int32` | PC to resume on interruption |
| `OnCancelledPC` | `int32` | PC to resume on cancel |
| `OnCompletedPC` | `int32` | PC to resume on completion |
| `bStopOnStatusEnds` | `bool` | Auto-stop montage when owning status terminates |
| `PendingSignals` | `TArray<uint8>` | Queue for deferred signal dispatch |

**Static registry:**

```cpp
static TMap<int64, TWeakObjectPtr<UForge_MontageCallbackHelper>> ActiveHelpers;
```

### 7.2 Status Termination → StopMontage Cue

```
Source  Private/Nodes/Nodes_Core.cpp:328-340 (OnStatusSet callback)
        Private/Nodes/Nodes_Core.cpp:201-260 (Cleanup)
```

The helper binds to `Subsystem->OnStatusSet` at creation.  When the owning
status is removed (`EStatusSetAction::Removed`):

1. `OnStatusSet(Data)` fires → calls `Cleanup(bStopOnStatusEnds)`.
2. **Cleanup** unregisters from the static map, unbinds delegates.
3. If `bStopOnStatusEnds == true`:
   - Constructs `FStatsXCosmeticCue`:

| Field | Value |
|---|---|
| `CueType` | `StopMontage` |
| `Channel` | `StateReliable` |
| `RoutePolicy` | `TargetActor` |
| `Asset` | The playing `UAnimMontage` |
| `Float0` | `0.15` (blend-out time) |
| `Key.StatusID` | Original StatusID |
| `Key.NodePC` | Original NodePC |

   - Calls `Subsystem->EnqueueCosmeticCue(Cue)`.
   - Also calls `Montage_Stop(0.15f)` locally for immediate feedback.

4. The StopMontage cue enters the bus, gets routed to the relay, and
   **overwrites the PlayMontage state** in the `ReplicatedStateCues` array
   (same `StreamKey`: StatusID + NodePC + StopMontage CueType).

### 7.3 Montage Signal Flow

```
OP_PlayMontage → create Helper → bind anim delegates
                                     ↓
                         OnMontageBlendedIn  → EnqueueSignal(BlendIn)
                         OnMontageBlendingOut → EnqueueSignal(BlendOut/Interrupted)
                         OnMontageEnded       → EnqueueSignal(Completed/Cancelled)
                                     ↓
                         RequestResumeNode() → VM resumes at signal-specific PC
```

Each signal (`BlendIn`, `BlendOut`, `Interrupted`, `Cancelled`, `Completed`)
maps to a distinct continuation PC in the status definition's instruction
stream, allowing designers to branch logic per montage event.

---

## 8. Custom Cue Extension Point

### 8.1 EStatsXCosmeticCueType::Custom

```
Source  Public/Data/StatsXCosmeticCueTypes.h:20
```

The `Custom` cue type is **not handled** by `ExecuteBuiltInCue` (falls through
the default case).  It exists as an extension point for game-specific cues.

### 8.2 OnClientCueReceived Delegate

```
Source  Public/Net/StatsX_NetCueRelay.h:136, 162
```

```cpp
DECLARE_MULTICAST_DELEGATE_OneParam(
    FOnStatsXNetRelayCueReceivedNative,
    const FStatsXCosmeticCue& /*Cue*/);

FOnStatsXNetRelayCueReceivedNative& OnClientCueReceived()
{
    return OnClientCueReceivedNative;
}
```

Broadcast **after** `ExecuteBuiltInCue` for every cue (not just Custom type).
Custom cues pass through `ExecuteBuiltInCue` as a no-op, then hit this
delegate where game code can interpret the payload.

### 8.3 Bus Sink Delegate

```
Source  Public/Core/StatsX_WorldSubsystem.h:28, 296
```

```cpp
DECLARE_MULTICAST_DELEGATE_TwoParams(
    FOnStatsXCosmeticCueRoutedNative,
    const FStatsXCosmeticCue& /*Cue*/,
    AActor* /*RouteActor*/);

FDelegateHandle RegisterCosmeticCueSink(
    const FOnStatsXCosmeticCueRoutedNative::FDelegate& Delegate);
```

Server-side sink registration for custom routing logic.  The network
transport is itself registered as a sink during `Initialize()`.

### 8.4 Extension Pattern

```
// Game code: register a custom sink for game-specific cue routing
FDelegateHandle Handle = Subsystem->RegisterCosmeticCueSink(
    FOnStatsXCosmeticCueRoutedNative::FDelegate::CreateUObject(
        this, &UMyComponent::OnCosmeticCueRouted));

// Or listen on a relay for client-side custom cues
Relay->OnClientCueReceived().AddUObject(
    this, &UMyComponent::OnClientCueReceived);
```

---

## 9. Relay Lifecycle Management

### 9.1 Creation

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:810-900
```

`GetOrCreateNetCueRelay(AActor* RouteActor)`:

1. **Stale cleanup** — iterate `RouteActorNetCueRelays`, destroy relays whose
   weak pointers are invalid.
2. **Route actor null / not replicated** → global relay path:
   - Return existing `GlobalNetCueRelay` if valid.
   - Spawn new `AStatsX_NetCueRelay` at identity transform, `RF_Transient`.
   - `ConfigureAsGlobalRelay()`.
3. **Valid replicated route actor** → per-actor path:
   - Return existing from `RouteActorNetCueRelays` cache.
   - If cache full (`≥ MaxRouteNetCueRelays`) → fallback to global relay.
   - Spawn new relay at route actor's transform, `RF_Transient`.
   - `ConfigureForRouteActor(RouteActor)`.
   - Cache in `RouteActorNetCueRelays`.

### 9.2 Fallback Chain

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:798-802
```

`HandleCosmeticCueRoutedForNetwork`:

```cpp
AStatsX_NetCueRelay* Relay = GetOrCreateNetCueRelay(RouteActor);
if (!Relay && IsValid(RouteActor))
{
    Relay = GetOrCreateNetCueRelay(nullptr);  // global fallback
}
```

Two-level fallback: route-specific → global.  A cue always finds a relay
unless the world is shutting down.

### 9.3 Destruction

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:902-918
```

`DestroyNetCueRelays()` — called during subsystem `Deinitialize`:

1. `GlobalNetCueRelay->Destroy()`, reset.
2. Iterate `RouteActorNetCueRelays`, destroy each relay.
3. Reset map.

### 9.4 EndPlay

```
Source  Private/Net/StatsX_NetCueRelay.cpp:199-204
```

```cpp
void AStatsX_NetCueRelay::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
    StateCueIndexByStream.Reset();
    OnClientCueReceivedNative.Clear();
    Super::EndPlay(EndPlayReason);
}
```

---

## 10. Capacity and Safety Limits

| Limit | Default | Scope | Purpose |
|---|---|---|---|
| `MaxStateCueEntries` | 96 | Per relay | Cap on state cue items; oldest evicted on overflow |
| `MaxRouteNetCueRelays` | 4096 | World | Hard cap on route-actor relays; excess fall back to global |
| `NetUpdateFrequency` | 30 Hz | Per relay | Target replication rate |
| `MinNetUpdateFrequency` | 10 Hz | Per relay | Minimum replication rate under load |
| `PendingCosmeticCues.Reserve` | 128 | World | Pre-allocated bus queue capacity |
| `PendingStateCueIndices.Reserve` | 64 | World | Pre-allocated state dedup capacity |
| `LocalVFXByHandle.Reserve` | 128 | World | Pre-allocated VFX registry capacity |
| `LocalSFXByHandle.Reserve` | 128 | World | Pre-allocated SFX registry capacity |
| VFX registry stale cleanup | 2048 | World | Trigger threshold for stale-entry sweep |

---

## 11. Performance Instrumentation

All relay and bus operations are profiled under **STATGROUP_StatsXNet**.

```
Source  Public/Helpers/StatsXPerf.h:51-63
```

### 11.1 Cycle Stats

| Stat Name | Scope | Location |
|---|---|---|
| `STAT_StatsXNetCueEnqueue` | `EnqueueCosmeticCue` | WorldSubsystem |
| `STAT_StatsXNetCueFlushBus` | `FlushCosmeticCueBus` | WorldSubsystem |
| `STAT_StatsXNetCueRouteToNetwork` | `HandleCosmeticCueRoutedForNetwork` | WorldSubsystem |
| `STAT_StatsXNetCueGetOrCreateRelay` | `GetOrCreateNetCueRelay` | WorldSubsystem |
| `STAT_StatsXNetCuePushFromServer` | `PushCueFromServer` | NetCueRelay |
| `STAT_StatsXNetCueBurstReceive` | `MulticastBurstCue_Impl` | NetCueRelay |
| `STAT_StatsXNetCueStateReceive` | `HandleReplicatedStateCue` | NetCueRelay |
| `STAT_StatsXNetCueDispatchClient` | `DispatchCueOnClient` | NetCueRelay |
| `STAT_StatsXNetCueExecuteBuiltIn` | `ExecuteBuiltInCue` (outer) | NetCueRelay |
| `STAT_StatsXNetCueExecuteMontage` | `ExecuteBuiltInCue` (montage branch) | NetCueRelay |
| `STAT_StatsXNetCueExecuteVFX` | `ExecuteBuiltInCue` (VFX branches) | NetCueRelay |
| `STAT_StatsXNetCueExecuteSFX` | `ExecuteBuiltInCue` (SFX branches) | NetCueRelay |
| `STAT_StatsXNetCueRebuildStateIndex` | `RebuildStateCueIndex` | NetCueRelay |

### 11.2 Macro

```
Source  Public/Helpers/StatsXPerf.h:242-247
```

```cpp
#define STATSX_NETCUE_SCOPE(NameLiteral, CsvStatName, CycleStatName) \
    do { \
        STATSX_NETCUE_TRACE_SCOPE(NameLiteral); \
        STATSX_NETCUE_CSV_SCOPE(CsvStatName); \
        STATSX_NETCUE_CYCLE_SCOPE(CycleStatName); \
    } while (0)
```

Three-layer instrumentation per scope:
1. **Trace** — Unreal Insights trace event.
2. **CSV** — CSV profiler column.
3. **Cycle** — `DECLARE_CYCLE_STAT` for `stat net` display.

---

## 12. Wire Format Quick Reference

```
Source  Public/Net/StatsX_NetCueRelay.h:16-91
```

`FStatsXNetCueWireData` — 21 `UPROPERTY` fields:

| Category | Fields |
|---|---|
| Identity | `CueType` (uint8), `RoutePolicy` (uint8), `StatusID` (int64), `NodePC` (int32), `Sequence` (uint16) |
| Actors | `CasterActor`, `TargetActor`, `ExplicitRouteActor` (TObjectPtr) |
| Metadata | `ServerWorldTimeSeconds` (float), `CueName` (FName) |
| Assets | `Asset`, `SecondaryAsset` (TObjectPtr) |
| Transform | `Location` (FVector_NetQuantize10), `Rotation` (FRotator), `Scale` (FVector_NetQuantize10) |
| Montage | `SectionName` (FName) |
| Payload | `Float0`–`Float3`, `Int0`, `Int1`, `Int64_0`, `Flags` |

Vectors use `FVector_NetQuantize10` — 1-decimal-place quantization for
network-efficient transport.

---

## 13. Built-In Cue Execution Summary

```
Source  Private/Net/StatsX_NetCueRelay.cpp:339-826
```

| CueType | Key payload | UE5 API called |
|---|---|---|
| `PlayMontage` | Asset=UAnimMontage, Float0=PlayRate, SectionName | `Montage_Play`, `Montage_JumpToSection` |
| `StopMontage` | Asset=UAnimMontage (optional), Float0=BlendOut | `Montage_Stop` or `StopAllMontages` |
| `SpawnVFX` | Asset=UNiagaraSystem, Int0=Space, Int1=Pool, Int64_0=Handle | `SpawnSystemAtLocation` |
| `SpawnVFXAttached` | Asset=UNiagaraSystem, SectionName=Socket, Int0=AttachRule | `SpawnSystemAttached` |
| `StopVFX` | Int64_0=Handle, Float0=BlendOut | `DeactivateImmediate` / `Deactivate` |
| `UpdateVFX` | Int64_0=Handle, Int0=Space | `SetWorldLocationAndRotation` |
| `SpawnSFX` | Asset=USoundBase, Float0=Vol, Float1=Pitch, Int1=Policy | `SpawnSoundAtLocation` / `PlaySoundAtLocation` |
| `StopSFX` | Int64_0=Handle, Float0=FadeOut | `Stop` / `FadeOut` |
| `Custom` | — | No-op (delegate-only) |

---

## 14. Design Decisions

| Decision | Rationale |
|---|---|
| **Single actor class, two modes** | Route-actor and global relays share code; mode is runtime configuration, not inheritance |
| **Owner relevancy for route relays** | Leverages UE5's built-in relevancy without custom `IsNetRelevantFor` |
| **RF_Transient + unique naming** | Relays are session-scoped, not saved, and traceable in actor lists |
| **96-entry state cap** | Bounds worst-case memory; oldest cues (likely stale) evicted first |
| **4096 relay cap** | Prevents relay explosion in massive open-world scenarios |
| **Custom cue type as no-op** | Zero overhead for built-in dispatch; game code opts in via delegate |
| **Three-stage client dispatch** | Built-in execution → native delegate → bus re-inject covers all consumer patterns |
| **Montage helper as UObject** | GC-safe; weak pointers prevent dangling references after actor destruction |
| **bStopOnStatusEnds** | Designer-controlled: automatic cleanup vs manual lifecycle management |

---

## 15. See Also

| Document | Relationship |
|---|---|
| [17 — Cosmetic Cue System](17_Cosmetic_Cue_System.md) | Local bus that produces cues |
| [18 — Cosmetic Cue Routing](18_Cosmetic_Cue_Routing.md) | Routing pipeline from bus to relay |
| [19 — VFX / SFX Handles](19_VFX_SFX_Handles.md) | Handle allocation and component tracking |
| [20 — Replication](20_Replication.md) | Gameplay state replication (separate channel) |
| [23 — Performance Instrumentation](23_Performance_Instrumentation.md) | Full stat group reference |
