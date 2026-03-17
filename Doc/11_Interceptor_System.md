# 11 — Interceptor System

> **Stats_X v1.404** — UForgeInterceptorBase, FInterceptorRegistration, BroadcastInterceptorEvents
> Condition / Action pattern for observing and altering status execution at
> any point in the graph — per-caster, per-target, or world-wide.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Core Concepts](#2-core-concepts)
3. [Scopes](#3-scopes)
4. [Phases](#4-phases)
5. [Interceptor Base Class](#5-interceptor-base-class)
6. [Registration Data](#6-registration-data)
7. [Registry Architecture](#7-registry-architecture)
8. [Registration API](#8-registration-api)
9. [Unregistration API](#9-unregistration-api)
10. [Broadcast Pipeline](#10-broadcast-pipeline)
11. [Dispatch Loop](#11-dispatch-loop)
12. [Reentrancy Safety](#12-reentrancy-safety)
13. [Payload System](#13-payload-system)
14. [Variable Access](#14-variable-access)
15. [Context Accessors](#15-context-accessors)
16. [GC Safety](#16-gc-safety)
17. [Performance Instrumentation](#17-performance-instrumentation)
18. [API Reference](#18-api-reference)

---

## 1. Design Philosophy

Interceptors provide an **observer-with-veto** pattern for the ForgeVM execution pipeline. Any node in the StatusForge graph can emit Pre/Post events; registered interceptors receive those events, inspect (and optionally modify) the execution context, and may **halt** the entire status execution.

| Decision | Rationale |
|----------|-----------|
| **Condition/Action split** | Separate filter pass from effect pass — Condition never mutates state, Action may write and halt |
| **Three scopes** | Caster, Target, Global — maps directly to the three perspectives of a status interaction |
| **Priority ordering** | Higher-priority interceptors execute first within a scope |
| **Deferred removal** | Interceptors removed during dispatch are marked pending, flushed after the dispatch loop |
| **Nested-safe** | `TriggerFrameStack` with `TInlineAllocator<4>` supports recursive casts without corruption |
| **UObject-based** | `UForgeInterceptorBase : UObject` — participates in GC, supports Blueprint/C++ subclassing |

---

## 2. Core Concepts

```
StatusForge Graph Node
       │
       ├─── Pre-Event broadcast ──► Interceptors (Condition → Action)
       │                                   │
       │                               halt? ──► Skip instruction, jump to end
       │                                   │
       ▼                                   ▼
   Execute Instruction                 continue
       │
       ├─── Post-Event broadcast ──► Interceptors (Condition → Action)
       │                                   │
       │                               halt? ──► Abort remaining execution
       │                                   │
       ▼                                   ▼
   Next Instruction                    continue
```

The interceptor system touches three subsystems:

| Subsystem | Role |
|-----------|------|
| `BroadcastInterceptorEvents()` (StatsXHelpers) | Entry point — parses scope suffix, routes to correct registry |
| `UStatsX_StatsComponentBase` | Hosts Caster-scope and Target-scope registries |
| `UStatsX_WorldSubsystem` | Hosts Global-scope registry |

---

## 3. Scopes

```cpp
UENUM(BlueprintType)
enum class EInterceptorScope : uint8
{
    Caster,   // Events where this actor is the caster
    Target,   // Events where this actor is the target
    Global    // World-wide events (WorldSubsystem)
};
```

| Scope | Registry Owner | Typical Use Case |
|-------|----------------|------------------|
| **Caster** | `UStatsX_StatsComponentBase` (caster's component) | "When **I** cast a damage status, boost it by 20%" |
| **Target** | `UStatsX_StatsComponentBase` (target's component) | "When **I** receive a healing status, halve it" |
| **Global** | `UStatsX_WorldSubsystem` | "Whenever **anyone** deals fire damage in this world, log it" |

The scope is encoded in the **broadcast tag suffix**:

```
Broadcast tag : StatsX.Event.Pre.OnHealthDamaged.Caster   ← scope suffix
Registration tag : StatsX.Event.Pre.OnHealthDamaged         ← no suffix
```

`BroadcastInterceptorEvents()` strips the suffix via `RequestDirectParent()` to derive the registration tag.

---

## 4. Phases

```cpp
UENUM(BlueprintType)
enum class EInterceptorEventPhase : uint8
{
    Pre,   // Called BEFORE the instruction executes
    Post   // Called AFTER the instruction executes
};
```

| Phase | Payload Available | Can Modify Inputs? | Can Read Outputs? |
|-------|-------------------|--------------------|-------------------|
| **Pre** | Inputs of the next node | Yes (Context/Instance sources) | No — not yet computed |
| **Post** | Inputs + outputs of the previous node | Yes (Context/Instance sources) | Yes |

Both phases can return `false` from `Action()` to **halt** status execution.

---

## 5. Interceptor Base Class

```
Header  : Public/Interceptors/ForgeInterceptorBase.h
Source  : Private/Interceptors/ForgeInterceptorBase.cpp
```

```cpp
UCLASS(Abstract, BlueprintType, Blueprintable, meta = (DisplayName = "Interceptor"))
class STATS_X_API UForgeInterceptorBase : public UObject
```

### 5.1 Lifecycle Methods (System-Called)

| Method | When Called | Purpose |
|--------|------------|---------|
| `SetupSourceData(AActor*, UStatsX_StatsComponentBase*)` | Once at registration | Stores weak pointers to the actor/component that **registered** the interceptor |
| `SetupTriggeringData(FForgeVMContext*, EInterceptorEventPhase)` | Each trigger, before Condition/Action | Pushes a `FTriggerFrame` onto the stack |
| `ClearTriggeringData()` | After Condition/Action | Pops the top `FTriggerFrame` (no shrink) |

### 5.2 Override Points

| Method | Default | Return Semantics |
|--------|---------|------------------|
| `Condition()` | `true` (handle all events) | `true` = proceed to Action, `false` = skip this interceptor |
| `Action()` | `true` (continue execution) | `true` = continue status execution, `false` = **HALT** execution |

Both are `BlueprintNativeEvent` — overridable in Blueprint or C++.

### 5.3 TriggerFrameStack

```cpp
struct FTriggerFrame
{
    FForgeVMContext* Context = nullptr;
    EInterceptorEventPhase Phase = EInterceptorEventPhase::Pre;
};

TArray<FTriggerFrame, TInlineAllocator<4>> TriggerFrameStack;
```

The stack supports **nested broadcasts**: if an interceptor's Action triggers another status cast that fires interceptor events on the same interceptor instance, the new frame is pushed on top. `GetActiveContext()` and `GetActivePhase()` always return the **top** frame.

- `TInlineAllocator<4>` — 4 frames inline, no heap allocation for typical nesting depths.
- `Pop(EAllowShrinking::No)` — no reallocation on pop.

---

## 6. Registration Data

```cpp
USTRUCT()
struct FInterceptorRegistration
{
    UPROPERTY()
    TObjectPtr<UForgeInterceptorBase> Interceptor;   // The instance

    TWeakObjectPtr<UObject> Owner;                    // For cleanup on owner destroy
    float RegistrationTime = 0.0f;                    // Debug timestamp
    int32 Priority = 0;                               // Higher = earlier execution
    int64 SourceStatusID = 0;                          // StatusID that registered (0 = unknown)
    bool bPendingRemoval = false;                      // Deferred removal flag
};
```

| Field | Purpose |
|-------|---------|
| `Interceptor` | Strong `TObjectPtr` — keeps the UObject alive |
| `Owner` | Weak reference — enables bulk unregistration when an owner is destroyed |
| `Priority` | Passed from the RegisterInterceptor node input; higher values execute first |
| `SourceStatusID` | Enables bulk unregistration by status ID (e.g., when a status is removed, clean up its interceptors) |
| `bPendingRemoval` | Set during dispatch to avoid iterator invalidation; flushed when `DispatchDepth` returns to 0 |

---

## 7. Registry Architecture

Each registry (Caster, Target, Global) uses an identical 5-part data structure:

```
┌──────────────────────────────────────────────────────────┐
│ TMultiMap<FGameplayTag, int32>  EventToHandlesMap        │ ← event tag → handle(s)
│ TMap<int32, FInterceptorRegistration>  ActiveRegistrations│ ← handle → registration
│ FGameplayTagContainer  EventsWithInterceptors            │ ← fast early-exit cache
│ int32  DispatchDepth                                     │ ← reentrancy counter
│ TSet<int32>  PendingRemovalHandles                       │ ← deferred removal set
└──────────────────────────────────────────────────────────┘
```

### Component-Side (Caster + Target)

`UStatsX_StatsComponentBase` holds **two** copies — one prefixed `Caster*`, one prefixed `Target*`:

```
CasterEventToHandlesMap          TargetEventToHandlesMap
CasterActiveRegistrations        TargetActiveRegistrations
CasterEventsWithInterceptors     TargetEventsWithInterceptors
CasterInterceptorDispatchDepth   TargetInterceptorDispatchDepth
CasterPendingRemovalHandles      TargetPendingRemovalHandles
```

### WorldSubsystem-Side (Global)

`UStatsX_WorldSubsystem` holds one copy:

```
GlobalEventToHandlesMap
GlobalActiveRegistrations
GlobalEventsWithInterceptors
GlobalInterceptorDispatchDepth
GlobalPendingRemovalHandles
NextGlobalInterceptorHandle
```

### Early-Exit Cache

`EventsWithInterceptors` (`FGameplayTagContainer`) provides **O(1) tag membership** check. Before iterating the `EventToHandlesMap`, the system checks:

```cpp
if (!EventsCache->HasTag(EventTag))
    return true;  // No interceptors → continue execution immediately
```

The cache is **rebuilt per-tag** after registration changes via `RefreshInterceptorEventCacheTag()`.

---

## 8. Registration API

### 8.1 Component-Side (Caster / Target)

```cpp
int32 UStatsX_StatsComponentBase::RegisterInterceptor(
    const FGameplayTag& EventTag,
    TSubclassOf<UForgeInterceptorBase> InterceptorClass,
    EInterceptorScope Scope,
    int32 Priority,
    AActor* SourceActor,
    UStatsX_StatsComponentBase* SourceComponent,
    int64 SourceStatusID = 0);
```

**Flow:**

1. Select maps based on `Scope` (Caster or Target).
2. `NewObject<UForgeInterceptorBase>(this, InterceptorClass)` — interceptor is **outer'd** to the component.
3. `Interceptor->SetupSourceData(SourceActor, SourceComponent)`.
4. Build `FInterceptorRegistration` with Priority, RegistrationTime, SourceStatusID.
5. Assign monotonic handle via `NextInterceptorHandle++`.
6. Insert into `EventToHandlesMap` and `ActiveRegistrations`.
7. Add event tag to `EventsWithInterceptors` cache.
8. Return handle (or `-1` on failure).

### 8.2 WorldSubsystem-Side (Global)

```cpp
int32 UStatsX_WorldSubsystem::RegisterGlobalInterceptor(
    const FGameplayTag& EventTag,
    TSubclassOf<UForgeInterceptorBase> InterceptorClass,
    int32 Priority,
    AActor* SourceActor,
    UStatsX_StatsComponentBase* SourceComponent,
    int64 SourceStatusID = 0);
```

Identical logic, operating on `Global*` maps and `NextGlobalInterceptorHandle`.

---

## 9. Unregistration API

### 9.1 By Handle

```cpp
bool UnregisterInterceptor(int32 Handle);              // Component
bool UnregisterGlobalInterceptor(int32 Handle);         // WorldSubsystem
```

**Reentrancy-aware:** If `DispatchDepth > 0`, the handle is **marked pending** (`bPendingRemoval = true`) rather than removed immediately. It is flushed when dispatch finishes.

If `DispatchDepth == 0`, the handle is removed immediately via `RemoveInterceptorHandleImmediate()`, which:
1. Removes from `ActiveRegistrations`.
2. Iterates `EventToHandlesMap` to remove all entries with this handle.
3. Refreshes `EventsWithInterceptors` cache for affected tags.

### 9.2 By Event Tag + Scope

```cpp
int32 UnregisterInterceptorsForEvent(const FGameplayTag& EventTag, EInterceptorScope Scope);
int32 UnregisterGlobalInterceptorsForEvent(const FGameplayTag& EventTag);
```

Collects all active handles for the event, then removes/marks each one. Returns count removed.

### 9.3 By Source Component

```cpp
int32 UnregisterAllInterceptorsFromSource(UStatsX_StatsComponentBase* SourceComponent);
```

Iterates both Caster and Target registries; removes all registrations whose `Owner` matches `SourceComponent`. Reentrancy-aware per scope.

### 9.4 By Source Status ID

```cpp
int32 UnregisterAllInterceptorsFromStatusID(int64 StatusID);
```

Iterates both Caster and Target registries; removes all registrations whose `SourceStatusID` matches. Reentrancy-aware per scope.

---

## 10. Broadcast Pipeline

**Entry point:** `BroadcastInterceptorEvents()` in `StatsXHelpers.cpp`.

```cpp
bool BroadcastInterceptorEvents(
    const FGameplayTagContainer& EventTags,
    FForgeVMContext& Context,
    EInterceptorEventPhase Phase,
    UStatsX_StatsComponentBase* AffectedComponent);
```

### 10.1 Tag Parsing

For each tag in the container:

```
Input:  "StatsX.Event.Pre.OnHealthDamaged.Caster"
                                           ^^^^^^^ scope suffix
```

1. **Determine scope** from string suffix: `.Caster`, `.Target`, `.Global`.
2. **Extract base tag** via `EventTag.RequestDirectParent()`:
   ```
   "StatsX.Event.Pre.OnHealthDamaged.Caster"
    → RequestDirectParent()
    → "StatsX.Event.Pre.OnHealthDamaged"       ← matches registration tag
   ```

### 10.2 Routing

```
Scope::Caster  → Context.CasterComponent->BroadcastToScope(BaseTag, ...)
Scope::Target  → AffectedComponent (or Context.TargetComponent)->BroadcastToScope(BaseTag, ...)
Scope::Global  → Context.GetSubsystem()->BroadcastGlobalInterceptorEvent(BaseTag, ...)
```

**AffectedComponent override:** For Target scope, an explicit `AffectedComponent` parameter allows propagation events to reach third-party actors that are neither the status caster nor target.

### 10.3 Short-Circuit

If **any** interceptor's `Action()` returns `false`, the entire function returns `false` immediately — no further tags are processed. The caller (ForgeVM) interprets this as a **halt**.

---

## 11. Dispatch Loop

`BroadcastToScope()` (component) and `BroadcastGlobalInterceptorEvent()` (subsystem) share identical dispatch logic:

```
BroadcastToScope(EventTag, Context, Scope, Phase)
│
├─ Early exit: EventsCache->HasTag(EventTag) == false → return true
│
├─ MultiFind handles for EventTag
│
├─ ++DispatchDepth
│
├─ Sort by Priority (descending: higher = earlier)
│
├─ For each (Priority, Handle):
│   ├─ Re-lookup registration (may have been invalidated)
│   ├─ Skip if bPendingRemoval or !IsValid(Interceptor)
│   │
│   ├─ Interceptor->SetupTriggeringData(&Context, Phase)
│   ├─ bShouldHandle = Interceptor->Condition()
│   ├─ Interceptor->ClearTriggeringData()
│   │
│   ├─ if (!bShouldHandle) → skip to next
│   │
│   ├─ Re-lookup registration (Condition may have caused mutations)
│   ├─ Skip if bPendingRemoval or !IsValid(Interceptor)
│   │
│   ├─ Interceptor->SetupTriggeringData(&Context, Phase)
│   ├─ bContinue = Interceptor->Action()
│   ├─ Interceptor->ClearTriggeringData()
│   │
│   └─ if (!bContinue) → FinishDispatch(), return false  ← HALT
│
├─ FinishDispatch()  (--DispatchDepth, flush if 0)
│
└─ return true  ← continue execution
```

### Key Safety Checks

1. **Double re-lookup:** After `Condition()` and before `Action()`, the registration is looked up again. Condition may trigger nested casts that modify the registry.
2. **IsValid() guard:** Checks UObject validity after each re-lookup — the interceptor may have been garbage-collected during a nested operation.
3. **SetupTriggeringData / ClearTriggeringData** bracket both `Condition()` and `Action()` independently — if Condition skips, Action's context is not leaked.

---

## 12. Reentrancy Safety

### Deferred Removal

```
DispatchDepth > 0  →  UnregisterInterceptor marks bPendingRemoval = true
                      Handle added to PendingRemovalHandles set

DispatchDepth == 0 →  FlushPendingInterceptorRemovals():
                      - Copies PendingRemovalHandles to temp array
                      - Calls RemoveInterceptorHandleImmediate for each
                      - Refreshes EventsWithInterceptors cache per affected tag
```

### FinishDispatch Lambda

```cpp
auto FinishDispatch = [&]()
{
    --(*DispatchDepth);
    if (*DispatchDepth == 0)
    {
        FlushPendingInterceptorRemovals(...);
    }
};
```

Called on **every exit path** — both normal completion and early halt.

### Nested Broadcast Example

```
Status A fires Pre-event
  └─ Interceptor X.Condition() returns true
  └─ Interceptor X.Action() casts Status B
       └─ Status B fires Pre-event
            └─ Interceptor Y (same registry) dispatches
            └─ DispatchDepth = 2
       └─ Status B finishes → DispatchDepth back to 1
  └─ Back in Status A dispatch → DispatchDepth = 1
  └─ Remaining interceptors for Status A execute
  └─ FinishDispatch → DispatchDepth = 0 → flush pending removals
```

---

## 13. Payload System

Payload entries expose the **inputs and outputs** of the StatusForge graph node adjacent to the event.

### 13.1 Compiled Payload Entry

```cpp
struct FForgePayloadEntry
{
    FName FieldName;    // Pin name from the adjacent node
    uint16 Offset;      // Byte offset / pool index / arg index
    uint8 Source;        // EForgeDataSource (Literal, Context, Instance, CallFrame)
    uint8 FieldType;    // EForgeFieldType
};
```

Compiled into the `StatusDefinition` at editor time. At runtime, the VM sets `Context.ActivePayloadEntries` and `Context.ActivePayloadCount` before the broadcast.

### 13.2 Reading Payload Values

```cpp
// Internal template (anonymous namespace)
template<typename T>
T ReadPayloadValue(FForgeVMContext* Ctx, const FForgePayloadEntry& Entry)
{
    switch (static_cast<EForgeDataSource>(Entry.Source))
    {
    case Literal:   return Ctx->ReadLiteral<T>(Entry.Offset);
    case Context:   return Ctx->ReadFromMemory<T>(Ctx->ContextStack, Entry.Offset);
    case Instance:  return Ctx->ReadFromInstanceBlob<T>(Entry.Offset);
    case CallFrame: return Ctx->ReadCallFrameValue<T>(Entry.Offset);
    default:        return T();
    }
}
```

### 13.3 Writing Payload Values

```cpp
template<typename T>
bool WritePayloadValue(FForgeVMContext* Ctx, const FForgePayloadEntry& Entry, const T& Value)
{
    switch (static_cast<EForgeDataSource>(Entry.Source))
    {
    case Context:   Ctx->WriteToMemory<T>(Ctx->ContextStack, Entry.Offset, Value);  return true;
    case Instance:  Ctx->WriteToInstanceBlob<T>(Entry.Offset, Value);               return true;
    default:        return false;  // Literal and CallFrame are read-only
    }
}
```

### 13.4 Write Validation

Every `SetPayload*` call passes through `CanWritePayloadEntry()`:

```
1. Entry exists?                     → FindPayloadEntry(Ctx, FieldName)
2. Type matches?                     → Entry->FieldType == ExpectedFieldType
3. Source supports writes?           → Context or Instance only
4. Bounds check passes?              → Offset + sizeof(T) ≤ region size
```

All four checks must pass before the write is committed.

### 13.5 Blueprint API

**Getters** (BlueprintPure):

| Function | Return Type | bFound Output |
|----------|-------------|---------------|
| `GetPayloadFloat` | `float` | ✓ |
| `GetPayloadInt` | `int32` | ✓ |
| `GetPayloadBool` | `bool` | ✓ |
| `GetPayloadTag` | `FGameplayTag` | ✓ |
| `GetPayloadTagContainer` | `FGameplayTagContainer` | ✓ |
| `GetPayloadObject` | `UObject*` | ✓ |
| `GetPayloadVector` | `FVector` | ✓ |

**Setters** (BlueprintCallable, returns `bool`):

| Function | Value Type | Writable Sources |
|----------|------------|------------------|
| `SetPayloadFloat` | `float` | Context, Instance |
| `SetPayloadInt` | `int32` | Context, Instance |
| `SetPayloadBool` | `bool` | Context, Instance |
| `SetPayloadTag` | `FGameplayTag` | Context, Instance |
| `SetPayloadTagContainer` | `FGameplayTagContainer` | Context, Instance |
| `SetPayloadObject` | `UObject*` | Context, Instance |
| `SetPayloadVector` | `FVector` | Context, Instance |

**Introspection:**

| Function | Return Type | Purpose |
|----------|-------------|---------|
| `HasPayloadField` | `bool` | Check if a field exists by name |
| `GetPayloadFieldNames` | `TArray<FName>` | List all available payload fields |

---

## 14. Variable Access

Interceptors can read and write **status variables** of the triggering status via the `ForgeVariableAccess` helper.

### 14.1 Read Path

```cpp
float UForgeInterceptorBase::GetVariableFloat(FGameplayTag VariableTag, bool& bFound) const
{
    float Value = 0.f;
    FForgeVMContext* Context = GetActiveContext();
    if (!Context || !Context->Definition) { bFound = false; return Value; }
    bFound = ForgeVariableAccess::ReadVariable<float>(
        Context->Definition,
        ForgeVariableAccess::GetVariableBlobConst(*Context),
        VariableTag, ForgeFieldTypes::Float, Value);
    return Value;
}
```

The variable blob is resolved from the active context — either the instance blob (persistent) or the context stack (transient), depending on the status state.

### 14.2 Write Path

```cpp
bool UForgeInterceptorBase::SetVariableFloat(FGameplayTag VariableTag, float Value)
{
    FForgeVMContext* Context = GetActiveContext();
    if (!Context || !Context->Definition) return false;
    return ForgeVariableAccess::WriteVariable<float>(
        Context->Definition,
        ForgeVariableAccess::GetVariableBlob(*Context),
        VariableTag, ForgeFieldTypes::Float, Value);
}
```

### 14.3 Object Variable Indirection

Object variables are stored as `uint16` pool indices in the variable blob. The interceptor resolves them through the context's object pool:

**Read:**
```cpp
uint16 ObjectIndex = ...;  // Read from blob
return Context->Instance
    ? Context->GetInstanceObject(ObjectIndex)
    : Context->GetContextObject(ObjectIndex);
```

**Write:**
```cpp
uint16 ObjectIndex = Context->Instance
    ? Context->AllocInstanceObject(Value)
    : Context->AllocContextObject(Value);
// Write ObjectIndex to blob
```

### 14.4 Blueprint API

**Getters** (BlueprintPure, `meta = (Categories = "StatsX.Variable")`):

| Function | Return Type |
|----------|-------------|
| `GetVariableFloat` | `float` |
| `GetVariableInt` | `int32` |
| `GetVariableBool` | `bool` |
| `GetVariableTag` | `FGameplayTag` |
| `GetVariableVector` | `FVector` |
| `GetVariableObject` | `UObject*` |

**Setters** (BlueprintCallable, returns `bool`):

| Function | Value Type |
|----------|------------|
| `SetVariableFloat` | `float` |
| `SetVariableInt` | `int32` |
| `SetVariableBool` | `bool` |
| `SetVariableTag` | `FGameplayTag` |
| `SetVariableVector` | `FVector` |
| `SetVariableObject` | `UObject*` |

All variable accessors use the `Categories = "StatsX.Variable"` meta specifier, providing a filtered tag picker in the Blueprint editor.

---

## 15. Context Accessors

Two categories of context are available during `Condition()` / `Action()`:

### 15.1 Source Context (Valid Always After Registration)

| Function | Return | Description |
|----------|--------|-------------|
| `GetSourceActor()` | `AActor*` | The actor that **registered** this interceptor (caster of the registering status) |
| `GetSourceComponent()` | `UStatsX_StatsComponentBase*` | The component that **registered** this interceptor |

Stored as `TWeakObjectPtr` — returns `nullptr` if the source has been destroyed.

### 15.2 Triggering Context (Valid During Condition/Action Only)

| Function | Return | Description |
|----------|--------|-------------|
| `GetCasterActor()` | `AActor*` | Caster of the status that **triggered** this event |
| `GetTargetActor()` | `AActor*` | Target of the status that **triggered** this event |
| `GetCasterComponent()` | `UStatsX_StatsComponentBase*` | Caster's component |
| `GetTargetComponent()` | `UStatsX_StatsComponentBase*` | Target's component |
| `GetTriggeringStatusID()` | `int64` | StatusID of the triggering status instance |
| `IsPreEvent()` | `bool` | `true` if Pre phase, `false` if Post phase |

All triggering accessors read from the top of the `TriggerFrameStack` via `GetActiveContext()`.

---

## 16. GC Safety

### AddReferencedObjects

Both `UStatsX_StatsComponentBase` and `UStatsX_WorldSubsystem` override `AddReferencedObjects()` to walk their interceptor registries:

```cpp
void AddInterceptorRegistryReferences(
    TMap<int32, FInterceptorRegistration>& Registrations,
    FReferenceCollector& Collector)
{
    for (auto& Pair : Registrations)
    {
        Collector.AddReferencedObject(Pair.Value.Interceptor);
    }
}
```

This prevents the GC from collecting interceptor UObjects that are only referenced inside the registry maps (which are not `UPROPERTY` containers for the `TWeakObjectPtr<UObject> Owner` field).

### IsValid Checks

The dispatch loop calls `IsValid(Interceptor)` before **every** use — both before Condition and before Action. This handles the edge case where a nested operation during Condition causes the interceptor to be garbage-collected.

---

## 17. Performance Instrumentation

Every interceptor operation is wrapped in `STATSX_INTERCEPTORS_SCOPE` for Unreal Insights profiling:

| Stat Name | Scope |
|-----------|-------|
| `StatsX.Interceptors.SetupSourceData` | Registration-time source data setup |
| `StatsX.Interceptors.SetupTriggeringData` | Per-trigger context push |
| `StatsX.Interceptors.ClearTriggeringData` | Per-trigger context pop |
| `StatsX.Interceptors.BroadcastEvents` | Top-level broadcast entry point |
| `StatsX.Interceptors.BroadcastLocal` | Component-side BroadcastToScope |
| `StatsX.Interceptors.Condition` | Individual Condition() call |
| `StatsX.Interceptors.Action` | Individual Action() call |
| `StatsX.Interceptors.RegisterGlobalNode` | Global registration from node handler |
| `StatsX.Interceptors.UnregisterLocalRuntime` | Component-side handle unregistration |
| `StatsX.Interceptors.UnregisterGlobalRuntime` | Global handle unregistration |
| `StatsX.Interceptors.UnregisterForEvent` | Bulk unregistration by event tag |

---

## 18. API Reference

### UForgeInterceptorBase

| Category | Method | Signature |
|----------|--------|-----------|
| **Override** | `Condition` | `bool Condition()` — BlueprintNativeEvent |
| **Override** | `Action` | `bool Action()` — BlueprintNativeEvent |
| **Source** | `GetSourceActor` | `AActor* GetSourceActor() const` |
| **Source** | `GetSourceComponent` | `UStatsX_StatsComponentBase* GetSourceComponent() const` |
| **Triggering** | `GetCasterActor` | `AActor* GetCasterActor() const` |
| **Triggering** | `GetTargetActor` | `AActor* GetTargetActor() const` |
| **Triggering** | `GetCasterComponent` | `UStatsX_StatsComponentBase* GetCasterComponent() const` |
| **Triggering** | `GetTargetComponent` | `UStatsX_StatsComponentBase* GetTargetComponent() const` |
| **Triggering** | `GetTriggeringStatusID` | `int64 GetTriggeringStatusID() const` |
| **Triggering** | `IsPreEvent` | `bool IsPreEvent() const` |
| **Payload** | `HasPayloadField` | `bool HasPayloadField(FName FieldName) const` |
| **Payload** | `GetPayloadFloat` | `float GetPayloadFloat(FName, bool& bFound) const` |
| **Payload** | `GetPayloadInt` | `int32 GetPayloadInt(FName, bool& bFound) const` |
| **Payload** | `GetPayloadBool` | `bool GetPayloadBool(FName, bool& bFound) const` |
| **Payload** | `GetPayloadTag` | `FGameplayTag GetPayloadTag(FName, bool& bFound) const` |
| **Payload** | `GetPayloadTagContainer` | `FGameplayTagContainer GetPayloadTagContainer(FName, bool& bFound) const` |
| **Payload** | `GetPayloadObject` | `UObject* GetPayloadObject(FName, bool& bFound) const` |
| **Payload** | `GetPayloadVector` | `FVector GetPayloadVector(FName, bool& bFound) const` |
| **Payload** | `SetPayloadFloat` | `bool SetPayloadFloat(FName, float)` |
| **Payload** | `SetPayloadInt` | `bool SetPayloadInt(FName, int32)` |
| **Payload** | `SetPayloadBool` | `bool SetPayloadBool(FName, bool)` |
| **Payload** | `SetPayloadTag` | `bool SetPayloadTag(FName, FGameplayTag)` |
| **Payload** | `SetPayloadTagContainer` | `bool SetPayloadTagContainer(FName, FGameplayTagContainer)` |
| **Payload** | `SetPayloadObject` | `bool SetPayloadObject(FName, UObject*)` |
| **Payload** | `SetPayloadVector` | `bool SetPayloadVector(FName, FVector)` |
| **Payload** | `GetPayloadFieldNames` | `TArray<FName> GetPayloadFieldNames() const` |
| **Variables** | `GetVariableFloat` | `float GetVariableFloat(FGameplayTag, bool& bFound) const` |
| **Variables** | `GetVariableInt` | `int32 GetVariableInt(FGameplayTag, bool& bFound) const` |
| **Variables** | `GetVariableBool` | `bool GetVariableBool(FGameplayTag, bool& bFound) const` |
| **Variables** | `GetVariableTag` | `FGameplayTag GetVariableTag(FGameplayTag, bool& bFound) const` |
| **Variables** | `GetVariableVector` | `FVector GetVariableVector(FGameplayTag, bool& bFound) const` |
| **Variables** | `GetVariableObject` | `UObject* GetVariableObject(FGameplayTag, bool& bFound) const` |
| **Variables** | `SetVariableFloat` | `bool SetVariableFloat(FGameplayTag, float)` |
| **Variables** | `SetVariableInt` | `bool SetVariableInt(FGameplayTag, int32)` |
| **Variables** | `SetVariableBool` | `bool SetVariableBool(FGameplayTag, bool)` |
| **Variables** | `SetVariableTag` | `bool SetVariableTag(FGameplayTag, FGameplayTag)` |
| **Variables** | `SetVariableVector` | `bool SetVariableVector(FGameplayTag, FVector)` |
| **Variables** | `SetVariableObject` | `bool SetVariableObject(FGameplayTag, UObject*)` |

### UStatsX_StatsComponentBase (Interceptor Section)

| Method | Signature |
|--------|-----------|
| `RegisterInterceptor` | `int32 RegisterInterceptor(FGameplayTag, TSubclassOf<UForgeInterceptorBase>, EInterceptorScope, int32 Priority, AActor*, UStatsX_StatsComponentBase*, int64 SourceStatusID = 0)` |
| `UnregisterInterceptor` | `bool UnregisterInterceptor(int32 Handle)` |
| `UnregisterInterceptorsForEvent` | `int32 UnregisterInterceptorsForEvent(FGameplayTag, EInterceptorScope)` |
| `UnregisterAllInterceptorsFromSource` | `int32 UnregisterAllInterceptorsFromSource(UStatsX_StatsComponentBase*)` |
| `UnregisterAllInterceptorsFromStatusID` | `int32 UnregisterAllInterceptorsFromStatusID(int64)` |
| `HasInterceptorsForEvents` | `bool HasInterceptorsForEvents(FGameplayTagContainer, EInterceptorScope) const` |
| `GetInterceptorCountForEvent` | `int32 GetInterceptorCountForEvent(FGameplayTag, EInterceptorScope) const` |
| `GetHandlesForEvent` | `TArray<int32> GetHandlesForEvent(FGameplayTag, EInterceptorScope) const` |
| `BroadcastToScope` | `bool BroadcastToScope(FGameplayTag, FForgeVMContext&, EInterceptorScope, EInterceptorEventPhase)` |

### UStatsX_WorldSubsystem (Global Interceptors)

| Method | Signature |
|--------|-----------|
| `RegisterGlobalInterceptor` | `int32 RegisterGlobalInterceptor(FGameplayTag, TSubclassOf<UForgeInterceptorBase>, int32 Priority, AActor*, UStatsX_StatsComponentBase*, int64 SourceStatusID = 0)` |
| `UnregisterGlobalInterceptor` | `bool UnregisterGlobalInterceptor(int32 Handle)` |
| `UnregisterGlobalInterceptorsForEvent` | `int32 UnregisterGlobalInterceptorsForEvent(FGameplayTag)` |
| `UnregisterGlobalInterceptorsFromSource` | `int32 UnregisterGlobalInterceptorsFromSource(UStatsX_StatsComponentBase*)` |
| `UnregisterGlobalInterceptorsFromStatusID` | `int32 UnregisterGlobalInterceptorsFromStatusID(int64)` |
| `HasGlobalInterceptorsForEvents` | `bool HasGlobalInterceptorsForEvents(FGameplayTagContainer) const` |
| `GetGlobalInterceptorCountForEvent` | `int32 GetGlobalInterceptorCountForEvent(FGameplayTag) const` |
| `GetGlobalHandlesForEvent` | `TArray<int32> GetGlobalHandlesForEvent(FGameplayTag) const` |
| `BroadcastGlobalInterceptorEvent` | `bool BroadcastGlobalInterceptorEvent(FGameplayTag, FForgeVMContext&, EInterceptorEventPhase)` |

### Free Function

| Function | Signature |
|----------|-----------|
| `BroadcastInterceptorEvents` | `bool BroadcastInterceptorEvents(const FGameplayTagContainer&, FForgeVMContext&, EInterceptorEventPhase, UStatsX_StatsComponentBase* AffectedComponent)` |

---

*Document generated from source — Stats_X v1.404*
