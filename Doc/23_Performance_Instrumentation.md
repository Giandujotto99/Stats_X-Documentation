# 23 — Performance Instrumentation

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Overview

Stats_X ships a compile-time performance instrumentation system that provides fine-grained observability across every runtime subsystem. The system integrates with three Unreal profiling backends — **Unreal Insights Trace**, **CSV Profiler**, and **Cycle Stats** — and lets developers enable or disable each backend independently per subsystem area from Project Settings. All instrumentation compiles to zero-cost no-ops when disabled.

---

## Architecture

```
Project Settings (UStatsXPerformanceSettings)
         │
         │  DefaultGame.ini
         ▼
Stats_X.Build.cs  ──────────────────────────────────────────────────────┐
  ConfigurePerformanceInstrumentation()                                 │
         │                                                              │
         ├── Read InstrumentationRules from config                      │
         ├── Resolve per-area backend selection                         │
         └── Emit PublicDefinitions (compiler defines):                 │
               STATSX_PERF_<AREA>_TRACE = 0|1                          │
               STATSX_PERF_<AREA>_CSV = 0|1                            │
               STATSX_PERF_<AREA>_CYCLE_STATS = 0|1                    │
               STATSX_PERF_ANY_TRACE = 0|1                             │
               STATSX_PERF_ANY_CSV = 0|1                               │
               STATSX_PERF_ANY_CYCLE_STATS = 0|1                       │
                                                                        │
StatsXPerf.h  ◄─────────────────────────────────────────────────────────┘
         │
         ├── Conditional includes (CpuProfilerTrace.h, CsvProfiler.h, Stats.h)
         ├── DECLARE_STATS_GROUP (7 stat groups)
         ├── DECLARE_CYCLE_STAT_EXTERN (73 cycle stats)
         ├── Base wrapper macros (STATSX_TRACE_SCOPE_STR, STATSX_CSV_SCOPE, STATSX_CYCLE_SCOPE)
         ├── Per-area toggle macros (STATSX_<AREA>_TRACE_SCOPE, etc.)
         └── Composite scope macros (STATSX_<AREA>_SCOPE)
                    │
                    ▼
         Runtime source files (~94 instrumentation points)
```

---

## Configuration

### Project Settings

**Path:** Project Settings > Plugins > Stats_X Performance

The settings panel exposes a fixed-size array of `FStatsXPerfInstrumentationRule` entries — one per subsystem area. Each rule pairs an `EStatsXPerfArea` with an `EStatsXPerfBackend`.

**Class:** `UStatsXPerformanceSettings` (extends `UDeveloperSettings`)

| Property | Type | Description |
|---|---|---|
| `InstrumentationRules` | `TArray<FStatsXPerfInstrumentationRule>` | Per-area backend assignments. Fixed at 9 entries (one per area). |

Changes require an **editor restart and rebuild/repackage** to take effect — the settings drive compile-time preprocessor defines.

### EStatsXPerfArea

| Value | Display Name | Macro Prefix |
|---|---|---|
| `WorldSubsystem` | World Subsystem | `WORLD` |
| `VM` | Forge VM | `VM` |
| `StatsComponent` | Stats Component | `COMPONENT` |
| `Replication` | Replication | `REPLICATION` |
| `NetCue` | Net Cue Relay | `NETCUE` |
| `Nodes` | Runtime Nodes | `NODES` |
| `AssetLoads` | Asset Loads | `ASSETLOADS` |
| `CustomLogic` | Custom Logic | `CUSTOMLOGIC` |
| `InterceptorHooks` | Interceptors | `INTERCEPTORS` |

### EStatsXPerfBackend

| Value | Display Name | Trace | CSV | Cycle Stats |
|---|---|---|---|---|
| `Disabled` | Disabled | — | — | — |
| `Trace` | Unreal Insights Trace | Yes | — | — |
| `Csv` | CSV Profiler | — | Yes | — |
| `CycleStats` | Cycle Stats | — | — | Yes |
| `TraceAndCsv` | Trace + CSV | Yes | Yes | — |
| `TraceAndCycleStats` | Trace + Cycle Stats | Yes | — | Yes |
| `CsvAndCycleStats` | CSV + Cycle Stats | — | Yes | Yes |
| `All` | All Backends | Yes | Yes | Yes |

**Default:** all areas are set to `Disabled`.

---

## Build Integration

The `Stats_X.Build.cs` module rules file reads the `InstrumentationRules` array from `DefaultGame.ini` at build time and emits preprocessor defines as `PublicDefinitions`.

**Config path:** `/Script/Stats_X.StatsXPerformanceSettings` → `InstrumentationRules`

**Per-area defines emitted (for each of the 9 areas):**

| Define | Purpose |
|---|---|
| `STATSX_PERF_<AREA>_BACKEND` | Integer backend enum value. |
| `STATSX_PERF_<AREA>_ENABLED` | `1` if any backend is active, `0` otherwise. |
| `STATSX_PERF_<AREA>_TRACE` | `1` if Unreal Insights tracing is active. |
| `STATSX_PERF_<AREA>_CSV` | `1` if CSV profiling is active. |
| `STATSX_PERF_<AREA>_CYCLE_STATS` | `1` if cycle stat counters are active. |

**Global aggregation defines:**

| Define | Purpose |
|---|---|
| `STATSX_PERF_ENABLED` | `1` if any area has any backend enabled. |
| `STATSX_PERF_ANY_ENABLED` | Alias for `STATSX_PERF_ENABLED`. |
| `STATSX_PERF_ANY_TRACE` | `1` if any area uses Trace. Gates `CpuProfilerTrace.h` include. |
| `STATSX_PERF_ANY_CSV` | `1` if any area uses CSV. Gates `CsvProfiler.h` include. |
| `STATSX_PERF_ANY_CYCLE_STATS` | `1` if any area uses Cycle Stats. Gates `Stats.h` include and stat declarations. |

This design ensures that **header includes, stat group declarations, and cycle stat registrations are completely stripped** from builds where no area enables the corresponding backend.

---

## Profiling Backends

### Unreal Insights Trace

Emits CPU profiler events visible in the **Unreal Insights** timeline. Each scope appears as a named event span with precise start/end timestamps.

**Include:** `ProfilingDebugging/CpuProfilerTrace.h` (conditional on `STATSX_PERF_ANY_TRACE`)

**Base macro:**
```cpp
STATSX_TRACE_SCOPE_STR(NameLiteral)
  → TRACE_CPUPROFILER_EVENT_SCOPE_STR(NameLiteral)
```

### CSV Profiler

Records scoped timing data to CSV files for offline analysis. All Stats_X metrics are grouped under a single `StatsX` CSV category.

**Include:** `ProfilingDebugging/CsvProfiler.h` (conditional on `STATSX_PERF_ANY_CSV`)

**Category:** `CSV_DEFINE_CATEGORY(StatsX, false)` — disabled by default, activate via `csv.Category StatsX` console command.

**Base macro:**
```cpp
STATSX_CSV_SCOPE(StatName)
  → CSV_SCOPED_TIMING_STAT(StatsX, StatName)
```

### Cycle Stats

Integrates with Unreal's built-in stat system, viewable via `stat` console commands (e.g., `stat StatsXRuntime`, `stat StatsXVM`).

**Include:** `Stats/Stats.h` (conditional on `STATSX_PERF_ANY_CYCLE_STATS`)

**Base macro:**
```cpp
STATSX_CYCLE_SCOPE(StatName)
  → SCOPE_CYCLE_COUNTER(StatName)
```

---

## Macro System

### Per-Area Toggle Macros

Each area defines three toggle macros that resolve to either the base macro or a no-op, controlled by the corresponding `STATSX_PERF_<AREA>_*` define:

```
STATSX_<AREA>_TRACE_SCOPE(NameLiteral)     → STATSX_TRACE_SCOPE_STR or no-op
STATSX_<AREA>_CSV_SCOPE(StatName)           → STATSX_CSV_SCOPE or no-op
STATSX_<AREA>_CYCLE_SCOPE(StatName)         → STATSX_CYCLE_SCOPE or no-op
```

### Composite Scope Macros

Each area provides a single composite macro that fires all three backends in one call:

```cpp
STATSX_<AREA>_SCOPE(NameLiteral, CsvStatName, CycleStatName)
```

**Parameters:**

| Parameter | Backend | Example |
|---|---|---|
| `NameLiteral` | Trace (string literal) | `TEXT("StatsX.VM.Execute")` |
| `CsvStatName` | CSV (identifier) | `VMExecute` |
| `CycleStatName` | Cycle Stats (stat name) | `STAT_StatsXVMExecute` |

**Composite macros (9 total):**

| Macro | Area |
|---|---|
| `STATSX_WORLD_SCOPE` | World Subsystem |
| `STATSX_VM_SCOPE` | Forge VM |
| `STATSX_COMPONENT_SCOPE` | Stats Component |
| `STATSX_REPLICATION_SCOPE` | Replication |
| `STATSX_NETCUE_SCOPE` | Net Cue Relay |
| `STATSX_NODES_SCOPE` | Runtime Nodes |
| `STATSX_ASSETLOADS_SCOPE` | Asset Loads |
| `STATSX_CUSTOMLOGIC_SCOPE` | Custom Logic |
| `STATSX_INTERCEPTORS_SCOPE` | Interceptors |

---

## Stat Groups

Seven stat groups are declared under `STATCAT_Advanced`:

| Group | Console Command | Description |
|---|---|---|
| `STATGROUP_StatsXRuntime` | `stat StatsXRuntime` | World subsystem tick, attribute/modifier operations. |
| `STATGROUP_StatsXVM` | `stat StatsXVM` | ForgeVM execute, resume, step. |
| `STATGROUP_StatsXNet` | `stat StatsXNet` | Replication callbacks, NetCue pipeline. |
| `STATGROUP_StatsXNodes` | `stat StatsXNodes` | Runtime node execution (montage, VFX, SFX, etc.). |
| `STATGROUP_StatsXAssetLoads` | `stat StatsXAssetLoads` | Sync/async status definition loading. |
| `STATGROUP_StatsXCustomLogic` | `stat StatsXCustomLogic` | Custom check/action execution and context management. |
| `STATGROUP_StatsXInterceptors` | `stat StatsXInterceptors` | Interceptor registration, broadcasting, conditions, actions. |

---

## Cycle Stat Reference

### Runtime (STATGROUP_StatsXRuntime) — 8 stats

| Stat | Description |
|---|---|
| `STAT_StatsXWorldSubsystemTick` | Full world subsystem tick frame. |
| `STAT_StatsXWorldExecuteInstance` | Single status instance execution. |
| `STAT_StatsXWorldFlushPendingStatusUpdates` | Pending status update flush pass. |
| `STAT_StatsXComponentModifyAttribute` | Attribute modification (delta apply). |
| `STAT_StatsXComponentSetAttribute` | Attribute direct set. |
| `STAT_StatsXComponentAddModifier` | Modifier registration. |
| `STAT_StatsXComponentRemoveModifiersWithFilters` | Filtered modifier removal. |
| `STAT_StatsXComponentRecalculateAttribute` | Full attribute recalculation from modifiers. |

### VM (STATGROUP_StatsXVM) — 3 stats

| Stat | Description |
|---|---|
| `STAT_StatsXVMExecute` | ForgeVM program execution entry. |
| `STAT_StatsXVMResume` | ForgeVM suspended program resume. |
| `STAT_StatsXVMExecuteStep` | Single VM instruction step. |

### Net — Replication (STATGROUP_StatsXNet) — 9 stats

| Stat | Description |
|---|---|
| `STAT_StatsXReplicationUpdateAttribute` | Server-side attribute replication update. |
| `STAT_StatsXReplicationSynchronizeLocalAttributes` | Bulk local attribute synchronization. |
| `STAT_StatsXReplicationStatusSeedBridge` | Status seed bridge to Fast Array. |
| `STAT_StatsXReplicationStatusUpdateBridge` | Status update bridge to Fast Array. |
| `STAT_StatsXReplicationAttributeApply` | Client attribute replication callback. |
| `STAT_StatsXReplicationModifierApply` | Client modifier replication callback. |
| `STAT_StatsXReplicationTagApply` | Client tag replication callback. |
| `STAT_StatsXReplicationStatusSeedApply` | Client status seed replication callback. |
| `STAT_StatsXReplicationStatusUpdateApply` | Client status update replication callback. |

### Net — NetCue (STATGROUP_StatsXNet) — 13 stats

| Stat | Description |
|---|---|
| `STAT_StatsXNetCueEnqueue` | Cue enqueue into pending bus. |
| `STAT_StatsXNetCueFlushBus` | Cue bus flush pass. |
| `STAT_StatsXNetCueRouteToNetwork` | Network routing decision. |
| `STAT_StatsXNetCueGetOrCreateRelay` | Relay actor lookup or creation. |
| `STAT_StatsXNetCuePushFromServer` | State cue push into relay Fast Array. |
| `STAT_StatsXNetCueBurstReceive` | Client burst multicast receive. |
| `STAT_StatsXNetCueStateReceive` | Client state replication receive. |
| `STAT_StatsXNetCueDispatchClient` | Client-side cue dispatch. |
| `STAT_StatsXNetCueExecuteBuiltIn` | Built-in cue handler execution. |
| `STAT_StatsXNetCueExecuteMontage` | Montage cue execution. |
| `STAT_StatsXNetCueExecuteVFX` | VFX spawn cue execution. |
| `STAT_StatsXNetCueExecuteSFX` | SFX spawn cue execution. |
| `STAT_StatsXNetCueRebuildStateIndex` | State cue index rebuild. |

### Nodes (STATGROUP_StatsXNodes) — 8 stats

| Stat | Description |
|---|---|
| `STAT_StatsXNodeForEachActorInRange` | Spatial query node execution. |
| `STAT_StatsXNodeWaitForEvent` | Single event wait registration. |
| `STAT_StatsXNodeWaitForEvents` | Multi-event wait registration. |
| `STAT_StatsXNodePlayMontage` | Montage play node. |
| `STAT_StatsXNodeCastStatus` | Status cast node. |
| `STAT_StatsXNodeSendEvent` | Event send node. |
| `STAT_StatsXNodeSpawnVFX` | VFX spawn node. |
| `STAT_StatsXNodeSpawnSFX` | SFX spawn node. |

### Asset Loads (STATGROUP_StatsXAssetLoads) — 6 stats

| Stat | Description |
|---|---|
| `STAT_StatsXAssetLoadWorldCastStatusSync` | Synchronous world-level status cast load. |
| `STAT_StatsXAssetLoadWorldCastStatusAsyncRequest` | Async world-level status cast load request. |
| `STAT_StatsXAssetLoadWorldCastStatusAsyncComplete` | Async world-level status cast load completion. |
| `STAT_StatsXAssetLoadComponentCastStatusSync` | Synchronous component-level status cast load. |
| `STAT_StatsXAssetLoadComponentCastStatusAsyncRequest` | Async component-level status cast load request. |
| `STAT_StatsXAssetLoadComponentCastStatusAsyncComplete` | Async component-level status cast load completion. |

### Custom Logic (STATGROUP_StatsXCustomLogic) — 7 stats

| Stat | Description |
|---|---|
| `STAT_StatsXCustomLogicExecuteCheck` | Custom check execution. |
| `STAT_StatsXCustomLogicExecuteAction` | Custom action execution. |
| `STAT_StatsXCustomLogicSetupContext` | Execution context setup. |
| `STAT_StatsXCustomLogicInjectForgeParams` | ForgeVM parameter injection into custom logic. |
| `STAT_StatsXCustomLogicClearContext` | Execution context teardown. |
| `STAT_StatsXCustomLogicMarkAsExecuting` | Action executing state mark. |
| `STAT_StatsXCustomLogicEndAction` | Action end and cleanup. |

### Interceptors (STATGROUP_StatsXInterceptors) — 19 stats

| Stat | Description |
|---|---|
| `STAT_StatsXInterceptorCallPropagation` | Full propagation call chain. |
| `STAT_StatsXInterceptorBroadcastEvents` | Event broadcast dispatch. |
| `STAT_StatsXInterceptorBroadcastLocal` | Local interceptor broadcast. |
| `STAT_StatsXInterceptorBroadcastGlobal` | Global interceptor broadcast. |
| `STAT_StatsXInterceptorCondition` | Condition evaluation. |
| `STAT_StatsXInterceptorAction` | Action execution. |
| `STAT_StatsXInterceptorRegisterLocalNode` | Local node registration. |
| `STAT_StatsXInterceptorRegisterGlobalNode` | Global node registration. |
| `STAT_StatsXInterceptorUnregisterLocalNode` | Local node unregistration. |
| `STAT_StatsXInterceptorUnregisterGlobalNode` | Global node unregistration. |
| `STAT_StatsXInterceptorRegisterLocalRuntime` | Local runtime registration. |
| `STAT_StatsXInterceptorRegisterGlobalRuntime` | Global runtime registration. |
| `STAT_StatsXInterceptorUnregisterLocalRuntime` | Local runtime unregistration. |
| `STAT_StatsXInterceptorUnregisterGlobalRuntime` | Global runtime unregistration. |
| `STAT_StatsXInterceptorUnregisterForEvent` | Per-event unregistration. |
| `STAT_StatsXInterceptorUnregisterAllGlobalFromSource` | Bulk global unregistration by source. |
| `STAT_StatsXInterceptorSetupSourceData` | Source data setup for interceptor evaluation. |
| `STAT_StatsXInterceptorSetupTriggeringData` | Triggering data setup for interceptor evaluation. |
| `STAT_StatsXInterceptorClearTriggeringData` | Triggering data teardown. |

**Total: 73 cycle stats across 7 stat groups.**

---

## Instrumentation Coverage

Approximate instrumentation point count by source file:

| File | Area | Points |
|---|---|---|
| `StatsX_WorldSubsystem.cpp` | World, NetCue, AssetLoads, Interceptors | ~14 |
| `StatsX_NetCueRelay.cpp` | NetCue | ~13 |
| `StatsX_StatsComponentBase.cpp` | Component, Replication | ~10 |
| `Nodes_Core.cpp` | Nodes, CustomLogic | ~15 |
| `StatsXReplication.cpp` | Replication | 4 |
| `ForgeVM.cpp` | VM | 3 |
| `ForgeCustomLogicBase.cpp` | CustomLogic | 3 |
| `ForgeCustomAction.cpp` | CustomLogic | 2 |
| `ForgeInterceptorBase.cpp` | Interceptors | 3 |
| **Total** | | **~94** |

---

## Usage Example

A typical instrumentation point at a call site:

```cpp
void UStatsX_WorldSubsystem::Tick(float DeltaTime)
{
    STATSX_WORLD_SCOPE(
        TEXT("StatsX.WorldSubsystem.Tick"),   // Unreal Insights event name
        WorldSubsystemTick,                    // CSV stat identifier
        STAT_StatsXWorldSubsystemTick          // Cycle stat counter
    );
    // ... tick logic ...
}
```

When the World Subsystem area is configured with `All`, this single macro expands to:

```cpp
TRACE_CPUPROFILER_EVENT_SCOPE_STR(TEXT("StatsX.WorldSubsystem.Tick"));
CSV_SCOPED_TIMING_STAT(StatsX, WorldSubsystemTick);
SCOPE_CYCLE_COUNTER(STAT_StatsXWorldSubsystemTick);
```

When the area is set to `Disabled`, all three lines compile to nothing.

---

## Integration Notes

- **Zero-cost when disabled.** All instrumentation resolves to empty macros at compile time. No runtime branches, no function calls, no memory overhead.
- **Per-area granularity.** Enable profiling only where needed — e.g., enable Trace for VM and Cycle Stats for Replication, while leaving everything else disabled.
- **Settings normalization.** `UStatsXPerformanceSettings::NormalizeInstrumentationRules` ensures the rules array always contains exactly 9 entries (one per area), adding defaults for missing areas and discarding unknown entries on config load or editor change.
- **Build dependency tracking.** `Stats_X.Build.cs` registers `DefaultGame.ini` as an external dependency, so changes to instrumentation rules trigger a rebuild.
- **CSV category default.** The `StatsX` CSV category is defined with `false` (disabled). Enable it at runtime with the `csv.Category StatsX` console command before starting a CSV capture.
