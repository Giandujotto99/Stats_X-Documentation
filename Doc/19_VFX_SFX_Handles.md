# 19 — VFX / SFX Handles

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Overview

Stats_X manages spawned Niagara particle systems and persistent audio components through a **handle-based registry** hosted on `UStatsX_WorldSubsystem`. Every VFX or SFX spawned by the ForgeVM receives a monotonically increasing `int64` handle. The subsystem maps that handle to a `TWeakObjectPtr` of the spawned component, enabling later operations — update, stop, or destroy — to locate the component by handle alone, even across the network.

The handle layer sits between the ForgeVM opcode handlers and the Cosmetic Cue bus, ensuring that:

1. The server can reference effects by handle in cosmetic cues without holding a UObject pointer.
2. Clients can independently spawn and track their own component instances.
3. Stale entries are lazily purged so the registries stay bounded.

---

## Handle Allocation

Both VFX and SFX use independent monotonic `int64` allocators. Handle `0` is reserved as the invalid sentinel; all API entry points early-return on `Handle <= 0`.

| Property | VFX | SFX |
|---|---|---|
| Allocator field | `NextCosmeticVFXHandle` | `NextCosmeticSFXHandle` |
| Initial value | `1` | `1` |
| Storage map | `TMap<int64, TWeakObjectPtr<UNiagaraComponent>>` | `TMap<int64, TWeakObjectPtr<UAudioComponent>>` |
| Initial map capacity | 128 | 128 |
| Stale cleanup threshold | 2048 entries | 2048 entries |

**Wraparound safety.** On the astronomically unlikely overflow to `<= 0`, the allocator resets to `1`:

```cpp
int64 Handle = NextCosmeticVFXHandle++;
if (Handle <= 0)
{
    Handle = 1;
    NextCosmeticVFXHandle = 2;
}
```

---

## VFX Handle Registry API

All methods live on `UStatsX_WorldSubsystem`.

### AllocateCosmeticVFXHandle

```
int64 AllocateCosmeticVFXHandle()
```

Returns the next monotonic VFX handle. Thread-safe only within game-thread tick.

### RegisterLocalVFXComponent

```
void RegisterLocalVFXComponent(int64 VFXHandle, UNiagaraComponent* Component)
```

Maps a handle to its spawned Niagara component. If `Component` is invalid, the entry is removed instead (defensive cleanup). When the map exceeds **2048 entries**, a stale-sweep pass iterates all entries and removes those whose weak pointer is no longer valid.

### FindLocalVFXComponent

```
UNiagaraComponent* FindLocalVFXComponent(int64 VFXHandle)
```

Returns the component for the given handle, or `nullptr`. If the weak pointer has gone stale, the entry is lazily removed on access.

### UnregisterLocalVFXComponent

```
void UnregisterLocalVFXComponent(int64 VFXHandle)
```

Removes the handle from the map unconditionally.

---

## SFX Handle Registry API

The SFX registry is structurally identical to the VFX registry, substituting `UAudioComponent` for `UNiagaraComponent`.

| Method | Signature |
|---|---|
| `AllocateCosmeticSFXHandle` | `int64 AllocateCosmeticSFXHandle()` |
| `RegisterLocalSFXComponent` | `void RegisterLocalSFXComponent(int64 SFXHandle, UAudioComponent* Component)` |
| `FindLocalSFXComponent` | `UAudioComponent* FindLocalSFXComponent(int64 SFXHandle)` |
| `UnregisterLocalSFXComponent` | `void UnregisterLocalSFXComponent(int64 SFXHandle)` |

Same stale-cleanup threshold of **2048** applies.

> **Note:** SFX handles are only allocated when `EStatsXSFXPlaybackPolicy == Persistent`. Fire-and-forget sounds receive handle `0` and are not tracked.

---

## ForgeVM Opcode Handlers

Six opcodes interact with the handle registries. All are registered in `Nodes_Core.cpp` via `RegisterCoreNodes`.

### OP_SpawnVFX (327)

Spawns a Niagara system at a world location.

**Instruction fields:**

| Field | Source | Type |
|---|---|---|
| VFX System | Data0[24-41] | `UNiagaraSystem*` |
| Transform | Data0[42-59] | `FTransform` |
| Transform Space | Data1[0-17] | `EStatsXVFXTransformSpace` |
| Net Delivery | Data1[18-35] | `EStatsXVFXNetDelivery` |
| VFX Handle output | Data1[36-51] | output offset (uint16) |
| Pool Policy | Continuation Data0[0-17] | `EStatsXVFXPoolPolicy` |

**Execution flow:**

1. Read VFX system, transform, space, delivery, and pool policy from instruction.
2. Resolve world transform based on `EStatsXVFXTransformSpace` (World / TargetRelative / CasterRelative).
3. Allocate VFX handle via `AllocateCosmeticVFXHandle()`.
4. On authority: emit `SpawnVFX` cosmetic cue carrying the handle, asset, transform, and policies.
5. Spawn locally via `UNiagaraFunctionLibrary::SpawnSystemAtLocation()` (skipped on dedicated server).
6. Register component with `RegisterLocalVFXComponent(Handle, Component)`.
7. Write handle to output pool offset.

### OP_SpawnVFXAttachedtoActor (390)

Spawns a Niagara system attached to an actor socket.

**Additional instruction fields:**

| Field | Source | Type |
|---|---|---|
| Parent Actor | Data0[42-59] | `AActor*` |
| Socket Name | Data1[0-17] | `FName` |
| Attach Rule | Data1[36-53] | `EStatsXVFXAttachRule` |
| Net Delivery | Continuation Data0[0-17] | `EStatsXVFXNetDelivery` |
| Pool Policy | Continuation Data0[18-35] | `EStatsXVFXPoolPolicy` |
| VFX Handle output | Continuation Data0[36-51] | output offset (uint16) |

**Execution flow:**

1. Resolve attach component from parent actor's root or named socket.
2. Map `EStatsXVFXAttachRule` to `EAttachLocation` for Niagara.
3. Emit cosmetic cue with `ExplicitRouteActor` set to the parent actor.
4. Spawn via `UNiagaraFunctionLibrary::SpawnSystemAttached()`.
5. Register and write handle.

**Socket fallback:** If the named socket is not found, the handler logs a warning and falls back to the root component.

### OP_StopVFX (335)

Stops and deactivates a previously spawned Niagara system.

**Instruction fields:**

| Field | Source | Type |
|---|---|---|
| VFX Handle | Data0[24-41] | `int64` |
| Blend Out Time | Data0[42-59] | `float` |
| Net Delivery | Data1[0-17] | `EStatsXVFXNetDelivery` |

**Execution flow (client / standalone):**

1. `FindLocalVFXComponent(Handle)`.
2. Set `bAutoDestroy = true`.
3. If `BlendOutTime <= KINDA_SMALL_NUMBER` → `DeactivateImmediate()`.
4. Else → `Deactivate()` (Niagara blends out naturally).
5. `UnregisterLocalVFXComponent(Handle)`.

**Execution flow (authority):** Emits a `StopVFX` cosmetic cue carrying the handle and blend-out time.

### OP_UpdateVFX (336)

Updates the world transform of a live Niagara system.

**Instruction fields:**

| Field | Source | Type |
|---|---|---|
| VFX Handle | Data0[24-41] | `int64` |
| Transform | Data0[42-59] | `FTransform` |
| Transform Space | Data1[0-17] | `EStatsXVFXTransformSpace` |
| Net Delivery | Data1[18-35] | `EStatsXVFXNetDelivery` |

Resolves world transform from space, then calls `SetWorldLocationAndRotation()` and `SetWorldScale3D()` on the component.

### OP_SpawnSFX (337)

Spawns an audio source at a world location.

**Instruction fields:**

| Field | Source | Type |
|---|---|---|
| Sound | Data0[24-41] | `USoundBase*` |
| Transform | Data0[42-59] | `FTransform` |
| Transform Space | Data1[0-17] | `EStatsXVFXTransformSpace` |
| Net Delivery | Data1[18-35] | `EStatsXVFXNetDelivery` |
| SFX Handle output | Data1[36-51] | output offset (uint16) |
| Playback Policy | Continuation Data0[0-17] | `EStatsXSFXPlaybackPolicy` |
| Volume Multiplier | Continuation Data0[18-35] | `float` |
| Pitch Multiplier | Continuation Data0[36-53] | `float` |
| Start Time | Continuation Data1[0-17] | `float` |

**Playback policies:**

| Policy | Spawn API | Handle | Tracked |
|---|---|---|---|
| `FireAndForget` (or `Auto`) | `UGameplayStatics::PlaySoundAtLocation` | `0` | No |
| `Persistent` | `UGameplayStatics::SpawnSoundAtLocation` | allocated | Yes |

**Audio parameter validation:**

| Condition | Correction |
|---|---|
| Both volume and pitch `<= 0` | Reset both to `1.0` |
| Volume `< 0` | Reset to `1.0` |
| Pitch `<= 0` | Reset to `1.0` |
| Any non-finite | Reset to `1.0` |
| Start time `< 0` or non-finite | Reset to `0.0` |

### OP_StopSFX (338)

Stops a persistent audio component.

**Instruction fields:**

| Field | Source | Type |
|---|---|---|
| SFX Handle | Data0[24-41] | `int64` |
| Fade Out Time | Data0[42-59] | `float` |
| Net Delivery | Data1[0-17] | `EStatsXVFXNetDelivery` |

**Execution flow (client / standalone):**

1. `FindLocalSFXComponent(Handle)`.
2. If `FadeOutTime <= KINDA_SMALL_NUMBER` → `Stop()`.
3. Else → `FadeOut(FadeOutTime, 0.f)`.
4. `UnregisterLocalSFXComponent(Handle)`.

---

## Cosmetic Cue Field Mapping

When the server emits a VFX/SFX cosmetic cue, the `FStatsXCosmeticCue` envelope carries all necessary data in its generic payload slots.

### SpawnVFX / SpawnVFXAttached

| Cue Field | Content |
|---|---|
| `CueType` | `SpawnVFX` or `SpawnVFXAttached` |
| `Asset` | `UNiagaraSystem*` |
| `Location` / `Rotation` / `Scale` | World or relative transform |
| `Int0` | Transform space or attach rule (cast to enum) |
| `Int1` | Pool policy (cast to enum) |
| `Int64_0` | VFX handle |
| `SectionName` | Socket name (attached variant) |
| `ExplicitRouteActor` | Parent actor (attached variant) |

### StopVFX

| Cue Field | Content |
|---|---|
| `CueType` | `StopVFX` |
| `Int64_0` | VFX handle |
| `Float0` | Blend out time |

### UpdateVFX

| Cue Field | Content |
|---|---|
| `CueType` | `UpdateVFX` |
| `Int64_0` | VFX handle |
| `Location` / `Rotation` / `Scale` | New transform |
| `Int0` | Transform space |

### SpawnSFX

| Cue Field | Content |
|---|---|
| `CueType` | `SpawnSFX` |
| `Asset` | `USoundBase*` |
| `Location` / `Rotation` / `Scale` | World or relative transform |
| `Int0` | Transform space |
| `Int1` | Playback policy |
| `Float0` | Volume multiplier |
| `Float1` | Pitch multiplier |
| `Float2` | Start time |
| `Int64_0` | SFX handle (0 if fire-and-forget) |

### StopSFX

| Cue Field | Content |
|---|---|
| `CueType` | `StopSFX` |
| `Int64_0` | SFX handle |
| `Float0` | Fade out time |

---

## Enumerations

### EStatsXVFXTransformSpace

| Value | Meaning |
|---|---|
| `World` | Input transform is already in world space. |
| `TargetRelative` | Input transform is relative to the target actor. |
| `CasterRelative` | Input transform is relative to the caster actor. |

### EStatsXVFXAttachRule

| Value | Meaning |
|---|---|
| `KeepRelativeOffset` | Input transform used as local offset relative to parent/socket. |
| `KeepWorldTransform` | Input transform treated as resolved world transform. |
| `SnapToTargetIncludingScale` | Snap everything to parent/socket; input ignored. |
| `SnapToTargetNotIncludingScale` | Snap location and rotation; preserve input scale. |

### EStatsXVFXNetDelivery

| Value | Meaning |
|---|---|
| `Auto` | Runtime default (currently maps to burst unreliable). |
| `BurstUnreliable` | Fire-and-forget multicast. |
| `StateReliable` | Reliable state-channel delivery with dedup. |

### EStatsXSFXPlaybackPolicy

| Value | Meaning |
|---|---|
| `Auto` | Runtime default (currently maps to fire-and-forget). |
| `FireAndForget` | One-shot playback, no handle tracking. |
| `Persistent` | Spawns a tracked `UAudioComponent` with handle. |

### EStatsXVFXPoolPolicy

| Value | Meaning |
|---|---|
| `Auto` | Maps to Niagara `AutoRelease`. |
| `None` | Disable Niagara pooling for this spawn. |
| `AutoRelease` | Pool with auto-release lifecycle. |
| `ManualRelease` | Pool with manual release (`bAutoDestroy = false`). |

---

## Handle Lifecycle

### VFX Lifecycle

```
Server / Standalone                          Client (via Cosmetic Cue)
───────────────────                          ────────────────────────
AllocateCosmeticVFXHandle() → Handle         ExecuteBuiltInCue(SpawnVFX)
SpawnSystemAtLocation() → Component            SpawnSystemAtLocation() → Component
RegisterLocalVFXComponent(Handle, Comp)        RegisterLocalVFXComponent(Handle, Comp)
     │                                              │
     ▼  (gameplay continues)                        ▼
FindLocalVFXComponent(Handle) → Comp         FindLocalVFXComponent(Handle) → Comp
     │  UpdateVFX / StopVFX                         │  ExecuteBuiltInCue(Stop/Update)
     ▼                                              ▼
UnregisterLocalVFXComponent(Handle)          UnregisterLocalVFXComponent(Handle)
```

### SFX Lifecycle (Persistent)

Same flow as VFX, substituting `UAudioComponent` and `SFX` methods. Fire-and-forget sounds bypass the handle registry entirely.

---

## Network Execution Model

| Context | Local spawn | Cue emitted | Handle registered |
|---|---|---|---|
| Dedicated server | No | Yes | No |
| Listen server | Yes | Yes | Yes |
| Standalone | Yes | No | Yes |
| Client (from cue) | Yes | No | Yes |

On a **dedicated server**, VFX/SFX opcodes only emit cosmetic cues — no Niagara or audio components are spawned. Clients receive the cues through the `NetCueRelay` and execute the spawn locally via `ExecuteBuiltInCue`, registering the component in their own local handle registry.

---

## Stale Entry Management

Both registries share the same cleanup strategy:

1. **Lazy removal on lookup.** `FindLocal*Component` removes stale weak pointers on access.
2. **Threshold sweep on registration.** When `Map.Num() > 2048`, `RegisterLocal*Component` iterates the entire map and removes all entries whose `TWeakObjectPtr` is no longer valid.
3. **Subsystem teardown.** `Deinitialize` empties both maps and resets allocators to `1`.

This design avoids per-tick iteration costs while bounding worst-case map growth.

---

## Constants

| Constant | Value | Location |
|---|---|---|
| Invalid handle sentinel | `0` | All API guards check `<= 0` |
| Initial allocator value | `1` | `StatsX_WorldSubsystem.h` |
| Initial map capacity | `128` | `StatsX_WorldSubsystem.cpp` — `Initialize` |
| Stale cleanup threshold | `2048` | `RegisterLocalVFXComponent` / `RegisterLocalSFXComponent` |
| `KINDA_SMALL_NUMBER` | Engine constant (~1e-4) | Blend-out / fade-out immediate-vs-gradual threshold |

---

## Source Files

| File | Content |
|---|---|
| `Public/Data/StatsXTypes.h` | VFX/SFX enumerations (lines 164–238). |
| `Public/Data/StatsXCosmeticCueTypes.h` | `EStatsXCosmeticCueType` values and `FStatsXCosmeticCue` envelope. |
| `Public/Core/StatsX_WorldSubsystem.h` | Handle registry API declarations, private allocator and map fields. |
| `Private/Core/StatsX_WorldSubsystem.cpp` | Handle Allocate / Register / Find / Unregister implementations (lines 641–775). |
| `Private/Nodes/Nodes_Core.cpp` | Opcode handlers: SpawnVFX, SpawnVFXAttached, StopVFX, UpdateVFX, SpawnSFX, StopSFX. |
| `Private/Net/StatsX_NetCueRelay.cpp` | `ExecuteBuiltInCue` — client-side spawn from received cues. |
