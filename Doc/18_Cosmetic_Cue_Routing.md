# 18 — Cosmetic Cue Routing

> **Stats_X v1.404 — Unreal Engine 5.7**
> Layer: **Presentation / Network** — replicated transport for cosmetic cues via `AStatsX_NetCueRelay`.

---

## 1. Purpose

The Cosmetic Cue Routing system bridges the local cue bus (see
[17 — Cosmetic Cue System](17_Cosmetic_Cue_System.md)) with remote clients.
On authority machines (Dedicated Server / Listen Server), a registered network
sink captures every flushed cue, selects or spawns an `AStatsX_NetCueRelay`
actor, and pushes the cue through UE5's built-in replication:

- **State-reliable** cues → `FFastArraySerializer` (delta-compressed,
  latest-value-wins per stream, join-in-progress safe).
- **Burst-unreliable** cues → `NetMulticast Unreliable` RPC (fire-and-forget,
  no join-in-progress guarantee).

On the receiving client, the relay reconstructs the runtime cue, executes
built-in effects (montage, VFX, SFX), and re-enqueues the cue into the local
bus so custom sinks also fire.

---

## 2. Network Architecture

```
 SERVER                                         CLIENT
 ──────                                         ──────
 FlushCosmeticCueBus()
   │  OnCosmeticCueRoutedNative.Broadcast()
   ▼
 HandleCosmeticCueRoutedForNetwork()
   │  GetOrCreateNetCueRelay(RouteActor)
   ▼
 AStatsX_NetCueRelay::PushCueFromServer()
   ├─ StateReliable:
   │    ReplicatedStateCues (FastArray)  ──────► PostReplicatedAdd/Change
   │                                               │
   └─ BurstUnreliable:                             │
        MulticastBurstCue() ───────────────────► MulticastBurstCue_Impl
                                                   │
                                            DispatchCueOnClient()
                                               ├── ExecuteBuiltInCue()
                                               ├── OnClientCueReceivedNative
                                               └── EnqueueCosmeticCue() (re-inject)
```

---

## 3. Wire Format

### 3.1 FStatsXNetCueWireData

```
Source  Public/Net/StatsX_NetCueRelay.h:16-91
```

USTRUCT that mirrors `FStatsXCosmeticCue` with replication-friendly types:

| Field | Wire type | Notes |
|---|---|---|
| `CueType` | `uint8` | Enum cast |
| `RoutePolicy` | `uint8` | Enum cast |
| `StatusID` | `int64` | Identity |
| `NodePC` | `int32` | Identity |
| `Sequence` | `uint16` | Ordering |
| `CasterActor` | `TObjectPtr<AActor>` | Replicated actor ref |
| `TargetActor` | `TObjectPtr<AActor>` | Replicated actor ref |
| `ExplicitRouteActor` | `TObjectPtr<AActor>` | Replicated actor ref |
| `ServerWorldTimeSeconds` | `float` | Timestamp |
| `CueName` | `FName` | Optional key |
| `Asset` | `TObjectPtr<UObject>` | Primary asset |
| `SecondaryAsset` | `TObjectPtr<UObject>` | Secondary asset |
| `Location` | `FVector_NetQuantize10` | Quantized position |
| `Rotation` | `FRotator` | Rotation |
| `Scale` | `FVector_NetQuantize10` | Quantized scale |
| `SectionName` | `FName` | Section/socket name |
| `Float0..Float3` | `float` | Numeric slots |
| `Int0, Int1` | `int32` | Integer slots |
| `Int64_0` | `int64` | Handle slot |
| `Flags` | `uint8` | Bitfield |

Vectors use `FVector_NetQuantize10` for network-efficient quantization
(1 decimal place precision).

### 3.2 Conversion Helpers

```
Source  Private/Net/StatsX_NetCueRelay.cpp:27-95
```

| Function | Direction |
|---|---|
| `BuildWireCue(FStatsXCosmeticCue)` | Runtime → wire (server-side, before send) |
| `BuildRuntimeCue(FStatsXNetCueWireData, Channel)` | Wire → runtime (client-side, after receive) |
| `BuildStreamKey(FStatsXNetCueWireData)` | Wire → dedup key (server-side, for state cue indexing) |

All three are anonymous-namespace free functions — zero-overhead, no virtual
dispatch.

---

## 4. Relay Actor — AStatsX_NetCueRelay

```
Source  Public/Net/StatsX_NetCueRelay.h:138-197
       Private/Net/StatsX_NetCueRelay.cpp:178-838
```

`UCLASS(NotBlueprintable, NotPlaceable, Transient)` — pure infrastructure,
not exposed to Blueprints or level design.  Inherits from `AInfo` (no
visual representation, no collision).

### 4.1 Constructor Defaults

```
Source  Private/Net/StatsX_NetCueRelay.cpp:178-191
```

| Property | Value | Purpose |
|---|---|---|
| `bReplicates` | `true` | Actor is network-replicated |
| `bAlwaysRelevant` | `false` | Only relevant when owner is |
| `bOnlyRelevantToOwner` | `false` | Visible to all clients in relevancy range |
| `bNetUseOwnerRelevancy` | `true` | Inherit relevancy from owner actor |
| `SetReplicateMovement` | `false` | No movement replication needed |
| `NetUpdateFrequency` | `30.f` | Target updates per second |
| `MinNetUpdateFrequency` | `10.f` | Minimum updates per second |
| `bGlobalRelay` | `false` | Not global by default |
| `SetActorHiddenInGame` | `true` | Invisible |
| `SetCanBeDamaged` | `false` | No damage processing |

### 4.2 Replicated Properties

```
Source  Private/Net/StatsX_NetCueRelay.cpp:206-213
```

```cpp
DOREPLIFETIME(AStatsX_NetCueRelay, ReplicatedStateCues);
DOREPLIFETIME(AStatsX_NetCueRelay, RouteActor);
DOREPLIFETIME(AStatsX_NetCueRelay, bGlobalRelay);
```

### 4.3 Configuration Modes

#### Route-Actor Relay

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
    SetOwner(InRouteActor);           // ← inherit relevancy
    ForceNetUpdate();
}
```

The relay is only replicated to clients for whom `InRouteActor` is relevant.
This provides automatic scope-based filtering — a character's cosmetic cues
are only sent to clients that can see that character.

#### Global Relay

```
Source  Private/Net/StatsX_NetCueRelay.cpp:230-243
```

```cpp
void ConfigureAsGlobalRelay()
{
    RouteActor = nullptr;
    bGlobalRelay = true;
    bAlwaysRelevant = true;           // ← visible to all clients
    bNetUseOwnerRelevancy = false;
    SetOwner(nullptr);
    ForceNetUpdate();
}
```

Used for cues with no actor affinity (route policy `Global`) or as a fallback
when no valid route actor exists.

---

## 5. State Cue Replication

### 5.1 FastArraySerializer Pipeline

```
Source  Public/Net/StatsX_NetCueRelay.h:94-134
```

| Struct | Role |
|---|---|
| `FStatsXReplicatedStateCueItem` | `FFastArraySerializerItem` wrapping one `FStatsXNetCueWireData` |
| `FStatsXReplicatedStateCueArray` | `FFastArraySerializer` container with `TArray<Item>` and `OwnerRelay` back-pointer |

`TStructOpsTypeTraits` enables `WithNetDeltaSerializer` for delta-compressed
network transport via `FastArrayDeltaSerialize`.

### 5.2 Client Reception

```
Source  Private/Net/StatsX_NetCueRelay.cpp:162-176
```

```cpp
void FStatsXReplicatedStateCueItem::PostReplicatedAdd(const FStatsXReplicatedStateCueArray& Serializer)
{
    if (AStatsX_NetCueRelay* Relay = Serializer.OwnerRelay.Get())
        Relay->HandleReplicatedStateCue(*this);
}

void FStatsXReplicatedStateCueItem::PostReplicatedChange(const FStatsXReplicatedStateCueArray& Serializer)
{
    if (AStatsX_NetCueRelay* Relay = Serializer.OwnerRelay.Get())
        Relay->HandleReplicatedStateCue(*this);
}
```

Both `Add` and `Change` delegate to `HandleReplicatedStateCue`, which
reconstructs the runtime cue with `StateReliable` channel and calls
`DispatchCueOnClient`.

### 5.3 Server-Side Stream Dedup

```
Source  Private/Net/StatsX_NetCueRelay.cpp:245-291
```

`PushCueFromServer` for state-reliable cues:

1. Build `FStatsXCosmeticCueStreamKey` from the cue.
2. Lookup in `StateCueIndexByStream`:
   - **Found** → overwrite existing item in-place, mark dirty.
   - **Not found** → append new item, record index.
3. **Overflow guard** — if `Items.Num() > MaxStateCueEntries` (default 96):
   - Remove oldest entries from front (`RemoveAt(0, RemoveCount)`).
   - `MarkArrayDirty()` for full resync.
   - `RebuildStateCueIndex()` to rebuild the `StreamKey → index` map.
4. `ForceNetUpdate()` to push delta immediately.

### 5.4 RebuildStateCueIndex

```
Source  Private/Net/StatsX_NetCueRelay.cpp:828-838
```

Called after overflow eviction to reconstruct the dedup map:

```cpp
void AStatsX_NetCueRelay::RebuildStateCueIndex()
{
    StateCueIndexByStream.Reset();
    StateCueIndexByStream.Reserve(ReplicatedStateCues.Items.Num());
    for (int32 i = 0; i < ReplicatedStateCues.Items.Num(); ++i)
    {
        StateCueIndexByStream.Add(
            BuildStreamKey(ReplicatedStateCues.Items[i].Cue), i);
    }
}
```

---

## 6. Burst Cue Transport

```
Source  Private/Net/StatsX_NetCueRelay.cpp:289, 293-303
```

Burst-unreliable cues bypass the `FastArraySerializer` entirely:

```cpp
// Server side (PushCueFromServer)
MulticastBurstCue(WireCue);

// Client side (MulticastBurstCue_Implementation)
void AStatsX_NetCueRelay::MulticastBurstCue_Implementation(const FStatsXNetCueWireData& WireCue)
{
    if (HasAuthority()) return;   // server doesn't self-dispatch
    DispatchCueOnClient(BuildRuntimeCue(WireCue, EStatsXCosmeticCueChannel::BurstUnreliable));
}
```

The RPC is declared `UFUNCTION(NetMulticast, Unreliable)` — packets may be
dropped under congestion, which is acceptable for one-shot visual/audio
effects.

---

## 7. Client-Side Dispatch

```
Source  Private/Net/StatsX_NetCueRelay.cpp:317-337
```

```cpp
void AStatsX_NetCueRelay::DispatchCueOnClient(const FStatsXCosmeticCue& Cue)
{
    if (Cue.CueType == EStatsXCosmeticCueType::None) return;

    ExecuteBuiltInCue(Cue);                          // 1. Immediate effect
    OnClientCueReceivedNative.Broadcast(Cue);         // 2. Native delegate

    if (UStatsX_WorldSubsystem* Sub = ...)
        Sub->EnqueueCosmeticCue(Cue);                 // 3. Re-inject into bus
}
```

Three-stage dispatch:

| Stage | Purpose |
|---|---|
| `ExecuteBuiltInCue` | Play montage, spawn VFX/SFX, etc. (see §8) |
| `OnClientCueReceivedNative` | Native delegate for custom C++ consumers |
| `EnqueueCosmeticCue` | Re-inject into local bus for Blueprint/sink consumers |

---

## 8. Built-In Cue Execution

```
Source  Private/Net/StatsX_NetCueRelay.cpp:339-826
```

`ExecuteBuiltInCue` is the client-side mirror of what the opcode handlers do
on the server.  It handles every `EStatsXCosmeticCueType` and resolves
generic integer payload slots back into typed enums via local lambdas.

### 8.1 Transform Resolution Helpers

Defined as lambdas inside `ExecuteBuiltInCue`:

| Helper | Purpose |
|---|---|
| `ResolveTransformSpace(int32)` | Cast to `EStatsXVFXTransformSpace` with validation |
| `ResolvePoolPolicy(int32)` | Cast to `EStatsXVFXPoolPolicy` with validation |
| `ResolveSFXPlaybackPolicy(int32)` | Cast to `EStatsXSFXPlaybackPolicy` with validation |
| `ResolvePoolMethod(EStatsXVFXPoolPolicy)` | Map to `ENCPoolMethod` for Niagara |
| `ResolveAttachLocationType(EStatsXVFXAttachRule)` | Map to `EAttachLocation::Type` |
| `ResolveAttachedSpawnInputs(...)` | Compute location/rotation/scale based on attach rule |
| `ResolveWorldTransform(TransformSpace)` | Build world-space `FTransform` from cue payload, applying relative offsets for Target/Caster |

### 8.2 PlayMontage / StopMontage

```
Source  Private/Net/StatsX_NetCueRelay.cpp:469-529
```

**Actor resolution:**
1. Get `TargetActor` from cue.
2. If `ACharacter` → get `GetMesh()->GetAnimInstance()`.
3. Otherwise → find first `USkeletalMeshComponent` → `GetAnimInstance()`.

**PlayMontage:**
- `Montage_Play(Montage, PlayRate)` — `Float0` is play rate (default 1.0).
- If section name valid → `Montage_JumpToSection(SectionName)`.

**StopMontage:**
- `Float0` is blend-out time (default 0.25).
- If specific montage asset → `Montage_Stop(BlendOutTime, Montage)`.
- If no asset → `StopAllMontages(BlendOutTime)`.

### 8.3 SpawnVFX

```
Source  Private/Net/StatsX_NetCueRelay.cpp:531-570
```

1. Cast `Asset` to `UNiagaraSystem`.
2. Resolve transform space and pool policy from `Int0`/`Int1`.
3. Compute world-space transform via `ResolveWorldTransform`.
4. `UNiagaraFunctionLibrary::SpawnSystemAtLocation(...)`.
5. Register spawned component with subsystem VFX handle.

### 8.4 SpawnVFXAttached

```
Source  Private/Net/StatsX_NetCueRelay.cpp:572-648
```

1. Resolve parent actor: `ExplicitRouteActor → TargetActor → CasterActor`.
2. Resolve attachment component and socket via
   `NetCueRelayPrivate::ResolveActorAttachComponent`.
3. Resolve attach rule, pool policy, spawn transform.
4. `UNiagaraFunctionLibrary::SpawnSystemAttached(...)`.
5. Register spawned component with subsystem VFX handle.
6. `SpawnedComp->Activate()`.

#### Socket Resolution

```
Source  Private/Net/StatsX_NetCueRelay.cpp:101-159
```

`FindSocketSourceComponent` searches for a named socket in order:

1. `ACharacter::GetMesh()` → check socket.
2. First `USkeletalMeshComponent` → check socket.
3. All `USceneComponent` children → check socket.

`ResolveActorAttachComponent` wraps this with a fallback to root component
when no socket is specified.

### 8.5 StopVFX

```
Source  Private/Net/StatsX_NetCueRelay.cpp:650-681
```

1. Find component by handle via `FindLocalVFXComponent`.
2. `SetAutoDestroy(true)`.
3. Immediate deactivate if `Float0 ≤ ε`, otherwise graceful `Deactivate()`.
4. `UnregisterLocalVFXComponent`.

### 8.6 UpdateVFX

```
Source  Private/Net/StatsX_NetCueRelay.cpp:683-706
```

1. Find component by handle.
2. Resolve world transform from `Int0` (transform space) + cue position data.
3. `SetWorldLocationAndRotation` + `SetWorldScale3D`.

### 8.7 SpawnSFX

```
Source  Private/Net/StatsX_NetCueRelay.cpp:708-790
```

1. Cast `Asset` to `USoundBase`.
2. Resolve transform space and playback policy from `Int0`/`Int1`.
3. Normalize volume/pitch multipliers (guard against ≤ 0, NaN, default-mix).
4. **Persistent** → `SpawnSoundAtLocation` + register with SFX handle.
5. **FireAndForget** → `PlaySoundAtLocation` (no component tracking).

### 8.8 StopSFX

```
Source  Private/Net/StatsX_NetCueRelay.cpp:792-821
```

1. Find audio component by handle.
2. Immediate `Stop()` if `Float0 ≤ ε`, otherwise `FadeOut(FadeOutTime, 0.f)`.
3. `UnregisterLocalSFXComponent`.

---

## 9. Relay Lifecycle Management

### 9.1 HandleCosmeticCueRoutedForNetwork

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:777-808
```

Registered as a sink during `Initialize()` on authority machines:

1. Validate net mode is `DedicatedServer` or `ListenServer`.
2. Validate `CueType != None`.
3. `GetOrCreateNetCueRelay(RouteActor)` — attempt route-actor relay.
4. If null and route actor was valid → **fallback to global relay** via
   `GetOrCreateNetCueRelay(nullptr)`.
5. `Relay->PushCueFromServer(Cue)`.

### 9.2 GetOrCreateNetCueRelay

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:810-900
```

**Stale cleanup** — on every call, iterate `RouteActorNetCueRelays` and
remove entries where either the actor or the relay weak pointer is invalid,
destroying the relay actor.

**Global relay path** (route actor null or not replicated):

1. Return existing `GlobalNetCueRelay` if valid.
2. Otherwise spawn new `AStatsX_NetCueRelay`:
   - `RF_Transient` object flags.
   - Unique name `StatsX_GlobalNetCueRelay`.
   - Identity transform.
   - `ConfigureAsGlobalRelay()`.

**Route-actor relay path** (valid, replicated route actor):

1. Return existing relay from `RouteActorNetCueRelays` cache if valid.
2. If cache full (`≥ MaxRouteNetCueRelays`, default 4096) → fallback to
   global relay.
3. Otherwise spawn new `AStatsX_NetCueRelay`:
   - `RF_Transient` object flags.
   - Unique name `StatsX_RouteNetCueRelay`.
   - Spawned at route actor's transform.
   - `ConfigureForRouteActor(RouteActor)`.
   - Cached in `RouteActorNetCueRelays`.

### 9.3 DestroyNetCueRelays

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:902-918
```

Called during `Deinitialize`:

1. Destroy `GlobalNetCueRelay` if valid, reset pointer.
2. Iterate `RouteActorNetCueRelays`, destroy each relay, reset map.

---

## 10. Relevancy Model

The relay leverages UE5's built-in actor relevancy system — no custom
`IsNetRelevantFor` override:

| Relay type | `bAlwaysRelevant` | `bNetUseOwnerRelevancy` | Owner | Effect |
|---|---|---|---|---|
| Route-actor | `false` | `true` | Route actor | Relay is relevant whenever the route actor is relevant to a client |
| Global | `true` | `false` | `nullptr` | Relay is always relevant to all clients |

This means a character's cosmetic cues are automatically scoped to clients
that can see the character, without any explicit per-client filtering logic.

---

## 11. Capacity Limits

| Limit | Default | Purpose |
|---|---|---|
| `MaxStateCueEntries` | 96 | Per-relay cap for state cue items; oldest evicted on overflow |
| `MaxRouteNetCueRelays` | 4096 | World-wide cap on route-actor relays; excess routed to global |
| `NetUpdateFrequency` | 30 Hz | Target replication rate |
| `MinNetUpdateFrequency` | 10 Hz | Minimum replication rate under load |

---

## 12. StopMontage Production

```
Source  Private/Nodes/Nodes_Core.cpp:201-268
```

StopMontage cues are not produced by a dedicated opcode but by the
`UForge_MontageCallbackHelper::Cleanup(bool bStopMontage)` path.  When a
status instance ends or the montage completes:

1. Helper constructs `FStatsXCosmeticCue` with:
   - `CueType = StopMontage`, `Channel = StateReliable`,
     `RoutePolicy = TargetActor`.
   - `Asset` = the playing montage.
   - `Float0` = 0.15 (blend-out time).
   - `Key` = original StatusID + NodePC from the PlayMontage cue.
2. `EnqueueCosmeticCue(Cue)` — enters the same bus pipeline.

Because the StopMontage cue shares the same `StatusID + NodePC + CueType`
stream key as the original PlayMontage, the state dedup system on both the
bus (§7 of doc 17) and the relay (§5.3) correctly overwrites the "playing"
state with the "stopped" state.

---

## 13. Performance Instrumentation

Every critical path is wrapped with `STATSX_NETCUE_SCOPE`:

| Scope name | Where |
|---|---|
| `StatsX.NetCue.Enqueue` | `EnqueueCosmeticCue` |
| `StatsX.NetCue.FlushBus` | `FlushCosmeticCueBus` |
| `StatsX.NetCue.RouteToNetwork` | `HandleCosmeticCueRoutedForNetwork` |
| `StatsX.NetCue.GetOrCreateRelay` | `GetOrCreateNetCueRelay` |
| `StatsX.NetCue.PushFromServer` | `PushCueFromServer` |
| `StatsX.NetCue.BurstReceive` | `MulticastBurstCue_Implementation` |
| `StatsX.NetCue.StateReceive` | `HandleReplicatedStateCue` |
| `StatsX.NetCue.DispatchClient` | `DispatchCueOnClient` |
| `StatsX.NetCue.ExecuteBuiltIn.*` | Per-type execution (Montage, VFX, SFX) |
| `StatsX.NetCue.RebuildStateIndex` | `RebuildStateCueIndex` |

---

## 14. Design Decisions

| Decision | Rationale |
|---|---|
| **AInfo subclass** | Lightweight — no transform, collision, or rendering overhead |
| **Owner-based relevancy** | Automatically scopes cues to clients that can see the associated actor |
| **FastArraySerializer for state cues** | Delta-compressed, join-in-progress safe — new clients receive current state |
| **Unreliable multicast for bursts** | Minimal bandwidth; acceptable loss for one-shot effects |
| **Separate relay per route actor** | Each relay inherits relevancy independently; destroyed actors auto-cleanup |
| **Global relay as fallback** | Guarantees all cues reach clients even when no route actor exists |
| **96-entry state cap** | Prevents unbounded memory growth on long-running sessions |
| **4096 relay cap** | Prevents relay actor explosion in large-world scenarios |
| **Re-enqueue on client** | Client-side sinks (custom consumers) get the same cue flow as server-side |
| **Lambda helpers inside ExecuteBuiltInCue** | Zero-overhead enum resolution with validation — no map lookups |

---

## 15. See Also

| Document | Relationship |
|---|---|
| [17 — Cosmetic Cue System](17_Cosmetic_Cue_System.md) | Local bus that feeds cues to the routing layer |
| [19 — VFX / SFX Handles](19_VFX_SFX_Handles.md) | Handle allocation and component tracking |
| [20 — Replication](20_Replication.md) | Gameplay state replication (separate from cosmetic) |
| [21 — Network Cue Relay](21_Network_Cue_Relay.md) | Additional relay configuration and diagnostics |
