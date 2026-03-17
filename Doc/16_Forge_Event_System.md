# 16 — Forge Event System

> **Stats_X v1.404** — SendForgeEvent, WaitForEvent, RegisterEventListener, ProcessPendingEventResumes
> Named event dispatch with scope filtering, typed payload delivery, trigger budgets,
> timeout expiry, and deterministic next-tick resume ordering.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Structures](#3-data-structures)
4. [Listener Registration](#4-listener-registration)
5. [Event Dispatch — SendForgeEvent](#5-event-dispatch--sendforgeevent)
6. [OP_WaitForEvent Handler](#6-op_waitforevent-handler)
7. [OP_WaitForEvents Handler](#7-op_waitforevents-handler)
8. [OP_SendEvent Handler](#8-op_sendevent-handler)
9. [OP_OnEventTriggered / OP_EndAsyncEvent](#9-op_oneventtriggered--op_endasyncevent)
10. [ProcessPendingEventResumes](#10-processppendingeventresumes)
11. [Payload Delivery](#11-payload-delivery)
12. [Trigger Budget Management](#12-trigger-budget-management)
13. [Timeout Expiry System](#13-timeout-expiry-system)
14. [Auto-Termination](#14-auto-termination)
15. [Tick Integration](#15-tick-integration)
16. [Scope Filtering Semantics](#16-scope-filtering-semantics)
17. [API Reference](#17-api-reference)

---

## 1. Design Philosophy

The Forge Event System enables **status-to-status and gameplay-to-status communication** through named, scope-filtered events with typed variable payloads.

| Decision | Rationale |
|----------|-----------|
| **Named events via GameplayTag** | Loose coupling — sender doesn't need to know listeners, only the event tag |
| **Scope filtering by actor** | Target-specific events (e.g., "only fire events affecting this character") |
| **Next-tick resume** | Deterministic FIFO ordering — events queued this frame, handlers run next frame |
| **Shared payload** | `TSharedPtr<TArray<FForgeVariableOverride>>` — one allocation shared across all resumed listeners |
| **Trigger budget** | `MaxTriggersRemaining` — finite or infinite, auto-remove when exhausted |
| **Timeout expiry** | Min-heap with lazy invalidation — O(1) per frame when nothing expires |
| **Auto-termination** | Suspended instances with no remaining listeners/async ops are terminated automatically |

---

## 2. Architecture Overview

```
                    ┌────────────────────────────────┐
                    │         Event Sender            │
                    │  (OP_SendEvent / BP / C++)      │
                    └────────────┬───────────────────┘
                                 │
                    SendForgeEvent(EventTag, ScopeActor, Payload)
                                 │
                    ┌────────────▼───────────────────┐
                    │     UStatsX_WorldSubsystem      │
                    │                                 │
                    │  EventListenersByTag             │
                    │  ┌─────────────────────────┐    │
                    │  │ "OnDamage" → [L1, L2]   │    │
                    │  │ "OnHeal"   → [L3]       │    │
                    │  └─────────────────────────┘    │
                    │                                 │
                    │  Scope filter → Queue resume    │
                    └────────────┬───────────────────┘
                                 │
                    PendingEventResumes (FIFO queue)
                                 │
                    ┌────────────▼───────────────────┐
                    │    Next Tick: ProcessPending     │
                    │                                 │
                    │  1. ApplyEventPayloadToInstance  │
                    │  2. ExecuteInstance(ResumePC)    │
                    │  3. Handler → OP_EndAsyncEvent   │
                    │     └─ Re-arm + re-suspend      │
                    └─────────────────────────────────┘
```

---

## 3. Data Structures

```
Source  : Public/Core/StatsX_WorldSubsystem.h (lines 506–575)
```

### FForgeEventListener

```cpp
struct FForgeEventListener
{
    int64 ListenerID = 0;               // Unique monotonic ID
    int64 StatusID = 0;                 // Status instance waiting for this event
    int32 ResumePC = 0;                 // PC to resume at when event fires
    TWeakObjectPtr<AActor> ScopeActor;  // Actor scope filter (nullptr = global)
    int32 MaxTriggersRemaining = -1;    // <0=infinite, >0=count, 0=exhausted
    float MaxWaitingTime = -1.0f;       // <0=infinite, >=0=timeout in seconds
    double RegistrationWorldTime = 0.0; // World time at registration
};
```

### FForgeEventListenerLocation

```cpp
struct FForgeEventListenerLocation
{
    FGameplayTag EventTag;     // Which event tag this listener is under
    int32 Index = INDEX_NONE;  // Index within EventListenersByTag[EventTag]
};
```

Enables O(1) removal: given a ListenerID, find its array position without scanning.

### FForgeQueuedEventResume

```cpp
struct FForgeQueuedEventResume
{
    int64 StatusID = 0;
    int32 ResumePC = 0;
    TSharedPtr<TArray<FForgeVariableOverride>, ESPMode::ThreadSafe> SharedPayload;
};
```

### FListenerExpiryEntry

```cpp
struct FListenerExpiryEntry
{
    double ExpiryTime;    // RegistrationWorldTime + MaxWaitingTime
    int64  ListenerID;    // For lazy invalidation
    bool operator<(const FListenerExpiryEntry& Other) const
    {
        return ExpiryTime < Other.ExpiryTime;
    }
};
```

### Indexing Maps (Three-Map System)

| Map | Type | Purpose | Complexity |
|-----|------|---------|------------|
| `EventListenersByTag` | `TMap<FGameplayTag, TArray<FForgeEventListener>>` | Primary storage: event tag → listeners | O(1) lookup by tag |
| `ListenerIDsByStatusID` | `TMap<int64, TArray<int64>>` | Reverse index: status → its listener IDs | O(k) cleanup on status removal |
| `ListenerLocationByID` | `TMap<int64, FForgeEventListenerLocation>` | Position index: listener → tag + array index | O(1) removal by ID |

### Additional State

| Field | Type | Purpose |
|-------|------|---------|
| `PendingEventResumes` | `TArray<FForgeQueuedEventResume>` | FIFO resume queue consumed next tick |
| `PendingAsyncResumes` | `TArray<FForgeQueuedAsyncResume>` | Montage/callback resumes (processed first) |
| `ListenerExpiryHeap` | `TArray<FListenerExpiryEntry>` | Min-heap for timeout management |
| `NextEventListenerID` | `int64` | Monotonic allocator (0 = reserved invalid) |

---

## 4. Listener Registration

```
Source  : Private/Core/StatsX_WorldSubsystem.cpp (lines 2951–3029)
```

```cpp
void RegisterEventListener(
    const FGameplayTag& EventTag,
    int64 StatusID,
    int32 ResumePC,
    AActor* ScopeActor,
    int32 MaxTriggers = -1,
    float MaxWaitingTime = -1.0f);
```

### Registration Flow

```
RegisterEventListener(EventTag, StatusID, ResumePC, ScopeActor, MaxTriggers, MaxWaitingTime)
│
├─ Guard: EventTag valid, StatusID != 0
├─ Guard: MaxTriggers == 0 → skip (disabled)
│
├─ Deduplication check:
│   ├─ Find existing listeners for this StatusID
│   └─ If same EventTag + ResumePC + ScopeActor already registered → return
│
├─ Allocate monotonic ListenerID (skip collisions)
│
├─ Add to EventListenersByTag[EventTag]
│   └─ FForgeEventListener with all fields populated
│
├─ Add to ListenerLocationByID[ListenerID]
│   └─ FForgeEventListenerLocation{EventTag, ArrayIndex}
│
├─ Add to ListenerIDsByStatusID[StatusID]
│   └─ Append ListenerID
│
└─ If MaxWaitingTime >= 0:
    └─ Push FListenerExpiryEntry to ListenerExpiryHeap (O(log N))
```

### Deduplication

The system prevents duplicate listeners for the exact same (EventTag, ResumePC, ScopeActor) combination on a given StatusID. This guards against re-entry scenarios where `OP_WaitForEvent` might fire twice for the same node.

---

## 5. Event Dispatch — SendForgeEvent

```
Source  : Private/Core/StatsX_WorldSubsystem.cpp (lines 3052–3151)
```

```cpp
int32 SendForgeEvent(
    FGameplayTag EventTag,
    AActor* ScopeActor,
    const TArray<FForgeVariableOverride>& Payload);
```

### Dispatch Flow

```
SendForgeEvent(EventTag, ScopeActor, Payload)
│
├─ Guard: EventTag valid
├─ Find ListenerArray = EventListenersByTag[EventTag]
│   └─ Empty or missing → return 0
│
├─ Create SharedPayload (TSharedPtr, one allocation for all listeners)
│   └─ Only allocated if Payload is non-empty
│
├─ For each Listener in ListenerArray:
│   │
│   ├─ Scope filter: if ScopeActor && Listener.ScopeActor != ScopeActor → skip
│   │
│   ├─ Validate instance: FindByStatusID → must exist and be active
│   │   └─ Dead/inactive → mark for removal
│   │
│   ├─ QueueEventResume(StatusID, ResumePC, SharedPayload)
│   │   └─ Appends to PendingEventResumes (processed next tick)
│   │
│   ├─ Budget: decrement MaxTriggersRemaining
│   │   ├─ Was >0, now 0 → mark for removal
│   │   ├─ Already 0 → mark for removal (defensive)
│   │   └─ <0 → infinite, keep
│   │
│   └─ ++ResumedCount
│
├─ Collect AffectedStatusIDs from listeners marked for removal
├─ RemoveEventListenerByID for each marked listener
├─ AutoTerminateIfEmpty for each affected StatusID
│
└─ return ResumedCount
```

### Shared Payload Optimization

```cpp
TSharedPtr<TArray<FForgeVariableOverride>, ESPMode::ThreadSafe> SharedPayload;
if (!Payload.IsEmpty())
{
    SharedPayload = MakeShared<TArray<FForgeVariableOverride>, ESPMode::ThreadSafe>(Payload);
}
```

One copy of the payload is shared across all queued resumes from the same `SendForgeEvent` call. Thread-safe reference counting ensures the payload survives until all listeners have consumed it.

---

## 6. OP_WaitForEvent Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (lines 2248–2405)
OpCode  : 330
```

### Instruction Layout

```
Data0[24-39]:  ArrayHeaderIdx (16 bits) → Pool_ArraysHeaders
Data0[40-57]:  Event Tag (18-bit data operand → FGameplayTag)

ArrayHeader branches (via Pool_Ints):
  Index 0: ImmediatePC  — "" (immediate flow, executes once then suspends)
  Index 1: TriggeredPC  — "Event Triggered" (resume point when event fires)
```

### Execution Flow

```
OP_WaitForEvent(Context, Instr)
│
├─ Read ArrayHeaderIdx → resolve ImmediatePC and TriggeredPC from Pool_Ints
├─ Read EventTag from instruction
│
├─ Ensure active instance (RegisterAsActiveInstance if needed)
│
├─ Re-entry check: HasActiveListenersForStatusID?
│   └─ Yes → re-suspend (don't register duplicate listener)
│
├─ Resolve ScopeActor: TargetActor first, then CasterActor
│
├─ RegisterEventListener(EventTag, StatusID, TriggeredPC, ScopeActor)
│
├─ Set instance state:
│   ├─ SavedPC = CurrentNodeIdx (if not owned by another async node)
│   ├─ SuspendTimer = BIG_NUMBER (infinite)
│   ├─ Duration = -1.0f
│   ├─ State = Suspended
│   └─ SetWaitingForAsyncEvents(true)
│
├─ Context.PC = ImmediatePC (execute immediate branch NOW)
│
└─ return Continue (not Suspended — immediate branch runs first)
```

**Key insight:** The handler returns `Continue`, not `Suspended`. The immediate branch executes in the same frame. The instance is already marked as Suspended, so when the immediate branch's `OP_EndEventBlock` returns, the VM exits with Completed/Suspended and the instance stays in the pool waiting for the event.

---

## 7. OP_WaitForEvents Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (lines 2407–2607)
OpCode  : 371
```

Multi-event variant that registers listeners for **multiple events** from a compiled tag list, each with its own handler PC, trigger count, and timeout.

### ArrayHeader Layout (via Pool_Ints)

```
[Start+0]:  ImmediatePC
[Start+1]:  OnCompletedPC (reserved)
[Start+2]:  TagPoolIdx_0
[Start+3]:  HandlerPC_0
[Start+4]:  MaxTriggers_0
[Start+5]:  MaxWaitBits_0
[Start+6]:  TagPoolIdx_1
[Start+7]:  HandlerPC_1
...
NumEvents = (Header.Count - 2) / 4
```

Each event entry has a stride of 4: TagPoolIdx, HandlerPC, MaxTriggers, MaxWaitBits.

### Key Differences from WaitForEvent

| Feature | WaitForEvent | WaitForEvents |
|---------|-------------|---------------|
| Events | Single | Multiple (compiled list) |
| Per-event triggers | Infinite only | Configurable per event |
| Per-event timeout | None | Configurable per event |
| Nested mode | No | Yes (works inside behavior nodes) |

---

## 8. OP_SendEvent Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (lines 5007–5203)
OpCode  : 325
```

### Instruction Layout

```
Data0[24-41]:  Event Tag (18-bit → FGameplayTag)
Data0[42-59]:  Scope Actor (18-bit → UObject*, cast to AActor*)
Data1[0-15]:   ResumedCount output offset (16 bits)
Data1[16-23]:  Payload override count (8 bits)

Continuation instructions (1 per override entry):
  ContInstr.Data0[0-17]:   Variable Tag (18-bit → FGameplayTag)
  ContInstr.Data0[18-25]:  FieldType (8 bits)
  ContInstr.Data0[26+]:    Type-specific value (via ReadValue)
```

### Payload Construction

For each override, a continuation instruction encodes:

| FieldType | Value | Read From |
|-----------|-------|-----------|
| 1 (Float) | `ReadValue<float>(Cont, 0, 26)` | Raw bytes |
| 2 (Int32) | `ReadValue<int32>(Cont, 0, 26)` | Raw bytes |
| 3 (Bool) | `ReadValue<bool>(Cont, 0, 26)` → `uint8` | Raw bytes |
| 4 (GameplayTag) | `ReadValue<FGameplayTag>(Cont, 0, 26)` | Raw bytes |
| 5 (Object) | `ReadValue<UObject*>(Cont, 1, 0)` | Object override |
| 8 (Class) | `ReadValue<UClass*>(Cont, 1, 0)` | Object override |
| 9 (Name) | `ReadValue<FName>(Cont, 0, 26)` | Raw bytes |
| 11 (Byte) | `ReadValue<uint8>(Cont, 0, 26)` | Raw bytes |
| 12 (Int64) | `ReadValue<int64>(Cont, 0, 26)` | Raw bytes |
| 13 (Double) | `ReadValue<double>(Cont, 0, 26)` | Raw bytes |
| 14 (Vector) | `ReadValue<FVector>(Cont, 0, 26)` | Raw bytes |
| 15 (Rotator) | `ReadValue<FRotator>(Cont, 0, 26)` | Raw bytes |
| 16 (Transform) | `ReadValue<FTransform>(Cont, 0, 26)` | Raw bytes |
| 17 (LinearColor) | `ReadValue<FLinearColor>(Cont, 0, 26)` | Raw bytes |

Payload overrides are built as `TArray<FForgeVariableOverride>` (same struct as Variable Overrides) and passed to `SendForgeEvent()`.

### Execution Flow

```
OP_SendEvent(Context, Instr)
│
├─ Read EventTag, ScopeActor
├─ Read OverrideCount from Data1[16..23]
├─ Build Payload[] from continuation instructions
├─ Subsystem->SendForgeEvent(EventTag, ScopeActor, Payload)
├─ WriteOutput<int32>(OutputOffset, ResumedCount)
├─ Skip continuation slots
└─ return Continue
```

---

## 9. OP_OnEventTriggered / OP_EndAsyncEvent

### OP_OnEventTriggered (OpCode 372)

A **no-op marker** that serves as the entry point for compiled event handler blocks:

```cpp
Registry.RegisterHandler(ForgeOpCodes::OP_OnEventTriggered,
    [](FForgeVMContext& Context, const FStatusInstruction&) -> EForgeExecutionResult
    {
        return EForgeExecutionResult::Continue;
    });
```

The actual event handler logic is the bytecode between `OP_OnEventTriggered` and `OP_EndAsyncEvent`.

### OP_EndAsyncEvent (System OpCode 11)

```
Source  : Private/VM/ForgeVM.cpp (lines 1256–1269)
```

Terminates an async event handler block:

```cpp
case OP_EndAsyncEvent:
{
    if (GlobalContext.Instance)
    {
        GlobalContext.Instance->State = EStatusInstanceState::Suspended;
        GlobalContext.Instance->SetWaitingForAsyncEvents(true);
    }
    return EForgeExecutionResult::Suspended;
}
```

**Critical invariant:** `OP_EndAsyncEvent` does **NOT** modify `SavedPC` or `SuspendTimer`. Event handlers execute as "interrupts" via `OverridePC` — they must not corrupt the primary async node's persistent state. This ensures timer-based nodes (Delay, LoopBehavior) continue their countdowns undisturbed after event handler completion.

---

## 10. ProcessPendingEventResumes

```
Source  : Private/Core/StatsX_WorldSubsystem.cpp (lines 2807–2867)
```

### Processing Flow

```
ProcessPendingEventResumes()
│
├─ Guard: InstancePool exists, PendingEventResumes non-empty
│
├─ Move PendingEventResumes to LocalQueue (MoveTemp)
│   └─ Any events queued during handler execution → next tick
│
├─ For each FForgeQueuedEventResume in LocalQueue:
│   │
│   ├─ Find instance by StatusID → must exist and be active
│   │
│   ├─ Check IsWaitingForAsyncEvents() → must be true
│   │   └─ False → skip (handler suspended for another reason)
│   │
│   ├─ Save PreState = Instance->State
│   │
│   ├─ Clear bWaitingForAsyncEvents flag
│   │
│   ├─ Apply payload: ApplyEventPayloadToInstance(*Instance, *SharedPayload)
│   │
│   ├─ Set Instance->State = Active
│   │
│   ├─ ExecuteInstance(*Instance, PendingResume.ResumePC)
│   │   └─ Handler runs from TriggeredPC → ... → OP_EndAsyncEvent
│   │
│   └─ If handler completed normally (IsWaitingForAsyncEvents re-armed):
│       └─ Restore Instance->State = PreState
│
└─ Done
```

### Key Behaviors

| Behavior | Detail |
|----------|--------|
| **FIFO ordering** | Events processed in the order they were queued |
| **One-frame isolation** | LocalQueue = MoveTemp — new events during handler go to next tick |
| **State preservation** | PreState saved/restored to not disturb behavior node scheduling |
| **Flag gating** | `IsWaitingForAsyncEvents()` checked per resume — if handler suspended (e.g., Delay), remaining events for that StatusID are deferred |

---

## 11. Payload Delivery

```
Source  : Private/Core/StatsX_WorldSubsystem.cpp (lines 3282–3360)
```

```cpp
void ApplyEventPayloadToInstance(FStatusInstance& Instance,
    const TArray<FForgeVariableOverride>& Payload);
```

### Application Rules

For each `FForgeVariableOverride` in the payload:

| Variable Type | Handling |
|---------------|----------|
| **Object / Class** (Single) | `Instance.AllocObject(ObjectValue)` → write `uint16` index to blob |
| **Array / Set** | **Skipped** — handle indirection makes raw override unsafe |
| **GameplayTagContainer** | Size validated: `2 ≤ RawSize ≤ ExpectedSize` (variable count) |
| **Scalar** | Size validated: `RawSize == ExpectedSize`, then `Memcpy` to blob |

Payload is applied to `Instance->VariableBlob` directly (not the context blob), ensuring the handler reads fresh values immediately.

---

## 12. Trigger Budget Management

### MaxTriggersRemaining Semantics

| Value | Meaning | Behavior on Event |
|-------|---------|-------------------|
| < 0 | Infinite | Never removed by budget |
| 0 | Exhausted/Disabled | Skipped in registration, removed if encountered |
| > 0 | Finite count | Decremented each trigger, removed when 0 |

### Budget Decrement in SendForgeEvent

```cpp
if (Listener.MaxTriggersRemaining > 0)
{
    --Listener.MaxTriggersRemaining;
    if (Listener.MaxTriggersRemaining == 0)
        ListenerIDsToRemove.Add(Listener.ListenerID);
}
else if (Listener.MaxTriggersRemaining == 0)
{
    ListenerIDsToRemove.Add(Listener.ListenerID);  // Defensive
}
// else: < 0 = infinite, keep
```

After removal, `AutoTerminateIfEmpty` checks whether the instance should be terminated.

---

## 13. Timeout Expiry System

```
Source  : Private/Core/StatsX_WorldSubsystem.cpp (lines 3153–3191)
```

### Min-Heap Architecture

```
ListenerExpiryHeap (sorted by ExpiryTime ascending)
┌──────────────────────────────────────────────┐
│ [ExpiryTime=10.5, ID=42] [ET=12.0, ID=99].. │
│           ▲                                  │
│      Heap top (earliest expiry)              │
└──────────────────────────────────────────────┘
```

### DrainExpiredListeners (Per-Tick)

```
DrainExpiredListeners()
│
├─ Guard: heap non-empty
├─ Now = GetWorld()->GetTimeSeconds()
│
├─ While heap top ExpiryTime <= Now:
│   ├─ HeapPop entry
│   ├─ Lazy invalidation: ListenerLocationByID.Find(ListenerID)
│   │   └─ Not found → listener already removed, skip
│   ├─ Collect AffectedStatusID
│   ├─ RemoveEventListenerByID(ListenerID)
│   └─ AutoTerminateIfEmpty(AffectedStatusID)
│
└─ Done
```

| Complexity | Scenario |
|------------|----------|
| O(1) | Nothing expired (heap top > Now) |
| O(K log N) | K listeners expired (K pops from N-sized heap) |

**Lazy invalidation:** Expired heap entries may reference listeners already removed by `SendForgeEvent` or status termination. The location map check catches these stale entries.

---

## 14. Auto-Termination

```
Source  : Private/Core/StatsX_WorldSubsystem.cpp (lines 3193–3280)
```

```cpp
void AutoTerminateIfEmpty(int64 StatusID);
```

Called after listener removal to check if a suspended instance has **no remaining reason to stay alive**.

### Guard Checks (Do NOT Terminate If Any Pass)

| # | Guard | Reason |
|---|-------|--------|
| 1 | Listeners remain in `ListenerIDsByStatusID` | Still waiting for events |
| 2 | Pending async resume queued (montage signal) | Montage callback will fire |
| 3 | Active `UForge_MontageCallbackHelper` | Montage still playing |
| 4 | `ActiveCustomLogic != nullptr` | Async custom action in progress |
| 5 | Pending event resume in `PendingEventResumes` | Same-frame SendForgeEvent |
| 6 | `Instance->Duration > 0.f` | Behavior node with finite duration |

### Termination

If all guards pass:

```cpp
bool bExecuteOnEndEvent = ResolveNaturalTerminationOnEndPolicy(Instance->Definition);
if (Instance->bHasPendingOnEndOverride)
    bExecuteOnEndEvent = Instance->bPendingOnEndOverrideValue;

TerminateInstance(*Instance, EStatusTerminateReason::Expired, bExecuteOnEndEvent);
```

The OnEnd event block (if configured) executes before final cleanup.

---

## 15. Tick Integration

```
TickInstances(DeltaTime)
│
├─ STEP 1: DrainExpiredListeners()
│   └─ Remove timed-out listeners, auto-terminate empty instances
│
├─ STEP 2.5a: ProcessPendingAsyncResumes()     ← montage callbacks FIRST
│   └─ Execute queued montage/animation resumes
│
├─ STEP 2.5b: ProcessPendingEventResumes()     ← event resumes SECOND
│   └─ Apply payload, execute event handlers
│
├─ STEP 3: Tick scheduled instances (TickInterval > 0)
│   └─ Multi-exec catch-up from heap
│
├─ STEP 4: Resume suspended instances (SuspendTimer expired)
│   └─ Delay nodes, etc.
│
└─ FlushPendingStatusUpdates()
```

**Critical ordering:** Async resumes (montage callbacks) are processed **before** event resumes. This ensures that montage completion handlers update instance state before event handlers observe it.

---

## 16. Scope Filtering Semantics

### Registration (WaitForEvent)

```cpp
AActor* ScopeActor = Instance->TargetActor.Get();
if (!ScopeActor)
    ScopeActor = Instance->CasterActor.Get();

RegisterEventListener(EventTag, StatusID, TriggeredPC, ScopeActor);
```

Default scope resolution: **Target actor first**, then **Caster actor** as fallback.

### Dispatch (SendForgeEvent)

```cpp
if (ScopeActor && Listener.ScopeActor.Get() != ScopeActor)
    continue;  // Skip non-matching listeners
```

| Sender ScopeActor | Listener ScopeActor | Match? |
|-------------------|---------------------|--------|
| `nullptr` (broadcast) | Any | Yes — all listeners receive |
| `ActorA` | `ActorA` | Yes — exact match |
| `ActorA` | `ActorB` | No — skipped |
| `ActorA` | `nullptr` | No — listener has no scope |

---

## 17. API Reference

### WorldSubsystem — Public

| Function | Signature |
|----------|-----------|
| `RegisterEventListener` | `void RegisterEventListener(const FGameplayTag&, int64 StatusID, int32 ResumePC, AActor* ScopeActor, int32 MaxTriggers = -1, float MaxWaitingTime = -1.0f)` |
| `UnregisterEventListeners` | `void UnregisterEventListeners(int64 StatusID)` |
| `SendForgeEvent` | `int32 SendForgeEvent(FGameplayTag, AActor* ScopeActor, const TArray<FForgeVariableOverride>&)` — BlueprintCallable |
| `HasActiveListenersForStatusID` | `bool HasActiveListenersForStatusID(int64) const` |
| `QueueAsyncResume` | `void QueueAsyncResume(int64 StatusID, int32 ResumePC)` |

### WorldSubsystem — Private

| Function | Purpose |
|----------|---------|
| `ProcessPendingEventResumes` | Consume FIFO queue, apply payload, execute handlers |
| `ProcessPendingAsyncResumes` | Consume montage callback queue |
| `DrainExpiredListeners` | Pop expired entries from min-heap |
| `AutoTerminateIfEmpty` | Terminate instances with no remaining async operations |
| `ApplyEventPayloadToInstance` | Write override payload into instance VariableBlob |
| `RemoveEventListenerByID` | Swap-and-move removal from all three maps |
| `QueueEventResume` | Append to PendingEventResumes |

### Component — Public

| Function | Signature |
|----------|-----------|
| `SendForgeEvent` | `int32 SendForgeEvent(FGameplayTag EventTag, const TArray<FForgeVariableOverride>& Payload)` — BlueprintCallable |

### Blueprint Library — Static

| Function | Signature |
|----------|-----------|
| `SendForgeEvent` | `static int32 SendForgeEvent(const UObject* WorldContextObject, FGameplayTag, AActor* ScopeActor, const TArray<FForgeVariableOverride>&)` — BlueprintCallable |

### OpCode Handlers

| OpCode | Name | Handler |
|--------|------|---------|
| 330 | `OP_WaitForEvent` | `Nodes_Flow::WaitForEvent` |
| 371 | `OP_WaitForEvents` | `Nodes_Flow::WaitForEvents` |
| 325 | `OP_SendEvent` | `Nodes_Action::SendEvent` |
| 372 | `OP_OnEventTriggered` | No-op marker (lambda) |
| 11 | `OP_EndAsyncEvent` | System opcode — re-arm + re-suspend |

### Data Structures

| Struct | Location |
|--------|----------|
| `FForgeEventListener` | `StatsX_WorldSubsystem.h` |
| `FForgeEventListenerLocation` | `StatsX_WorldSubsystem.h` |
| `FForgeQueuedEventResume` | `StatsX_WorldSubsystem.h` |
| `FForgeQueuedAsyncResume` | `StatsX_WorldSubsystem.h` |
| `FListenerExpiryEntry` | `StatsX_WorldSubsystem.h` |

---

*Document generated from source — Stats_X v1.404*
