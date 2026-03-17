# 17 — Cosmetic Cue System

> **Stats_X v1.404 — Unreal Engine 5.7**
> Layer: **Presentation** — fire-and-forget visual/audio notifications decoupled from gameplay state.

---

## 1. Purpose

The Cosmetic Cue System provides a **one-way bus** for gameplay logic (ForgeVM
opcode handlers) to emit visual and audio effects (montages, VFX, SFX) without
coupling the execution layer to presentation concerns.
Cues are **envelopes** — self-contained packets carrying asset references,
transform data, and metadata — routed through a subsystem bus to registered
**sinks** (local playback, network relay, custom consumers).

Key design goals:

| Goal | Mechanism |
|---|---|
| Gameplay ↔ cosmetic decoupling | Opcode handlers emit cues; sinks consume them independently |
| Network-ready transport | State-reliable and burst-unreliable channels |
| Stream deduplication | `FStatsXCosmeticCueStreamKey` — latest-value-wins for stateful cues |
| Lifetime management | Monotonic VFX/SFX handles for stop/update after spawn |
| Zero-allocation fast path | Pending queue pre-reserved (128 cues, 64 dedup entries) |

---

## 2. Data Structures

### 2.1 EStatsXCosmeticCueType

```
Source  Public/Data/StatsXCosmeticCueTypes.h:12-24
```

Semantic identifier for cue content:

| Value | Meaning |
|---|---|
| `None` (0) | Invalid — rejected by bus |
| `PlayMontage` | Play an animation montage |
| `StopMontage` | Stop a playing montage |
| `SpawnVFX` | Spawn a Niagara system at location |
| `StopVFX` | Deactivate a spawned VFX by handle |
| `UpdateVFX` | Update transform of a spawned VFX |
| `Custom` | User-defined cue (routed but not auto-executed) |
| `SpawnSFX` | Play a sound at location |
| `StopSFX` | Stop a playing sound by handle |
| `SpawnVFXAttached` | Spawn a Niagara system attached to an actor/socket |

### 2.2 EStatsXCosmeticCueChannel

```
Source  Public/Data/StatsXCosmeticCueTypes.h:27-34
```

| Value | Behaviour |
|---|---|
| `StateReliable` (0) | Stateful — latest value wins per stream. Used for persistent cues (montage start/stop, VFX lifecycle). |
| `BurstUnreliable` | Fire-and-forget — every cue dispatched independently. Used for one-shot bursts (hit VFX, impacts). |

### 2.3 EStatsXCosmeticCueRoutePolicy

```
Source  Public/Data/StatsXCosmeticCueTypes.h:37-53
```

Determines which actor receives routing affinity:

| Value | Resolution |
|---|---|
| `Auto` (0) | `ExplicitRouteActor → TargetActor → CasterActor → nullptr` (cascade fallback) |
| `TargetActor` | `Cue.TargetActor` |
| `CasterActor` | `Cue.CasterActor` |
| `ExplicitActor` | `Cue.ExplicitRouteActor` |
| `Global` | `nullptr` (no actor affinity — global relay) |

### 2.4 FStatsXCosmeticCueKey

```
Source  Public/Data/StatsXCosmeticCueTypes.h:56-66
```

Stable identity for deduplication and ordering:

| Field | Type | Purpose |
|---|---|---|
| `StatusID` | `int64` | Owning status execution identifier |
| `NodePC` | `int32` | Instruction index that produced this cue (`INDEX_NONE` when unknown) |
| `Sequence` | `uint16` | Monotonic sequence (0 = auto-assign by bus) |

### 2.5 FStatsXCosmeticCue

```
Source  Public/Data/StatsXCosmeticCueTypes.h:69-118
```

The **envelope** transported by the cosmetic cue bus.  All fields are
value-types or weak pointers — no GC pressure from pending cues.

| Field | Type | Purpose |
|---|---|---|
| `CueType` | `EStatsXCosmeticCueType` | Semantic type |
| `Channel` | `EStatsXCosmeticCueChannel` | Transport intent |
| `RoutePolicy` | `EStatsXCosmeticCueRoutePolicy` | Route selection |
| `Key` | `FStatsXCosmeticCueKey` | Identity (StatusID + NodePC + Sequence) |
| `CasterActor` | `TWeakObjectPtr<AActor>` | VM execution caster |
| `TargetActor` | `TWeakObjectPtr<AActor>` | VM execution target |
| `ExplicitRouteActor` | `TWeakObjectPtr<AActor>` | Optional routing override |
| `ServerWorldTimeSeconds` | `float` | Emission timestamp (auto-filled if ≤ 0) |
| `CueName` | `FName` | Optional identifier for custom routers |
| `Asset` | `TWeakObjectPtr<UObject>` | Primary asset (montage, Niagara system, sound) |
| `SecondaryAsset` | `TWeakObjectPtr<UObject>` | Secondary asset slot |
| `Location` | `FVector` | Transform position |
| `Rotation` | `FRotator` | Transform rotation |
| `Scale` | `FVector` | Transform scale (default 1,1,1) |
| `SectionName` | `FName` | Montage section name / socket name |
| `Float0..Float3` | `float` | Numeric payload slots (play rate, volume, blend time, etc.) |
| `Int0, Int1` | `int32` | Integer payload slots (transform space, pool policy, etc.) |
| `Int64_0` | `int64` | VFX/SFX handle |
| `Flags` | `uint8` | Bitfield (e.g. bit 0 = bStopOnStatusEnds) |

Helper: `IsStateCue()` returns `true` when `Channel == StateReliable`.

### 2.6 FStatsXCosmeticCueStreamKey

```
Source  Public/Data/StatsXCosmeticCueTypes.h:121-150
```

Hash key for state-channel deduplication.  Two cues belong to the same
**stream** when they share `StatusID + NodePC + CueType`:

```cpp
struct FStatsXCosmeticCueStreamKey
{
    int64  StatusID;
    int32  NodePC;
    uint8  CueType;
};
```

`GetTypeHash` uses `HashCombineFast` for O(1) lookup in `PendingStateCueIndices`.

---

## 3. Cue Bus Architecture

The bus lives entirely inside `UStatsX_WorldSubsystem` and follows a
**produce → batch → flush** pipeline per tick.

```
 ForgeVM opcode handlers
        │
        ▼
 EnqueueCosmeticCue()          ◄── Produce: fill pending queue
        │
        ▼
 ┌─────────────────────┐
 │  PendingCosmeticCues │       ◄── Batch: TArray<FStatsXCosmeticCue>
 │  PendingStateCueIdx  │           State dedup: TMap<StreamKey, int32>
 └─────────────────────┘
        │
        ▼  (end of Tick)
 FlushCosmeticCueBus()         ◄── Flush: resolve route actor, broadcast
        │
        ▼
 OnCosmeticCueRoutedNative     ◄── Multicast delegate (Cue, RouteActor)
   ├── Network sink (server)   → HandleCosmeticCueRoutedForNetwork
   └── Custom sinks             → user-registered delegates
```

### 3.1 Tick Integration

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:462-469
```

```cpp
void UStatsX_WorldSubsystem::Tick(float DeltaTime)
{
    TickInstances(DeltaTime);
    FlushPendingStatusUpdates();
    FlushCosmeticCueBus();           // ← last phase
}
```

Cues are flushed **after** gameplay execution completes, ensuring all opcodes
within the current frame have had the chance to enqueue their cues before
dispatch.

---

## 4. Subsystem API

### 4.1 EnqueueCosmeticCue

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:480-529
```

```cpp
bool EnqueueCosmeticCue(const FStatsXCosmeticCue& Cue);
```

**Flow:**

1. **Validate** — reject `CueType::None` (returns `false`).
2. **Auto-assign sequence** — if `Key.Sequence == 0`, allocate via monotonic
   counter (`NextCosmeticCueSequence`, wraps at 65535 skipping 0).
3. **Auto-assign timestamp** — if `ServerWorldTimeSeconds ≤ 0`, set to
   `World->GetTimeSeconds()`.
4. **State dedup** — if `IsStateCue()`:
   - Build `FStatsXCosmeticCueStreamKey` from the cue.
   - If stream already has a pending entry → **overwrite in-place** (latest
     value wins).
   - Otherwise → append and record index in `PendingStateCueIndices`.
5. **Burst** — append directly to `PendingCosmeticCues`.

### 4.2 EnqueueCosmeticCueBatch

```cpp
int32 EnqueueCosmeticCueBatch(const TArray<FStatsXCosmeticCue>& Cues);
```

Iterates and delegates to `EnqueueCosmeticCue` for each cue.  Returns
accepted count.

### 4.3 FlushCosmeticCueBus

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:545-571
```

```cpp
int32 FlushCosmeticCueBus();
```

1. Early-out if queue is empty.
2. If **no sinks bound** → silently discard (avoids dead-letter accumulation).
3. For each pending cue:
   - Resolve route actor via `ResolveCosmeticCueRouteActor`.
   - `OnCosmeticCueRoutedNative.Broadcast(Cue, RouteActor)`.
4. Reset `PendingCosmeticCues` and `PendingStateCueIndices`.
5. Return dispatch count.

### 4.4 ResolveCosmeticCueRouteActor

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:591-623
```

Switch on `RoutePolicy`:

| Policy | Returns |
|---|---|
| `TargetActor` | `Cue.TargetActor.Get()` |
| `CasterActor` | `Cue.CasterActor.Get()` |
| `ExplicitActor` | `Cue.ExplicitRouteActor.Get()` |
| `Global` | `nullptr` |
| `Auto` (default) | First valid of: Explicit → Target → Caster → `nullptr` |

### 4.5 Sink Registration

```cpp
FDelegateHandle RegisterCosmeticCueSink(const FOnStatsXCosmeticCueRoutedNative::FDelegate& Delegate);
void UnregisterCosmeticCueSink(FDelegateHandle Handle);
void UnregisterCosmeticCueSinksForObject(const void* InUserObject);
```

The delegate signature is:

```cpp
DECLARE_MULTICAST_DELEGATE_TwoParams(
    FOnStatsXCosmeticCueRoutedNative,
    const FStatsXCosmeticCue& /*Cue*/,
    AActor* /*RouteActor*/);
```

Any number of sinks may bind.  The server-side network sink is auto-registered
during `Initialize()` on Dedicated/Listen servers.

---

## 5. Opcode Handlers — Cue Producers

Each cosmetic opcode constructs an `FStatsXCosmeticCue`, fills type-specific
payload fields, and calls `Subsystem->EnqueueCosmeticCue(Cue)`.

### 5.1 OP_PlayMontage (321)

```
Source  Private/Nodes/Nodes_Core.cpp:2639-3173
Handler: Nodes_Flow::PlayMontage
```

| Envelope field | Value |
|---|---|
| `CueType` | `PlayMontage` |
| `Channel` | `StateReliable` |
| `RoutePolicy` | `TargetActor` |
| `Asset` | `UAnimMontage*` |
| `Float0` | Play rate |
| `SectionName` | Starting section name |
| `Flags` | Bit 0 = `bStopOnStatusEnds` |
| `Location / Rotation` | Target actor transform |

### 5.2 OP_SpawnVFX (327)

```
Source  Private/Nodes/Nodes_Core.cpp:5207-5449
Handler: Nodes_Action::SpawnVFX
```

| Envelope field | Value |
|---|---|
| `CueType` | `SpawnVFX` |
| `Channel` | Per `EStatsXVFXNetDelivery` (State or Burst) |
| `RoutePolicy` | Per `EStatsXVFXTransformSpace` (Target, Caster, or Auto) |
| `Asset` | `UNiagaraSystem*` |
| `Location / Rotation / Scale` | Input transform |
| `Int0` | `TransformSpace` (cast to int32) |
| `Int1` | `PoolPolicy` (cast to int32) |
| `Int64_0` | Allocated VFX handle (`AllocateCosmeticVFXHandle()`) |

After enqueue, the local handler also calls
`RegisterLocalVFXComponent(Handle, SpawnedComp)` for immediate local playback.

### 5.3 OP_SpawnVFXAttachedtoActor (390)

```
Source  Private/Nodes/Nodes_Core.cpp:5466-5630
Handler: Nodes_Action::SpawnVFXAttachedtoActor
```

| Envelope field | Value |
|---|---|
| `CueType` | `SpawnVFXAttached` |
| `Channel` | Per `EStatsXVFXNetDelivery` |
| `RoutePolicy` | `ExplicitActor` |
| `Asset` | `UNiagaraSystem*` |
| `SectionName` | Socket name for attachment |
| `Int0` | `AttachRule` (cast to int32) |
| `Int1` | `PoolPolicy` (cast to int32) |
| `Int64_0` | Allocated VFX handle |

### 5.4 OP_SpawnSFX (337)

```
Source  Private/Nodes/Nodes_Core.cpp:5648-5926
Handler: Nodes_Action::SpawnSFX
```

| Envelope field | Value |
|---|---|
| `CueType` | `SpawnSFX` |
| `Channel` | Per `EStatsXVFXNetDelivery` |
| `RoutePolicy` | Per `EStatsXVFXTransformSpace` |
| `Asset` | `USoundBase*` |
| `Float0` | Volume multiplier |
| `Float1` | Pitch multiplier |
| `Float2` | Start time |
| `Int0` | `TransformSpace` (cast to int32) |
| `Int1` | `PlaybackPolicy` (cast to int32) |
| `Int64_0` | Allocated SFX handle (`AllocateCosmeticSFXHandle()`) |

### 5.5 OP_StopVFX (335)

```
Source  Private/Nodes/Nodes_Core.cpp:6016-6085
Handler: Nodes_Action::StopVFX
```

| Envelope field | Value |
|---|---|
| `CueType` | `StopVFX` |
| `Channel` | `StateReliable` (stop is state-transition) |
| `RoutePolicy` | `Auto` |
| `Float0` | Blend-out time |
| `Int64_0` | VFX handle to stop |

Locally calls `UnregisterLocalVFXComponent(Handle)` before enqueue.

### 5.6 OP_UpdateVFX (336)

```
Source  Private/Nodes/Nodes_Core.cpp:6097-6212
Handler: Nodes_Action::UpdateVFX
```

| Envelope field | Value |
|---|---|
| `CueType` | `UpdateVFX` |
| `Channel` | Per `EStatsXVFXNetDelivery` |
| `RoutePolicy` | Per `EStatsXVFXTransformSpace` |
| `Location / Rotation / Scale` | New transform |
| `Int0` | `TransformSpace` (cast to int32) |
| `Int64_0` | VFX handle to update |

### 5.7 OP_StopSFX (338)

```
Source  Private/Nodes/Nodes_Core.cpp:5937-6005
Handler: Nodes_Action::StopSFX
```

| Envelope field | Value |
|---|---|
| `CueType` | `StopSFX` |
| `Channel` | Per `EStatsXVFXNetDelivery` |
| `RoutePolicy` | `Auto` |
| `Float0` | Fade-out time |
| `Int64_0` | SFX handle to stop |

Locally calls `UnregisterLocalSFXComponent(Handle)` before enqueue.

---

## 6. Local Handle Registries

The subsystem maintains two parallel registries that let Stop/Update opcodes
reference components spawned by earlier Spawn opcodes within the same frame
or across frames.

### 6.1 VFX Handle Registry

```
Source  Public/Core/StatsX_WorldSubsystem.h:305-318
       Private/Core/StatsX_WorldSubsystem.cpp:641-701
```

| API | Purpose |
|---|---|
| `AllocateCosmeticVFXHandle() → int64` | Monotonic allocator (1..max, skip 0) |
| `RegisterLocalVFXComponent(Handle, UNiagaraComponent*)` | Map handle → component. Stale-entry cleanup at 2048 threshold. |
| `FindLocalVFXComponent(Handle) → UNiagaraComponent*` | Lookup (returns `nullptr` if stale/missing) |
| `UnregisterLocalVFXComponent(Handle)` | Remove mapping |

Storage: `TMap<int64, TWeakObjectPtr<UNiagaraComponent>> LocalVFXByHandle`

### 6.2 SFX Handle Registry

```
Source  Public/Core/StatsX_WorldSubsystem.h:320-334
       Private/Core/StatsX_WorldSubsystem.cpp:703-754
```

Identical pattern:

| API | Purpose |
|---|---|
| `AllocateCosmeticSFXHandle() → int64` | Monotonic allocator (1..max, skip 0) |
| `RegisterLocalSFXComponent(Handle, UAudioComponent*)` | Map handle → component |
| `FindLocalSFXComponent(Handle) → UAudioComponent*` | Lookup |
| `UnregisterLocalSFXComponent(Handle)` | Remove mapping |

Storage: `TMap<int64, TWeakObjectPtr<UAudioComponent>> LocalSFXByHandle`

Both registries use **weak object pointers** — no GC root, components can be
garbage-collected if their owning actor is destroyed.

---

## 7. State Deduplication

State-reliable cues (montage start/stop, VFX lifecycle) use the
`PendingStateCueIndices` map to ensure only the **latest value per stream**
survives each flush cycle.

**Stream identity** = `StatusID + NodePC + CueType` (see §2.6).

```
Frame N:  SpawnVFX(StatusID=42, PC=7)  →  queued at index 0
          UpdateVFX(StatusID=42, PC=7) →  different CueType → queued at index 1
          SpawnVFX(StatusID=42, PC=7)  →  same stream → overwrites index 0
```

Burst-unreliable cues bypass dedup entirely — every cue is dispatched.

---

## 8. Sequence Allocation

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:625-639
```

The bus assigns a globally-monotonic `uint16` sequence number to every cue
whose `Key.Sequence` arrives as 0 (the default).  The allocator wraps at
65535 and skips 0 to keep the sentinel value available:

```cpp
uint16 Sequence = NextCosmeticCueSequence++;
if (Sequence == 0)
{
    Sequence = NextCosmeticCueSequence++;
    // … double-skip guard …
}
```

Sequence numbers provide **total ordering** within a flush batch and across
network transports for receivers that need to replay cues in emission order.

---

## 9. Initialization and Teardown

### 9.1 Initialize

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:342-400
```

1. Pre-reserve pending queues: `PendingCosmeticCues.Reserve(128)`,
   `PendingStateCueIndices.Reserve(64)`.
2. Reset monotonic counters: `NextCosmeticCueSequence = 1`,
   `NextCosmeticVFXHandle = 1`, `NextCosmeticSFXHandle = 1`.
3. Reserve handle registries: `LocalVFXByHandle.Reserve(128)`,
   `LocalSFXByHandle.Reserve(128)`.
4. **Server auto-registration** — on `DedicatedServer` or `ListenServer`,
   register a network sink via lambda:

```cpp
CosmeticCueNetworkSinkHandle = RegisterCosmeticCueSink(
    FOnStatsXCosmeticCueRoutedNative::FDelegate::CreateLambda(
        [WeakSelf](const FStatsXCosmeticCue& Cue, AActor* RouteActor)
        {
            if (auto* Self = WeakSelf.Get())
                Self->HandleCosmeticCueRoutedForNetwork(Cue, RouteActor);
        }));
```

This ensures every flushed cue is automatically forwarded to the network
relay system on authority machines.

### 9.2 Deinitialize

```
Source  Private/Core/StatsX_WorldSubsystem.cpp:410-436
```

1. Unregister network sink.
2. `DestroyNetCueRelays()` — destroy all spawned relay actors.
3. Reset all queues, maps, counters.
4. `OnCosmeticCueRoutedNative.Clear()` — unbind all sinks.

---

## 10. Supporting Enums

The following enums parameterize VFX/SFX opcode behaviour and are packed into
the cue's integer payload slots.

### 10.1 EStatsXVFXTransformSpace

```
Source  Public/Data/StatsXTypes.h:166-176
```

| Value | Meaning |
|---|---|
| `World` | Absolute world-space transform |
| `TargetRelative` | Relative to target actor |
| `CasterRelative` | Relative to caster actor |

### 10.2 EStatsXVFXAttachRule

```
Source  Public/Data/StatsXTypes.h:180-193
```

| Value | Meaning |
|---|---|
| `KeepRelativeOffset` | Maintain local offset from parent |
| `KeepWorldTransform` | Snap to world position, follow parent |
| `SnapToTargetIncludingScale` | Full snap including scale |
| `SnapToTargetNotIncludingScale` | Snap position/rotation only |

### 10.3 EStatsXVFXNetDelivery

```
Source  Public/Data/StatsXTypes.h:197-207
```

| Value | Meaning |
|---|---|
| `Auto` | Engine decides based on cue type |
| `BurstUnreliable` | One-shot unreliable multicast |
| `StateReliable` | Stateful reliable replication |

### 10.4 EStatsXSFXPlaybackPolicy

```
Source  Public/Data/StatsXTypes.h:211-221
```

| Value | Meaning |
|---|---|
| `Auto` | Engine decides (short sounds → fire-and-forget, looping → persistent) |
| `FireAndForget` | No component tracked — `PlaySoundAtLocation` |
| `Persistent` | `SpawnSoundAtLocation` — component registered for stop/fade |

### 10.5 EStatsXVFXPoolPolicy

```
Source  Public/Data/StatsXTypes.h:225-238
```

| Value | Meaning |
|---|---|
| `Auto` | Engine default pooling |
| `None` | No pooling (always create/destroy) |
| `AutoRelease` | Return to pool when deactivated |
| `ManualRelease` | Caller must explicitly release |

---

## 11. Subsystem Private Storage

```
Source  Public/Core/StatsX_WorldSubsystem.h:610-644
```

| Field | Type | Purpose |
|---|---|---|
| `PendingCosmeticCues` | `TArray<FStatsXCosmeticCue>` | Pre-flush queue |
| `PendingStateCueIndices` | `TMap<StreamKey, int32>` | State-channel dedup index |
| `NextCosmeticCueSequence` | `uint16` | Monotonic sequence allocator |
| `NextCosmeticVFXHandle` | `int64` | VFX handle allocator |
| `LocalVFXByHandle` | `TMap<int64, TWeakObjectPtr<UNiagaraComponent>>` | VFX handle → component |
| `NextCosmeticSFXHandle` | `int64` | SFX handle allocator |
| `LocalSFXByHandle` | `TMap<int64, TWeakObjectPtr<UAudioComponent>>` | SFX handle → component |
| `OnCosmeticCueRoutedNative` | `FOnStatsXCosmeticCueRoutedNative` | Multicast sink delegate |
| `CosmeticCueNetworkSinkHandle` | `FDelegateHandle` | Server network sink handle |
| `GlobalNetCueRelay` | `TWeakObjectPtr<AStatsX_NetCueRelay>` | Global fallback relay actor |
| `RouteActorNetCueRelays` | `TMap<TWeakObjectPtr<AActor>, TWeakObjectPtr<AStatsX_NetCueRelay>>` | Per-actor relay cache |
| `MaxRouteNetCueRelays` | `int32` (4096) | Hard cap for relay instances |

---

## 12. Handler Registration

```
Source  Private/Nodes/Nodes_Core.cpp:9737-9778
```

```cpp
Registry.RegisterHandler(ForgeOpCodes::OP_PlayMontage,              &Nodes_Flow::PlayMontage);
Registry.RegisterHandler(ForgeOpCodes::OP_SpawnVFX,                 &Nodes_Action::SpawnVFX);
Registry.RegisterHandler(ForgeOpCodes::OP_SpawnVFXAttachedtoActor,  &Nodes_Action::SpawnVFXAttachedtoActor);
Registry.RegisterHandler(ForgeOpCodes::OP_SpawnSFX,                 &Nodes_Action::SpawnSFX);
Registry.RegisterHandler(ForgeOpCodes::OP_StopSFX,                  &Nodes_Action::StopSFX);
Registry.RegisterHandler(ForgeOpCodes::OP_StopVFX,                  &Nodes_Action::StopVFX);
Registry.RegisterHandler(ForgeOpCodes::OP_UpdateVFX,                &Nodes_Action::UpdateVFX);
```

All seven handlers follow the same pattern:
`decode instruction → build FStatsXCosmeticCue → local execution → EnqueueCosmeticCue`.

---

## 13. Design Decisions

| Decision | Rationale |
|---|---|
| **Weak pointers for actors/assets** | Cues may persist across frames in pending queues — no stale strong references |
| **Generic payload slots** (Float0-3, Int0-1, Int64_0) | Avoid per-type envelope structs; keeps the bus homogeneous and serialisation-friendly |
| **Separate handle registries** | VFX and SFX have independent lifecycles and component types |
| **State dedup at enqueue, not flush** | Overwrites happen in O(1) via map lookup rather than scanning at flush time |
| **Bus flushed last in Tick** | All gameplay operations within the frame settle before cosmetics are dispatched |
| **128/64 pre-reserve** | Eliminates reallocation for typical frame budgets while avoiding over-allocation |
| **Network sink as first-class delegate** | Server transport is just another sink — no special dispatch path |

---

## 14. See Also

| Document | Relationship |
|---|---|
| [18 — Cosmetic Cue Routing](18_Cosmetic_Cue_Routing.md) | Network relay transport via `AStatsX_NetCueRelay` |
| [19 — VFX / SFX Handles](19_VFX_SFX_Handles.md) | Handle allocation, lookup, and lifetime management |
| [07 — ForgeVM](07_ForgeVM.md) | Opcode dispatch that produces cues |
| [20 — Replication](20_Replication.md) | Split replication model (gameplay + cosmetic) |
