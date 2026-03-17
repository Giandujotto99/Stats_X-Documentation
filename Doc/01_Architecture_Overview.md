# Architecture Overview

> **Stats_X v1.404** — Unreal Engine 5.7
> Enterprise-grade Gameplay Ability System alternative

---

## Table of Contents

1. [Design Philosophy](#design-philosophy)
2. [Plugin Modules](#plugin-modules)
3. [Architectural Layers](#architectural-layers)
4. [Runtime Layer Map](#runtime-layer-map)
5. [Subsystem Hierarchy](#subsystem-hierarchy)
6. [Execution Model](#execution-model)
7. [Data Flow](#data-flow)
8. [Memory Model](#memory-model)
9. [Network Architecture](#network-architecture)
10. [Extension Points](#extension-points)
11. [Platform Support](#platform-support)
12. [Module Dependencies](#module-dependencies)
13. [Key Source Files](#key-source-files)

---

## Design Philosophy

Stats_X is built around four core principles:

| Principle | Implementation |
|---|---|
| **Zero-allocation hot path** | Single global `FForgeVMContext` reused for all executions; object-pooled `FStatusInstance` via `FStatusInstancePool` |
| **Cache-line awareness** | 128-bit instructions (4 per L1 cache line); 64-byte hot-data layout on `FStatusInstance` |
| **Handler-driven lifecycle** | The VM executes bytecode inline — node handlers decide if/when to promote an execution to a persistent instance |
| **Visual authoring, native performance** | StatusForge graph editor compiles to compact bytecode executed by `FForgeVM` at native speed |

The system deliberately avoids GAS patterns that introduce allocation pressure (per-ability instancing, deep UObject hierarchies, Gameplay Effect pooling) and instead adopts a bytecode VM approach where **status definitions are data assets compiled to instructions**, and the runtime is a flat dispatch loop over a pre-registered handler table.

---

## Plugin Modules

Stats_X ships as three modules:

| Module | Type | Loading Phase | Purpose |
|---|---|---|---|
| **Stats_X** | Runtime | Default | VM, components, replication, all runtime systems |
| **Stats_XEditor** | Editor | Default | StatusForge visual graph editor, compiler, node registry |
| **Stats_XUncooked** | UncookedOnly | Default | Blueprint-only helpers (e.g. `K2Node_SwitchOnTag`) |

**External dependency:** Niagara plugin (for VFX cosmetic cue support).

---

## Architectural Layers

The runtime is organized in five vertical layers. Each layer only depends on the layers below it.

```
┌─────────────────────────────────────────────────────────────────┐
│                    LAYER 5 — PRESENTATION                       │
│   Cosmetic Cue Bus · VFX/SFX Handles · Network Cue Relay       │
├─────────────────────────────────────────────────────────────────┤
│                    LAYER 4 — ORCHESTRATION                      │
│   WorldSubsystem · GameInstanceSubsystem · Forge Event System   │
├─────────────────────────────────────────────────────────────────┤
│                    LAYER 3 — COMPONENT                          │
│   StatsComponentBase · Attributes · Modifiers · Thresholds      │
│   Local Interceptors · Replication (FastArraySerializer)        │
├─────────────────────────────────────────────────────────────────┤
│                    LAYER 2 — EXECUTION                          │
│   ForgeVM · ForgeVMContext · Instruction Dispatch                │
│   Status Instance · Status Instance Pool                        │
├─────────────────────────────────────────────────────────────────┤
│                    LAYER 1 — DATA                               │
│   StatusDefinition (compiled bytecode) · StatusInstruction      │
│   Literal Pools · Variable Declarations · Payload Descriptors   │
│   OpCode Tables (System + Built-In + Custom)                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Runtime Layer Map

### Layer 1 — Data

Immutable, compiled assets produced by the StatusForge editor.

| Structure | Size | Role |
|---|---|---|
| `UPDA_StatusDefinition` | Variable | Compiled status asset: instruction array, literal pools (float, int, bool, tag, object, struct...), variable declarations, payload descriptors, function definitions |
| `FStatusInstruction` | 16 bytes | Single VM instruction. 128-bit encoding: OpCode (16 bits) + Flags (8 bits) + payload (104 bits). Continuation slots for overflow data |
| Literal Pools | Variable | Type-safe constant pools indexed from instruction payloads: `Pool_Floats`, `Pool_Ints`, `Pool_Bools`, `Pool_Tags`, `Pool_Objects`, `Pool_Vectors`, `Pool_Transforms`, `Pool_Strings`, `Pool_StructData`, etc. |
| OpCode Tables | Static | System OpCodes (0–31), Built-In Node OpCodes (32–9999), Custom Project OpCodes (10000+) |

### Layer 2 — Execution

The virtual machine and its runtime state.

| Component | Type | Role |
|---|---|---|
| `FForgeVM` | Singleton | Bytecode interpreter. Dispatches instructions via a flat function-pointer table (`TArray<FForgeNodeFunc>`). Single global context, no per-execution allocation |
| `FForgeVMContext` | Struct (reused) | Transient execution state: ContextStack (typed scratch memory), VariableBlob, ContextObjectPool, ContextArrayPool, FunctionCallStack. Cache-optimized hot data in the first 64 bytes |
| `FStatusInstance` | Struct (pooled) | Persistent state for suspended/active effects: timing, iteration count, stack count, InstanceBlob, VariableBlob, ArrayPool, SavedPC |
| `FStatusInstancePool` | Struct | Pre-allocated pool of `FStatusInstance`. Handle-based access (int64 StatusID → pool index). Owned by `UStatsX_WorldSubsystem` |

### Layer 3 — Component

Per-actor gameplay state.

| Component | Role |
|---|---|
| `UStatsX_StatsComponentBase` | Actor component holding attributes (`TMap<FGameplayTag, FStatAttribute>`), modifiers, thresholds, local interceptors, and replicated arrays. Entry point for `ApplyStatus()` |
| `FStatAttribute` | Value triplet: Current / Max / Base. Clamping, overflow toggle, replication flag |
| `FStatModifier` | Additive + Multiplicative modifier. Identified by InstanceID, grouped by OwnerID (batch removal) |
| Local Interceptors | Per-component interceptor registrations with Caster/Target scope filtering |
| Replication | `FReplicatedAttributeArray` and `FReplicatedModifierArray` via `FFastArraySerializer` — delta-only |

### Layer 4 — Orchestration

World-level coordination and lifecycle management.

| Component | Role |
|---|---|
| `UStatsX_GameInstanceSubsystem` | Global StatusID generator (`int64`, monotonic). Holds `DA_ImmutableGameStatuses` registry |
| `UStatsX_WorldSubsystem` | Central authority: executes statuses, owns the pool, ticks instances, manages stacking policies, routes cosmetic cues, manages global interceptors, runs the Forge Event System (SendEvent / WaitForEvent) |

### Layer 5 — Presentation

Visual/audio feedback and network transport for cosmetic state.

| Component | Role |
|---|---|
| Cosmetic Cue Bus | Enqueue / flush pipeline for `FStatsXCosmeticCue` (montage, VFX, SFX, custom). Deduplication via stream key |
| VFX / SFX Handle Registry | Monotonic handle allocation, local Niagara/Audio component tracking |
| `AStatsX_NetCueRelay` | Per-route-actor replicated actor. Transports cosmetic cues to clients via state-reliable or burst-unreliable channels |

---

## Subsystem Hierarchy

```
UGameInstance
 └─ UStatsX_GameInstanceSubsystem         [1 per game instance]
      • GenerateStatusID() → int64
      • DA_ImmutableGameStatuses registry

UWorld
 └─ UStatsX_WorldSubsystem                [1 per world]
      • Owns FStatusInstancePool
      • ExecuteStatus() / CastStatusSync() / CastStatusAsync()
      • Tick() → TickInstances() → ProcessPendingEventResumes() → FlushCosmeticCueBus()
      • Global Interceptor registry
      • Forge Event System (EventListenersByTag)
      • Cosmetic Cue Bus + Net Cue Relay management

AActor
 └─ UStatsX_StatsComponentBase             [0..N per actor]
      • Attribute storage + modifier stack
      • Local Interceptor registry
      • Replication via FastArraySerializer
      • Delegates: OnAttributeChanged, OnThresholdReached, OnStatusTagChanged
```

---

## Execution Model

### Inline Execution (default)

Every status begins as an **inline execution** — the VM runs bytecode synchronously from start to end (or until a suspend point). No pool instance is created unless a handler explicitly requests it.

```
WorldSubsystem.ExecuteStatus(StatusID, Definition, Caster, Target)
  │
  ├─ Apply stacking policy (Aggregate, Refresh, Override, Reject, Independent)
  ├─ ForgeVM.ExecuteStatus()
  │    ├─ Setup GlobalContext (Definition, Caster, Target, timing)
  │    ├─ Apply variable overrides (if any)
  │    └─ Execute() loop:
  │         ├─ Fetch FStatusInstruction at PC
  │         ├─ Dispatch via Handlers[OpCode]
  │         ├─ Handler may:
  │         │    ├─ Return Completed → advance PC
  │         │    ├─ Return Suspended → promote to pool instance
  │         │    └─ Return Error → abort
  │         └─ Repeat until terminal state
  │
  └─ Result: Completed | Suspended | Error
```

### Instance Resumption

Suspended instances are ticked by the WorldSubsystem. When their timer expires or a Forge Event fires, the VM resumes from `SavedPC`:

```
WorldSubsystem.Tick(DeltaTime)
  │
  ├─ ProcessPendingAsyncResumes()      // montage callbacks etc.
  ├─ TickInstances(DeltaTime)          // timer-based resumption
  │    └─ For each instance where ShouldTick() or ShouldResume():
  │         └─ ForgeVM.ResumeInstance(Instance, OverridePC)
  ├─ ProcessPendingEventResumes()      // Forge Event triggers
  ├─ DrainExpiredListeners()           // timeout cleanup
  ├─ FlushPendingStatusUpdates()       // coalesced delta replication
  └─ FlushCosmeticCueBus()            // route and dispatch cues
```

### Catch-Up Mechanism

If a status falls behind (frame hitches), the WorldSubsystem executes multiple iterations per frame, capped by `MaxExecutionsPerFrame` (default: 100). Optional time-drift compensation ensures precise scheduling over long durations.

---

## Data Flow

### Status Casting Flow

```
ApplyStatus (Component or WorldSubsystem)
  │
  ├─ GameInstanceSubsystem.GenerateStatusID()
  ├─ WorldSubsystem.ApplyStackingPolicy()
  │    ├─ Aggregate → AddStack to existing
  │    ├─ AggregateAndRefresh → AddStack + reset duration
  │    ├─ RefreshOnly → reset duration only
  │    ├─ Override → terminate existing, execute new
  │    ├─ Reject → skip if exists
  │    └─ Independent → always execute new
  │
  ├─ ForgeVM.ExecuteStatus()
  │    ├─ OP_Start → entry point
  │    ├─ OP_CheckCost / OP_CheckTags → validation gates
  │    ├─ OP_Casting → pre/post interceptors
  │    ├─ OP_ModifyAttribute / OP_AddModifier → gameplay effects
  │    ├─ OP_LoopBehavior / OP_UntilDeprecation → suspend → create instance
  │    └─ OP_End → terminate
  │
  └─ If Suspended:
       ├─ RegisterAsActiveInstance() → pool allocation
       ├─ Notify components (OnStatusTagChanged)
       └─ Replicate seed data (FStatusSeedData)
```

### Interceptor Data Flow

```
Node Execution (e.g., OP_ModifyAttribute)
  │
  ├─ OP_CallPropagationPreEvents (Pre-phase)
  │    ├─ Component.BroadcastInterceptorEvent(Caster scope)
  │    ├─ Component.BroadcastInterceptorEvent(Target scope)
  │    └─ WorldSubsystem.BroadcastGlobalInterceptorEvent()
  │         └─ For each interceptor (sorted by priority):
  │              ├─ SetupTriggeringData()
  │              ├─ Condition() → filter
  │              ├─ Action() → modify payload fields
  │              └─ ClearTriggeringData()
  │
  ├─ Execute core node logic
  │
  └─ OP_CallPropagationPostEvents (Post-phase)
       └─ (same dispatch pattern)
```

---

## Memory Model

### Transient Memory (per-execution, reused)

| Pool | Location | Lifetime |
|---|---|---|
| `ContextStack` | `FForgeVMContext` | Single execution slice. Reset on next `ExecuteStatus()` |
| `ContextObjectStack` | `FForgeVMContext` | Same. Object references are GC-tracked via `AddReferencedObjects` |
| `ContextArrayPool` | `FForgeVMContext` | Same. Dynamic array slots with auto-growth |
| `FunctionCallStack` | `FForgeVMContext` | Nested function frames, popped on `OP_EndEventBlock` |

### Persistent Memory (per-instance, pooled)

| Pool | Location | Lifetime |
|---|---|---|
| `InstanceBlob` | `FStatusInstance` | Survives across ticks. SaveGame-compatible |
| `InstanceObjectPool` | `FStatusInstance` | GC-safe object references persisted across suspensions |
| `VariableBlob` | `FStatusInstance` | User-declared variables that persist across execution slices |
| `ArrayPool` | `FStatusInstance` | Persistent dynamic arrays |

### Data Source Resolution

Instructions encode a 2-bit `EForgeDataSource` per operand:

| Source | Reads From | Persists? |
|---|---|---|
| `Literal` | Definition literal pools | Immutable |
| `Context` | `FForgeVMContext.ContextStack` | Per-slice |
| `Instance` | `FStatusInstance.InstanceBlob` | Per-instance |
| `CallFrame` | `FForgeVMContext.FunctionArgBlob` | Per-function-call |

---

## Network Architecture

Stats_X uses a **split replication model**:

### Gameplay State (Reliable, Property Replication)

| Data | Mechanism | Owner |
|---|---|---|
| Attributes | `FReplicatedAttributeArray` (FastArraySerializer) | `UStatsX_StatsComponentBase` |
| Modifiers | `FReplicatedModifierArray` (FastArraySerializer) | `UStatsX_StatsComponentBase` |
| Status lifecycle | `FStatusSetData` (Added / Removed) | `UStatsX_StatsComponentBase` |
| Status updates | `FStatusUpdateData` (delta bitmask: stack, duration, interval, iterations) | `UStatsX_WorldSubsystem` |

### Cosmetic State (Configurable Reliability)

| Data | Channel | Mechanism |
|---|---|---|
| State cues (VFX attach, persistent montages) | `StateReliable` | `AStatsX_NetCueRelay` replicated property + deduplication |
| Burst cues (hit impacts, one-shot SFX) | `BurstUnreliable` | `AStatsX_NetCueRelay` multicast RPC |

Route policy determines which relay carries each cue:

| Policy | Relay |
|---|---|
| `Auto` | Target actor relay (fallback: global relay) |
| `TargetActor` | Target actor relay |
| `CasterActor` | Caster actor relay |
| `ExplicitActor` | Explicit route actor relay |
| `Global` | Global relay (always relevant) |

---

## Extension Points

Stats_X is designed for project-specific extension without modifying plugin source:

| Extension | Mechanism | Registration |
|---|---|---|
| **Custom OpCodes** | Implement `FForgeNodeFunc`, register via `ForgeVM::RegisterHandler()` | Module startup. OpCode range 10000+ |
| **Custom Actions** | Subclass `UForgeCustomAction`, override `Execute()` | Referenced by `OP_CustomAction` in StatusForge graph |
| **Custom Checks** | Subclass `UForgeCustomCheck`, override `Execute()` | Referenced by `OP_CustomCheck` in StatusForge graph |
| **Interceptors** | Subclass `UForgeInterceptorBase`, override `Condition()` + `Action()` | Registered at runtime via `OP_RegisterLocalInterceptor` / `OP_RegisterGlobalInterceptor` or C++ API |
| **Cosmetic Cue Sinks** | Bind to `FOnStatsXCosmeticCueRoutedNative` | `WorldSubsystem.RegisterCosmeticCueSink()` |
| **Forge Events** | `SendForgeEvent()` / `WaitForEvent` | Fully data-driven, no code required |
| **Variable Overrides** | `TArray<FForgeVariableOverride>` passed at cast time | Runtime API on `ExecuteStatus()` and `CastStatusSync()` |

---

## Platform Support

| Platform | Status |
|---|---|
| Win64 | Supported |
| Mac | Supported |
| Linux | Supported |
| PS4 | Supported |
| PS5 | Supported |
| Xbox One | Supported |
| Xbox Series X/S | Supported |
| Nintendo Switch | Supported |
| iOS | Supported |
| Android | Supported |
| HoloLens | Supported |

**Excluded:** HTML5

---

## Module Dependencies

```
Stats_X (Runtime)
 ├─ Core
 ├─ CoreUObject
 ├─ Engine
 ├─ GameplayTags
 ├─ Niagara
 └─ NetCore

Stats_XEditor (Editor)
 ├─ Stats_X
 ├─ UnrealEd
 ├─ GraphEditor
 ├─ Slate / SlateCore
 ├─ EditorStyle
 ├─ PropertyEditor
 └─ KismetWidgets

Stats_XUncooked (UncookedOnly)
 ├─ Stats_X
 ├─ BlueprintGraph
 └─ KismetCompiler
```

---

## Key Source Files

| File | Layer | Purpose |
|---|---|---|
| `VM/ForgeVM.h` | Execution | VM singleton, `ExecuteStatus()`, handler dispatch table |
| `VM/ForgeVMContext.h` | Execution | Transient execution context, memory pools, data source resolution |
| `VM/ForgeVMTypes.h` | Execution | `FForgeNodeFunc` typedef, `EForgeExecutionResult`, `EForgeDataSource` |
| `Data/StatusDefinition.h` | Data | Compiled bytecode asset, literal pools, variable declarations |
| `Data/StatusInstruction.h` | Data | 128-bit instruction encoding, bit manipulation API |
| `Data/StatsXTypes.h` | Data | Core types: `FStatAttribute`, `FStatModifier`, enums, gameplay tag declarations |
| `Data/StatsXCosmeticCueTypes.h` | Presentation | Cosmetic cue struct, enums, stream key |
| `Core/StatsX_GameInstanceSubsystem.h` | Orchestration | Global ID generation, immutable status registry |
| `Core/StatsX_WorldSubsystem.h` | Orchestration | World authority: pool, ticking, events, interceptors, cue bus |
| `Core/StatsX_StatsComponentBase.h` | Component | Actor component: attributes, modifiers, thresholds, replication |
| `Core/StatusInstance.h` | Execution | Persistent status state: timing, blobs, stack count |
| `Core/StatusInstancePool.h` | Execution | Pre-allocated instance pool with handle-based access |
| `Interceptors/ForgeInterceptorBase.h` | Component | Interceptor base class: Condition/Action, payload access |
| `CustomLogics/ForgeCustomAction.h` | Extension | Custom C++/Blueprint action base |
| `CustomLogics/ForgeCustomCheck.h` | Extension | Custom C++/Blueprint check base |
| `Net/StatsX_NetCueRelay.h` | Presentation | Network transport for cosmetic cues |
| `Data/ForgeSystemOpCodes.h` | Data | System opcodes 0–31 (flow control) |
| `Data/ForgeOpCodes_BuiltIn.h` | Data | Built-in node opcodes 32–9999 |
