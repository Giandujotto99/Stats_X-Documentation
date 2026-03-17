# 27 — Enumerations Reference

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Overview

Stats_X declares **27 enumerations**, all as `enum class` with `uint8` underlying type. Twenty are exposed to Blueprints via `UENUM(BlueprintType)`, four use basic `UENUM()`, and three are plain C++ enums with no reflection.

| Source File | Count |
|---|---|
| `Public/Data/StatsXTypes.h` | 20 |
| `Public/Data/StatsXCosmeticCueTypes.h` | 3 |
| `Public/VM/ForgeVMTypes.h` | 2 |
| `Private/Settings/StatsXPerformanceSettings.h` | 2 |

---

## Attribute System

### EAttributeModifyOp

How an attribute value should be modified. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Set` | Set (=) | Replace the current value. |
| `Transaction` | — | Add delta to current (positive or negative). |
| `Multiply` | Multiply (*) | Multiply current value. |
| `Divide` | Divide (/) | Divide current value. |
| `Min` | Min (Smaller Value) | Set to the smaller of current and input. |
| `Max` | Max (Larger Value) | Set to the larger of current and input. |

### EThresholdComparison

Comparison types for attribute threshold checks. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `LessOrEqual` | Less or Equal | Value is at or below threshold. |
| `GreaterOrEqual` | Greater or Equal | Value is at or above threshold. |
| `CrossingBelow` | Crossing Below (was above, now below) | Value crossed downward through threshold. |
| `CrossingAbove` | Crossing Above (was below, now above) | Value crossed upward through threshold. |

---

## Status Lifecycle

### EStatusInstanceState

Lifecycle state of a status instance. `UENUM(BlueprintType)`.

| Value | Description |
|---|---|
| `Inactive` | Not yet activated. |
| `Pending` | Queued for activation. |
| `Active` | Running normally. |
| `Suspended` | Paused (e.g. inside a Delay node). |
| `Terminating` | Cleanup in progress. |

### EStatusTerminateReason

Reason why a status ended. `UENUM(BlueprintType)`.

| Value | Description |
|---|---|
| `Completed` | Execution completed normally (reached `OP_End`). |
| `Expired` | Duration ran out. |
| `Removed` | Explicitly removed via gameplay tag or handle. |
| `StacksZero` | All stacks were consumed / removed. |
| `OwnerDestroyed` | Owning component / actor was destroyed. |
| `Replaced` | Overwritten by a new instance (if unique). |
| `CleanedUp` | System shutdown / level unload. |

### EStatusStackingPolicy

Defines how a status behaves when applied to a target that already has it. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Aggregate` | Aggregate (Add Stack) | Add new stack. Duration NOT refreshed. |
| `AggregateAndRefresh` | Aggregate & Refresh | Add new stack AND refresh duration to maximum. |
| `RefreshOnly` | Refresh Only | Do not add stacks, only refresh duration. |
| `Override` | Override (Replace) | Remove old instance and create a new one (full reset). |
| `Reject` | Reject (Ignore New) | Reject new application entirely if one already exists. |
| `Independent` | Independent (Always New) | Always create a new independent instance. |

### EStatusSetAction

Action type for status set events. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Added` | Added | Status was added. |
| `Removed` | Removed | Status was removed. |

### EStatusUpdateReason

Reason for status update events. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `StackChanged` | Stack Changed | Stack count changed. |
| `Refreshed` | Refreshed | Duration was refreshed. |
| `StackChangedAndRefreshed` | Stack Changed + Refreshed | Both stack and duration changed. |
| `RuntimeTuning` | Runtime Tuning | Fields modified at runtime outside normal gameplay flow. |

### EStatusUpdateField

Bitmask describing which fields are present in a status update payload. `UENUM(BlueprintType, meta = (Bitflags, UseEnumValuesAsMaskValuesInEditor = "true"))`.

| Value | Bit | Description |
|---|---|---|
| `None` | `0` | No fields. |
| `StackCount` | `1` | Stack count changed. |
| `StartTime` | `2` | Start time changed. |
| `MaxDuration` | `4` | Maximum duration changed. |
| `TickInterval` | `8` | Tick interval changed. |
| `MaxIterations` | `16` | Maximum iterations changed. |

---

## Interceptor System

### EInterceptorScope

Which registry receives the interceptor. `UENUM(BlueprintType)`.

| Value | Description |
|---|---|
| `Caster` | Events where this actor is the caster. |
| `Target` | Events where this actor is the target. |
| `Global` | World-wide events (WorldSubsystem). |

### EInterceptorEventPhase

When the interceptor fires relative to the instruction. `UENUM(BlueprintType)`.

| Value | Description |
|---|---|
| `Pre` | Called BEFORE the instruction executes. |
| `Post` | Called AFTER the instruction executes. |

---

## Custom Logic

### ENodeLogicTarget

Scope for node logic execution. `UENUM(BlueprintType)`.

| Value | Description |
|---|---|
| `Caster` | Execute the logic referencing the status caster. |
| `Target` | Execute the logic referencing the status target. |

---

## Comparison & Query

### EComparationMethod

Generic value comparison operators. `UENUM(BlueprintType)`.

| Value | Display Name |
|---|---|
| `LessThan` | < |
| `GreaterThan` | > |
| `LessOrEqual` | <= |
| `GreaterOrEqual` | >= |
| `Equal` | == |
| `Different` | != |

### EQueryMethod

Gameplay tag query modes. `UENUM(BlueprintType)`.

| Value | Description |
|---|---|
| `HasTag` | Has specific tag (hierarchical match). |
| `HasAny` | Has any of the given tags (hierarchical). |
| `HasAll` | Has all of the given tags (hierarchical). |
| `HasNone` | Has none of the given tags (hierarchical). |
| `HasTagExact` | Has specific tag (exact match only). |
| `HasAnyExact` | Has any of the given tags (exact). |
| `HasAllExact` | Has all of the given tags (exact). |
| `HasNoneExact` | Has none of the given tags (exact). |

### EObjectComparationMethod

Object comparison operators. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Equal` | == | Same object instance. |
| `Different` | != | Different object instance. |
| `ClassIsEqual` | >=< | Same UClass. |
| `ClassIsDifferent` | <=> | Different UClass. |

---

## ForgeVM

### EForgeExecutionResult

Result of a single instruction or VM step execution. `UENUM()`.

| Value | Description |
|---|---|
| `Continue` | Operation successful, proceed to next instruction. |
| `Completed` | Reached `OP_End`, execution finished successfully. |
| `Suspended` | Async node (e.g. Delay) requested suspension. |
| `Aborted` | Manual abort triggered. |
| `Error` | Runtime error occurred (see `Context.LastError`). |

### EForgeDataSource

Where the VM reads data from during execution. `UENUM()`.

| Value | Description |
|---|---|
| `Literal` | Value stored in the definition pool. |
| `Context` | Temporary value in execution stack (cleared per tick). |
| `Instance` | Persistent value in instance blob (SaveGame compatible). |
| `CallFrame` | Captured argument value from current function call frame. |

### EForgeTickPhase

When the VM should tick relative to the game frame. `UENUM()`.

| Value | Description |
|---|---|
| `PrePhysics` | Before physics simulation. |
| `DuringPhysics` | During physics simulation. |
| `PostPhysics` | After physics simulation. |
| `FrameEnd` | End of frame. |

---

## VFX / SFX

### EStatsXVFXTransformSpace

Transform interpretation mode for SpawnVFX. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `World` | World | Input transform is already in world space. |
| `TargetRelative` | Target Relative | Relative to the target actor transform. |
| `CasterRelative` | Caster Relative | Relative to the caster actor transform. |

### EStatsXVFXAttachRule

Attachment rule for SpawnVFXAttachedtoActor. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `KeepRelativeOffset` | Keep Relative Offset | Input transform as local offset relative to parent/socket. |
| `KeepWorldTransform` | Keep World Transform | Input transform as already-resolved world transform. |
| `SnapToTargetIncludingScale` | Snap To Target Including Scale | Snap all to parent/socket. Input ignored. |
| `SnapToTargetNotIncludingScale` | Snap To Target Not Including Scale | Snap location/rotation. Preserve input scale. |

### EStatsXVFXNetDelivery

Network delivery policy for cosmetic cues. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Auto` | Auto | Runtime default (currently burst unreliable). |
| `BurstUnreliable` | Burst Unreliable | Fire-and-forget multicast. |
| `StateReliable` | State Reliable | Stateful reliable stream delivery. |

### EStatsXSFXPlaybackPolicy

Playback policy for SpawnSFX. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Auto` | Auto | Runtime default (currently fire-and-forget). |
| `FireAndForget` | Fire And Forget | One-shot playback, no handle tracking. |
| `Persistent` | Persistent | Persistent audio component with handle tracking. |

### EStatsXVFXPoolPolicy

Niagara pooling policy for SpawnVFX. `UENUM(BlueprintType)`.

| Value | Display Name | Description |
|---|---|---|
| `Auto` | Auto | Maps to Niagara AutoRelease. |
| `None` | None | Disable pooling for this spawn. |
| `AutoRelease` | Auto Release | Pool with auto-release lifecycle. |
| `ManualRelease` | Manual Release | Pool with manual release (`bAutoDestroy = false`). |

---

## Cosmetic Cue Bus

### EStatsXCosmeticCueType

High-level cue semantic. Plain `enum class` (no UENUM).

| Value | Numeric | Description |
|---|---|---|
| `None` | 0 | Invalid / unset. |
| `PlayMontage` | 1 | Play animation montage. |
| `StopMontage` | 2 | Stop animation montage. |
| `SpawnVFX` | 3 | Spawn Niagara system at location. |
| `StopVFX` | 4 | Stop Niagara system. |
| `UpdateVFX` | 5 | Update Niagara system transform. |
| `Custom` | 6 | User-defined cue (no-op in `ExecuteBuiltInCue`). |
| `SpawnSFX` | 7 | Spawn audio source. |
| `StopSFX` | 8 | Stop audio source. |
| `SpawnVFXAttached` | 9 | Spawn Niagara system attached to actor. |

### EStatsXCosmeticCueChannel

Transport intent for the network layer. Plain `enum class` (no UENUM).

| Value | Description |
|---|---|
| `StateReliable` | Stateful: latest value wins per stream key. |
| `BurstUnreliable` | Fire-and-forget burst. |

### EStatsXCosmeticCueRoutePolicy

Route selection policy for the cue bus. Plain `enum class` (no UENUM).

| Value | Description |
|---|---|
| `Auto` | Cascade: ExplicitRouteActor → TargetActor → CasterActor → Global. |
| `TargetActor` | Route using target actor. |
| `CasterActor` | Route using caster actor. |
| `ExplicitActor` | Route using explicit route actor. |
| `Global` | Global route (no actor affinity). |

---

## Performance Instrumentation

### EStatsXPerfArea

Performance monitoring areas. `UENUM()`.

| Value | Display Name | Description |
|---|---|---|
| `WorldSubsystem` | World Subsystem | Subsystem tick, cue bus, handle registries. |
| `VM` | Forge VM | VM dispatch and instruction execution. |
| `StatsComponent` | Stats Component | Component-level attribute/modifier operations. |
| `Replication` | Replication | Fast Array serialization and callbacks. |
| `NetCue` | Net Cue Relay | Network cue relay transport. |
| `Nodes` | Runtime Nodes | Built-in opcode handler execution. |
| `AssetLoads` | Asset Loads | Async asset loading. |
| `CustomLogic` | Custom Logic | Blueprint-defined check/action execution. |
| `InterceptorHooks` | Interceptors | Interceptor dispatch and callbacks. |

### EStatsXPerfBackend

Available profiling backends. `UENUM()`.

| Value | Display Name | Description |
|---|---|---|
| `Disabled` | Disabled | No instrumentation. |
| `Trace` | Unreal Insights Trace | Emit to Unreal Insights. |
| `Csv` | CSV Profiler | Emit to CSV profiler. |
| `CycleStats` | Cycle Stats | Emit to `DECLARE_CYCLE_STAT` counters. |
| `TraceAndCsv` | Trace + CSV | Both Insights and CSV. |
| `TraceAndCycleStats` | Trace + Cycle Stats | Both Insights and cycle stats. |
| `CsvAndCycleStats` | CSV + Cycle Stats | Both CSV and cycle stats. |
| `All` | All Backends | All three backends active. |

---

## Summary

| Category | Enums | Blueprint Exposed |
|---|---|---|
| Attribute System | 2 | Yes |
| Status Lifecycle | 6 | Yes |
| Interceptor System | 2 | Yes |
| Custom Logic | 1 | Yes |
| Comparison & Query | 3 | Yes |
| ForgeVM | 3 | No (UENUM only) |
| VFX / SFX | 5 | Yes |
| Cosmetic Cue Bus | 3 | No (plain enum class) |
| Performance | 2 | No (UENUM only) |
| **Total** | **27** | **19 BlueprintType** |

All enumerations use `uint8` underlying type. One enum (`EStatusUpdateField`) uses bitflag metadata for bitmask-style composition in the editor.
