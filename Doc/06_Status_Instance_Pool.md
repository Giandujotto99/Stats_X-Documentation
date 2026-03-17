# Status Instance Pool

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Core Storage](#core-storage)
4. [Pool Management — Acquire / Release](#pool-management--acquire--release)
5. [Registration & Indexing](#registration--indexing)
6. [Scheduling — Min-Heap Model](#scheduling--min-heap-model)
7. [Time Drift Compensation](#time-drift-compensation)
8. [Query API](#query-api)
9. [Tag-Based Query API](#tag-based-query-api)
10. [Iteration API](#iteration-api)
11. [Cleanup Pipeline](#cleanup-pipeline)
12. [Ownership & Integration](#ownership--integration)
13. [Performance Characteristics](#performance-characteristics)
14. [Best Practices](#best-practices)

---

## Overview

`FStatusInstancePool` is the **centralized allocator and scheduler** for all active `FStatusInstance` objects in a world. It provides O(1) acquire/release, O(1) lookups by StatusID and tag, and O(k log n) min-heap scheduling for tick-based execution.

The pool is owned by `UStatsX_WorldSubsystem` — there is exactly one pool per world.

**Source:** `Core/StatusInstancePool.h`, `Core/StatusInstancePool.cpp`

### Design Goals

| Goal | Implementation |
|---|---|
| **Zero allocation in hot path** | Pre-allocated contiguous array. Acquire reuses freed slots; new slots append only when free list is empty |
| **O(1) instance access** | `StatusIDToIndex` map for direct pool index lookup |
| **O(1) tag queries** | `TagToStatusIDs` map for tag-based lookup |
| **Efficient scheduling** | Min-heap ordered by `NextExecutionTime` — only ready instances are processed each frame |
| **Cache-friendly iteration** | Contiguous `TArray<FStatusInstance>` — sequential access benefits from hardware prefetch |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      FStatusInstancePool                                 │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Pool: TArray<FStatusInstance>  (contiguous, pre-reserved)      │    │
│  │  [0] [1] [2] [3] [4] [5] [6] [7] ... [N]                      │    │
│  │   A   F   A   A   F   A   F   A       ...                      │    │
│  │   (A=Active, F=Free)                                            │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ActiveIndices: [0, 2, 3, 5, 7, ...]        ◄── tracks live slots      │
│  FreeIndices:   [1, 4, 6, ...]              ◄── recyclable slots       │
│                                                                          │
│  StatusIDToIndex: { 42→0, 87→2, 91→3, ... } ◄── O(1) ID lookup        │
│  TagToStatusIDs:  { Poison→[42,87], Burn→[91], ... }  ◄── O(1) tag    │
│                                                                          │
│  ScheduledHeap: [(0.5,42), (1.2,87), (2.0,91)]  ◄── min-heap by time  │
│  ScheduledSet:  {42, 87, 91}                     ◄── O(1) membership   │
│                                                                          │
│  GlobalTime: 0.0 ────► advances each frame                              │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Core Storage

### Pool Array

```cpp
TArray<FStatusInstance> Pool;
```

Contiguous array of all instance slots (active and free). Pre-reserved at construction:

```cpp
FStatusInstancePool::FStatusInstancePool(int32 InitialCapacity = 256)
{
    Pool.Reserve(InitialCapacity);
    ActiveIndices.Reserve(InitialCapacity);
    FreeIndices.Reserve(InitialCapacity);
    ScheduledHeap.Reserve(InitialCapacity);
    ScheduledSet.Reserve(InitialCapacity);
}
```

Default initial capacity: **256 instances**.

### Index Lists

| List | Type | Description |
|---|---|---|
| `ActiveIndices` | `TArray<int32>` | Pool indices of currently active instances |
| `FreeIndices` | `TArray<int32>` | Pool indices available for reuse |

### Lookup Maps

| Map | Type | Description |
|---|---|---|
| `StatusIDToIndex` | `TMap<int64, int32>` | StatusID → pool index. O(1) lookup |
| `TagToStatusIDs` | `TMap<FGameplayTag, TArray<int64>>` | StatusTag → array of StatusIDs. O(1) tag query |

---

## Pool Management — Acquire / Release

### Acquire

Returns a clean instance slot, reusing a free slot or expanding the pool:

```cpp
FStatusInstance* Acquire()
{
    int32 Index = INDEX_NONE;

    if (FreeIndices.Num() > 0)
    {
        Index = FreeIndices.Pop(EAllowShrinking::No);  // Reuse freed slot
    }
    else
    {
        Index = Pool.Add(FStatusInstance());            // Expand pool
    }

    ActiveIndices.Add(Index);
    return &Pool[Index];
}
```

**Complexity:** O(1) amortized.

**Flow:**

```
Acquire()
  │
  ├─ Free list non-empty?
  │    ├─ YES → Pop index from FreeIndices
  │    └─ NO  → Append new FStatusInstance to Pool
  │
  ├─ Add index to ActiveIndices
  └─ Return pointer to Pool[Index]
```

The returned instance is not yet initialized — the caller (`RegisterAsActiveInstance()`) calls `InitializeFromContext()` on it.

### Release

Returns an instance to the pool for future reuse:

```cpp
void Release(FStatusInstance* Instance)
{
    if (!Instance) return;

    int32 Index = StatusIDToIndex.Find(Instance->StatusID);
    if (Index != INDEX_NONE)
    {
        CleanupInstance(Instance, Index);
    }
}
```

**Complexity:** O(1) for lookup + O(1) amortized for cleanup.

---

## Registration & Indexing

After an instance is acquired and initialized, it must be registered in the lookup maps.

### RegisterStatusID

```cpp
void RegisterStatusID(FStatusInstance* Instance)
{
    int32 Index = GetIndexOf(Instance);  // Pointer arithmetic
    StatusIDToIndex.Add(Instance->StatusID, Index);
}
```

**GetIndexOf** uses pointer arithmetic for O(1) index calculation:

```cpp
int32 GetIndexOf(const FStatusInstance* Instance) const
{
    const FStatusInstance* PoolStart = Pool.GetData();
    // Instance must be within pool memory range
    return static_cast<int32>(Instance - PoolStart);
}
```

### RegisterTag / UnregisterTag

```cpp
void RegisterTag(FStatusInstance* Instance)
{
    TagToStatusIDs.FindOrAdd(Instance->StatusTag).AddUnique(Instance->StatusID);
}

void UnregisterTag(FStatusInstance* Instance)
{
    if (TArray<int64>* StatusIDs = TagToStatusIDs.Find(Instance->StatusTag))
    {
        StatusIDs->Remove(Instance->StatusID);
        if (StatusIDs->Num() == 0)
            TagToStatusIDs.Remove(Instance->StatusTag);  // Cleanup empty entry
    }
}
```

---

## Scheduling — Min-Heap Model

The pool uses a **min-heap** to schedule periodic tick execution. This avoids iterating all instances every frame — only those with `NextExecutionTime ≤ GlobalTime` are processed.

### Data Structures

```cpp
float GlobalTime = 0.f;                           // Advances each frame
TArray<TPair<float, int64>> ScheduledHeap;         // Min-heap: (NextExecutionTime, StatusID)
TSet<int64> ScheduledSet;                          // O(1) membership check
bool bHeapDirty = false;                           // Needs re-sort flag
```

### Heap Entry

Each entry is a `TPair<float, int64>`:
- **Key** (`float`): `NextExecutionTime` — cached for O(1) comparison during heapify
- **Value** (`int64`): `StatusID` — used to resolve the actual instance

### ScheduleInstance

Adds an instance to the scheduled heap:

```cpp
void ScheduleInstance(int64 StatusID, float InitialDelay = -1.f)
{
    FStatusInstance* Instance = FindByStatusID(StatusID);
    if (!Instance || !Instance->IsActive()) return;
    if (Instance->TickInterval <= 0.f) return;  // Not periodic

    float Delay = (InitialDelay >= 0.f) ? InitialDelay : Instance->TickInterval;
    Instance->NextExecutionTime = GlobalTime + Delay;

    if (ScheduledSet.Contains(StatusID))
    {
        bHeapDirty = true;  // Already scheduled, mark for re-sort
        return;
    }

    ScheduledSet.Add(StatusID);
    ScheduledHeap.HeapPush({Instance->NextExecutionTime, StatusID}, FHeapPredicate());
}
```

### UnscheduleInstance

Removes an instance from the heap:

```cpp
void UnscheduleInstance(int64 StatusID)
{
    if (!ScheduledSet.Contains(StatusID)) return;

    ScheduledSet.Remove(StatusID);
    // Find by StatusID (Value field) and remove
    int32 Index = ScheduledHeap.IndexOfByPredicate(...);
    if (Index != INDEX_NONE)
    {
        ScheduledHeap.RemoveAtSwap(Index, EAllowShrinking::No);
        bHeapDirty = true;
    }
}
```

### PopReadyInstances

The primary frame-by-frame API. Pops all instances whose time has come:

```cpp
int32 PopReadyInstances(TArray<int64>& OutReadyStatusIDs, int32 MaxCount = 100)
```

**Algorithm:**

```
PopReadyInstances(Out, MaxCount)
  │
  ├─ If bHeapDirty → RebuildHeap()
  │
  └─ While heap non-empty AND Out.Num() < MaxCount:
       │
       ├─ Peek top entry: (NextExecutionTime, StatusID)
       │
       ├─ NextExecutionTime > GlobalTime?
       │    └─ BREAK (heap sorted, no more ready instances)
       │
       ├─ Instance invalid or not active?
       │    └─ Discard entry, remove from set, continue
       │
       └─ Instance ready:
            ├─ Add StatusID to Out
            ├─ HeapPop entry
            └─ Remove from ScheduledSet
```

**Complexity:** O(k log n) where k = number of ready instances, n = heap size.

**Safety:** `MaxCount` parameter (default: 100) prevents runaway execution in extreme cases.

### RescheduleAfterExecution

Called after a status tick to schedule the next execution:

```cpp
void RescheduleAfterExecution(FStatusInstance* Instance)
```

Two scheduling modes based on drift compensation:

| Mode | Formula | Behavior |
|---|---|---|
| **Simple** (default) | `NextExecution = GlobalTime + TickInterval` | Next tick is relative to NOW. Simple, may drift |
| **Compensated** | `NextExecution += TickInterval` | Next tick is relative to scheduled time. Precise, no drift |

### RebuildHeap

Called when `bHeapDirty` is true (after external modifications to scheduled entries):

```cpp
void RebuildHeap()
{
    // Remove stale entries (invalid or non-active instances)
    // Sync cached NextExecutionTime with instance values
    // Rebuild heap ordering via Heapify()
    bHeapDirty = false;
}
```

---

## Time Drift Compensation

### The Problem

With simple scheduling (`NextExecution = Now + Interval`), accumulated frame-time variance causes gradual drift:

```
Interval = 1.0s
Frame 1: Executes at 1.02 → Next = 2.02
Frame 2: Executes at 2.05 → Next = 3.05  (drifting: +0.05)
Frame 3: Executes at 3.07 → Next = 4.07  (drifting: +0.07)
...
After 1000 ticks: ~70ms cumulative drift
```

### The Solution

With drift compensation enabled, `NextExecutionTime` advances by exact intervals:

```
Interval = 1.0s
Frame 1: Executes at 1.02 → Next = 1.00 + 1.00 = 2.00
Frame 2: Executes at 2.05 → Next = 2.00 + 1.00 = 3.00
Frame 3: Executes at 3.07 → Next = 3.00 + 1.00 = 4.00
...
After 1000 ticks: 0ms cumulative drift
```

### Safety Guard

If the instance falls too far behind (e.g., after a pause or extreme hitch), the safety guard prevents infinite catch-up loops:

```cpp
if (Instance->NextExecutionTime < GlobalTime - Instance->TickInterval)
{
    Instance->NextExecutionTime = GlobalTime + Instance->TickInterval;
}
```

### Configuration

```cpp
// Enable/disable at pool level
pool->SetCompensateTimeDrifting(true);

// Or via WorldSubsystem (propagates to pool)
WorldSubsystem->SetCompensateTimeDrifting(true);
```

---

## Query API

### FindByStatusID

O(1) instance lookup by unique identifier.

```cpp
FStatusInstance* FindByStatusID(int64 StatusID);
```

Returns `nullptr` if not found.

### GetByIndex

Direct pool index access.

```cpp
FStatusInstance* GetByIndex(int32 Index);
```

Returns `nullptr` if index is out of bounds.

### GetIndexOf

Pointer-arithmetic index calculation (no map lookup).

```cpp
int32 GetIndexOf(const FStatusInstance* Instance) const;
```

### GetActiveCount

```cpp
int32 GetActiveCount() const { return ActiveIndices.Num(); }
```

---

## Tag-Based Query API

All tag-based queries use the `TagToStatusIDs` map for O(1) lookup.

### GetStatusIDsByTag

Returns a const pointer to the StatusID array for a tag. `nullptr` if no instances have that tag.

```cpp
const TArray<int64>* GetStatusIDsByTag(const FGameplayTag& StatusTag) const;
```

### CountByTag

```cpp
int32 CountByTag(const FGameplayTag& StatusTag) const;
```

### HasStatusWithTag

```cpp
bool HasStatusWithTag(const FGameplayTag& StatusTag) const;
```

### ForEachByTag

Template-based safe iteration. Copies the StatusID array to allow modification during iteration:

```cpp
template<typename Functor>
void ForEachByTag(const FGameplayTag& StatusTag, Functor Func)
{
    const TArray<int64>* StatusIDs = TagToStatusIDs.Find(StatusTag);
    if (!StatusIDs) return;

    TArray<int64> StatusIDsCopy = *StatusIDs;  // Safe copy
    for (int64 StatusID : StatusIDsCopy)
    {
        if (FStatusInstance* Instance = FindByStatusID(StatusID))
        {
            if (Instance->IsActive())
            {
                Func(*Instance);
            }
        }
    }
}
```

### RemoveAllByTag

Terminates all instances with a given tag. Flows through `WorldSubsystem::TerminateInstance()` for proper lifecycle cleanup.

```cpp
int32 RemoveAllByTag(const FGameplayTag& StatusTag, TArray<int64>& OutRemovedIDs);
```

### RefreshByTag

Refreshes duration window for all instances with a given tag without altering tick cadence or iteration progress.

```cpp
int32 RefreshByTag(const FGameplayTag& StatusTag);
```

---

## Iteration API

### IterateActive

Iterates all active instances with a predicate. The predicate returns `true` to remove the instance.

```cpp
void IterateActive(TFunctionRef<bool(FStatusInstance&)> Predicate)
{
    // Backward iteration for safe removal during iteration
    for (int32 i = ActiveIndices.Num() - 1; i >= 0; --i)
    {
        FStatusInstance& Instance = Pool[ActiveIndices[i]];
        if (Predicate(Instance))
        {
            CleanupInstance(&Instance, ActiveIndices[i]);
        }
    }
}
```

**Use cases:**
- World teardown cleanup
- Removing all instances matching complex criteria
- Duration expiry checks

---

## Cleanup Pipeline

When an instance is released, `CleanupInstance` handles all bookkeeping:

```
CleanupInstance(Instance, PoolIndex)
  │
  ├─ UnregisterTag(Instance)         ← remove from TagToStatusIDs
  ├─ UnscheduleInstance(StatusID)    ← remove from heap + set
  ├─ StatusIDToIndex.Remove(ID)     ← remove from ID lookup map
  ├─ ActiveIndices.RemoveSingleSwap(PoolIndex)  ← move from active list
  ├─ FreeIndices.Add(PoolIndex)     ← add to free list
  ├─ Instance->State = Inactive
  └─ Instance->StatusID = 0
```

**Note:** `CleanupInstance` does **not** call `Instance->Reset()` — the full reset happens at the WorldSubsystem level before release. CleanupInstance handles only pool-level bookkeeping.

---

## Ownership & Integration

### WorldSubsystem Integration

```
UStatsX_WorldSubsystem
  │
  ├─ Owns: TSharedPtr<FStatusInstancePool> InstancePool
  │
  ├─ Initialize():
  │    └─ InstancePool = MakeShared<FStatusInstancePool>(256)
  │
  ├─ Tick(DeltaTime):
  │    ├─ InstancePool->AdvanceTime(DeltaTime)
  │    ├─ InstancePool->PopReadyInstances(ReadyIDs)
  │    │    └─ For each ready ID: ForgeVM::ResumeInstance()
  │    └─ InstancePool->IterateActive(...)  ← duration/timing checks
  │
  ├─ RegisterAsActiveInstance():
  │    ├─ Instance = InstancePool->Acquire()
  │    ├─ Instance->InitializeFromContext()
  │    ├─ InstancePool->RegisterStatusID(Instance)
  │    ├─ InstancePool->RegisterTag(Instance)
  │    └─ InstancePool->ScheduleInstance(StatusID)
  │
  └─ UnregisterInstance(PoolIndex):
       ├─ Cleanup (modifiers, interceptors, tags, listeners)
       └─ InstancePool->Release(Instance)
```

### Lifetime

- Created in `UStatsX_WorldSubsystem::Initialize()`
- Destroyed in `UStatsX_WorldSubsystem::Deinitialize()`
- Reset on world teardown via `InstancePool->Reset()`

---

## Performance Characteristics

| Operation | Complexity | Notes |
|---|---|---|
| `Acquire()` | O(1) amortized | Free list pop or array append |
| `Release()` | O(1) amortized | Map lookup + cleanup |
| `FindByStatusID()` | O(1) | `TMap` lookup |
| `GetByIndex()` | O(1) | Direct array access |
| `GetIndexOf()` | O(1) | Pointer arithmetic |
| `RegisterStatusID()` | O(1) | Map insert |
| `RegisterTag()` | O(1) amortized | Map find-or-add + AddUnique |
| `UnregisterTag()` | O(k) | k = instances with same tag (array removal) |
| `ScheduleInstance()` | O(log n) | Heap push |
| `UnscheduleInstance()` | O(n) | Linear search in heap + RemoveAtSwap + dirty flag |
| `PopReadyInstances()` | O(k log n) | k = ready instances popped |
| `RescheduleAfterExecution()` | O(log n) | Heap push |
| `RebuildHeap()` | O(n) | Full heapify (only when dirty) |
| `CountByTag()` | O(1) | Map lookup + array size |
| `HasStatusWithTag()` | O(1) | Map lookup |
| `ForEachByTag()` | O(k) | k = instances with that tag (copies array for safe mutation) |
| `IterateActive()` | O(n) | n = active instances |
| `RemoveAllByTag()` | O(k) | k = instances with that tag |
| `RefreshByTag()` | O(k) | k = instances with that tag |
| `AdvanceTime()` | O(1) | Float increment |

### Memory

- **Pool:** `256 × sizeof(FStatusInstance)` initial reservation (expandable)
- **Heap:** `256 × sizeof(TPair<float, int64>)` = 256 × 16 bytes = 4 KB initial
- **Maps:** Proportional to active instance count

---

## Best Practices

### 1. Trust the Initial Capacity

The default 256-instance reservation covers most gameplay scenarios. The pool auto-expands when exceeded. Increase `InitialCapacity` only if profiling shows frequent reallocation in your specific use case.

### 2. Use Tag Queries for Bulk Operations

Instead of iterating all instances, use the tag-based API:

```cpp
// Fast: O(1) lookup
if (Pool->HasStatusWithTag(PoisonTag))
{
    Pool->ForEachByTag(PoisonTag, [](FStatusInstance& Instance)
    {
        // Process only poison instances
    });
}
```

### 3. Enable Drift Compensation for Long-Running Effects

For effects that tick over long periods (minutes or hours), enable drift compensation to maintain precise intervals:

```cpp
WorldSubsystem->SetCompensateTimeDrifting(true);
```

### 4. Respect MaxCount in PopReadyInstances

The `MaxCount` parameter (default 100) prevents frame spikes when many instances become ready simultaneously (e.g., after a pause). The WorldSubsystem's `MaxExecutionsPerFrame` provides an additional safety layer.

### 5. Use ForEachByTag for Safe Mutation

`ForEachByTag` copies the StatusID array before iteration, making it safe to add/remove instances during the callback. This is the preferred pattern for operations that may modify the pool during iteration.
