# 13 — Custom Logic — Action

> **Stats_X v1.404** — UForgeCustomAction, Asynchronous Execution, VM Suspension & Resumption
> Manual-continuation action nodes for the ForgeVM — from fire-and-forget
> synchronous actions to long-lived async operations with loop chaining.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Class Hierarchy](#2-class-hierarchy)
3. [UForgeCustomAction](#3-forgecustomaction)
4. [OP_CustomAction Handler](#4-op_customaction-handler)
5. [Synchronous vs Asynchronous Execution](#5-synchronous-vs-asynchronous-execution)
6. [Suspension & Resumption](#6-suspension--resumption)
7. [GC Protection](#7-gc-protection)
8. [Loop Chaining (ChainableAction)](#8-loop-chaining-chainableaction)
9. [EndActionWithResult](#9-endactionwithresult)
10. [Inline Execution Fallback](#10-inline-execution-fallback)
11. [Performance Instrumentation](#11-performance-instrumentation)
12. [API Reference](#12-api-reference)

---

## 1. Design Philosophy

Action nodes are the **mutating primitives** of the ForgeVM. Unlike checks (synchronous, read-only), actions can modify game state and, critically, **suspend the VM** to wait for asynchronous operations.

| Decision | Rationale |
|----------|-----------|
| **Async by default** | Actions may start long-running operations (montages, delays, network calls); the VM must not spin-wait |
| **Manual continuation** | `EndAction()` is the developer's responsibility — no timeout, no auto-resume |
| **Mutable context** | Actions may modify attributes, cast statuses, spawn actors — full write access |
| **GC-safe suspension** | Instance stored in `FStatusInstance::ActiveCustomLogic` (UPROPERTY) prevents collection during async gaps |
| **Loop support** | `ChainableAction()` enables loop-body actions that signal continue/break per iteration |
| **Synchronous fast-path** | If `EndAction()` is called inside `Execute()`, the VM never suspends — zero-overhead continuation |

---

## 2. Class Hierarchy

```
UObject
  └── UForgeCustomLogicBase         (Abstract — shared base, documented in 12_Custom_Logic_Check)
        │
        ├── UForgeCustomCheck       (Synchronous checks — documented in 12_Custom_Logic_Check)
        │
        └── UForgeCustomAction      (Abstract — async action with manual continuation)
              └── User subclasses   (Blueprint or C++)
```

`UForgeCustomAction` inherits all context setup, variable access, ForgeParam injection, and lifecycle hooks from `UForgeCustomLogicBase`. See document 12 for the shared base class details.

---

## 3. UForgeCustomAction

```
Header  : Public/CustomLogics/ForgeCustomAction.h
Source  : Private/CustomLogics/ForgeCustomAction.cpp
```

```cpp
UCLASS(Abstract, BlueprintType, Blueprintable, meta = (DisplayName = "Custom Action"))
class STATS_X_API UForgeCustomAction : public UForgeCustomLogicBase
```

### 3.1 Override Points

#### Execute()

```cpp
UFUNCTION(BlueprintNativeEvent, Category = "ForgeCustomLogic|Execution")
void Execute();
virtual void Execute_Implementation();  // Default: calls EndAction() immediately
```

Starts the action. The VM **suspends** after this returns unless `EndAction()` was called inside `Execute()` (synchronous fast-path).

#### ChainableAction()

```cpp
UFUNCTION(BlueprintNativeEvent, Category = "ForgeCustomLogic|Execution")
bool ChainableAction();
virtual bool ChainableAction_Implementation();  // Default: calls Execute(), returns true
```

Loop-body variant. Return `true` to continue the loop, `false` to exit.

### 3.2 Continuation API

#### EndAction()

```cpp
UFUNCTION(BlueprintCallable, Category = "ForgeCustomLogic|Execution")
void EndAction();
```

Signals the VM that the async action has completed. **Must be called** or the status remains suspended indefinitely. Delegates to `EndActionWithResult(true)`.

#### EndActionWithResult(bool bSuccess)

```cpp
UFUNCTION(BlueprintCallable, Category = "ForgeCustomLogic|Execution")
void EndActionWithResult(bool bSuccess);
```

Signals completion with an explicit success/failure flag. Sets `bEndResult` for optional branching via `bLastConditionResult` on resume.

### 3.3 Internal State

| Field | Type | Description |
|-------|------|-------------|
| `bIsExecuting` | `uint8 : 1` | True between `MarkAsExecuting()` and `EndAction()` |
| `bEndResult` | `uint8 : 1` | Success/failure result, default `true` |
| `CachedSubsystem` | `TWeakObjectPtr<UStatsX_WorldSubsystem>` | Cached for resume signaling |

### 3.4 State Query

```cpp
UFUNCTION(BlueprintPure, Category = "ForgeCustomLogic|State")
bool IsExecuting() const { return bIsExecuting; }
```

### 3.5 Usage Example (C++)

```cpp
UCLASS()
class UAction_PlayMontage : public UForgeCustomAction
{
    GENERATED_BODY()
public:
    virtual void Execute_Implementation() override
    {
        // Start montage, bind to OnCompleted
        PlayMontage(Montage, FOnMontageEnded::CreateUObject(
            this, &ThisClass::OnMontageEnded));
    }

    void OnMontageEnded()
    {
        EndAction(); // Resume VM
    }

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    UAnimMontage* Montage;
};
```

---

## 4. OP_CustomAction Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (Nodes_CustomLogic namespace)
OpCode  : 256
```

### 4.1 Instruction Layout

```
Data0[24-39]:  Pool_Classes index (16 bits) — UForgeCustomAction subclass
Data0[40]:     bIsChainable flag (1 bit) — true = use ChainableAction() for loops
Data0[42+]:    ForgeParam fields (18 bits each, sequentially packed)
               Continuation instructions used when params overflow Data0/Data1
```

### 4.2 Execution Sequence

```
ExecuteCustomAction(Context, Instr)
│
├─ 1. Save FallthroughPC = Context.PC
│
├─ 2. Extract ClassIndex from Data0[24..39], bIsChainable from Data0[40]
│
├─ 3. Validate: Definition exists, Pool_Classes[ClassIndex] is valid
│     └─ Error if index out of bounds
│
├─ 4. Get UClass* from Pool_Classes, verify IsChildOf(UForgeCustomAction)
│     └─ Error if wrong class hierarchy
│
├─ 5. INSTANCE REQUIREMENT CHECK
│     ├─ If Context.Instance exists → proceed
│     └─ If Context.Instance is null (inline execution):
│           ├─ Get WorldSubsystem
│           ├─ RegisterAsActiveInstance() → allocates pool instance
│           └─ Error if registration fails
│
├─ 6. NewObject<UForgeCustomAction>(GetTransientPackage(), ActionClass)
│     └─ Error if instantiation fails
│
├─ 7. Action->SetupContext(Context)
│     └─ Copies caster, target, definition, statusID
│
├─ 8. Action->InjectForgeParams(Context, Instr, 42)
│     └─ Populates UPROPERTY fields from instruction data
│
├─ 9. Context.Instance->ActiveCustomLogic = Action
│     └─ GC protection: UPROPERTY reference keeps action alive
│
├─ 10. Action->MarkAsExecuting(Subsystem)
│      └─ Sets bIsExecuting=true, caches subsystem
│
├─ 11. DISPATCH (branching on bIsChainable):
│      │
│      ├─ [Chainable Path]
│      │   ├─ bContinue = Action->ChainableAction()
│      │   └─ if (!bContinue):
│      │        ├─ Cleanup + ClearContext
│      │        ├─ ActiveCustomLogic = nullptr
│      │        ├─ Skip continuations
│      │        └─ return Continue (exit loop)
│      │
│      └─ [Standard Path]
│          └─ Action->Execute()
│
├─ 12. SYNCHRONOUS COMPLETION CHECK
│      ├─ if (!Action->IsExecuting()):
│      │     └─ EndAction() was called inside Execute()
│      │     └─ Skip continuations, return Continue
│      │
│      └─ else: SUSPEND
│           ├─ Calculate ResumePC (past continuation slots)
│           ├─ Instance->SavedPC = ResumePC
│           ├─ Instance->State = Suspended
│           ├─ Instance->SuspendTimer = -1.f  (infinite)
│           └─ return Suspended
│
└─ VM exits execution loop
```

### 4.3 Key Implementation Details

**Instance requirement:** Unlike checks, actions require a `FStatusInstance` because suspension/resume needs persistent state. If executing inline (no instance), the handler auto-registers one via `RegisterAsActiveInstance()`.

**ForgeParam start bit = 42:** Same as OP_CustomCheck. Bits 0-23 are OpCode+flags, bits 24-39 are ClassIndex, bit 40 is bIsChainable, bit 41 is reserved.

**Synchronous fast-path:** If `EndAction()` is called within `Execute()`, `IsExecuting()` returns false and the handler returns `Continue` without ever suspending. Zero suspension overhead for actions that complete immediately.

**Infinite suspend timer:** `SuspendTimer = -1.f` means the instance never auto-resumes. Only `EndAction()` can trigger resumption by setting `SuspendTimer = 0.f`.

---

## 5. Synchronous vs Asynchronous Execution

### 5.1 Synchronous (Fast-Path)

When `EndAction()` is called inside `Execute()`:

```
VM → Execute() → EndAction() → VM continues immediately
     ───────────────────────────────────────────────────
                   Same frame, no suspension
```

The default `Execute_Implementation()` does exactly this — calls `EndAction()` immediately. Subclasses that perform only immediate state changes (e.g., set a variable, apply a modifier) should follow this pattern.

### 5.2 Asynchronous (Suspension)

When `Execute()` returns without calling `EndAction()`:

```
Frame N:    VM → Execute() → starts async work → VM suspends
              ...async work in progress...
Frame N+K:  Callback → EndAction() → SuspendTimer=0, State=Active
Frame N+K+1: Pool tick → ShouldResume() → ResumeInstance(SavedPC)
```

The VM is **fully suspended** during the async gap — no polling, no busy-wait. Resumption is triggered by the `EndAction()` call modifying instance state, which the pool detects on the next tick.

---

## 6. Suspension & Resumption

### 6.1 Suspension (Handler Side)

```cpp
// After Execute() returns without completing:
Context.Instance->SavedPC = ResumePC;           // Where to resume
Context.Instance->State = EStatusInstanceState::Suspended;
Context.Instance->SuspendTimer = -1.f;           // Infinite wait
return EForgeExecutionResult::Suspended;
```

The ResumePC is calculated to skip past any continuation instruction slots.

### 6.2 Resumption (EndAction Side)

```cpp
void UForgeCustomAction::EndActionWithResult(bool bSuccess)
{
    if (!bIsExecuting) return;          // Guard: already ended

    bIsExecuting = false;
    bEndResult = bSuccess;

    if (StatusInstance)
    {
        StatusInstance->SuspendTimer = 0.f;                    // Trigger resume
        StatusInstance->State = EStatusInstanceState::Active;   // Mark active
        StatusInstance->ActiveCustomLogic = nullptr;            // Release GC ref
    }

    Cleanup();
    ClearContext();
}
```

### 6.3 Pool Detection

```cpp
// FStatusInstance::ShouldResume():
FORCEINLINE bool ShouldResume() const
{
    return State == EStatusInstanceState::Suspended && SuspendTimer <= 0.f;
}
```

On the next pool tick, the instance is detected as ready to resume. The pool calls `ForgeVM::ResumeInstance()` with the saved PC, and execution continues from the instruction after the action.

### 6.4 Instance State Transitions

```
Active → [OP_CustomAction handler] → Suspended (SuspendTimer = -1)
  │
  │  ... async work ...
  │
  └── [EndAction()] → Active (SuspendTimer = 0)
        │
        └── [Next tick, pool detects ShouldResume()] → ResumeInstance(SavedPC)
```

---

## 7. GC Protection

Async actions can live across multiple frames. Without GC protection, the UObject would be collected between `Execute()` and `EndAction()`.

```
FStatusInstance (lives in pool, UPROPERTY-protected)
  └── ActiveCustomLogic : TObjectPtr<UForgeCustomLogicBase>  (UPROPERTY)
        └── UForgeCustomAction instance (GC-safe)
```

**Lifecycle of the GC reference:**

| Phase | ActiveCustomLogic | GC-Safe? |
|-------|-------------------|----------|
| Before Execute | `= Action` (set by handler) | Yes |
| During async work | Points to Action | Yes |
| EndAction() called | `= nullptr` (cleared by EndAction) | N/A — action cleanup complete |
| After EndAction() | `nullptr` | GC can reclaim |

---

## 8. Loop Chaining (ChainableAction)

Actions support loop-body execution via the `bIsChainable` flag in the instruction.

### 8.1 Standard vs Chainable

| Mode | Method Called | Return | VM Behavior |
|------|-------------- |--------|-------------|
| Standard (`bIsChainable = false`) | `Execute()` | void | Suspends if EndAction not called |
| Chainable (`bIsChainable = true`) | `ChainableAction()` | bool | `true` → continue loop, `false` → exit loop |

### 8.2 Chainable Flow

```
Loop Iteration:
  ├─ ChainableAction() returns true → VM continues (loop body proceeds)
  ├─ ChainableAction() returns false → Cleanup, exit loop, return Continue
  └─ Default implementation: calls Execute(), returns true
```

When `ChainableAction()` returns `false`, the handler performs full cleanup (Cleanup, ClearContext, nullify ActiveCustomLogic) and continues VM execution past the loop, effectively acting as a `break`.

### 8.3 Usage Example

```cpp
UCLASS()
class UAction_ApplyDamageToTargets : public UForgeCustomAction
{
    GENERATED_BODY()
public:
    virtual bool ChainableAction_Implementation() override
    {
        if (CurrentIndex >= Targets.Num())
            return false;  // No more targets → exit loop

        ApplyDamageToTarget(Targets[CurrentIndex]);
        CurrentIndex++;
        EndAction();       // Complete this iteration
        return true;       // Continue loop
    }

private:
    int32 CurrentIndex = 0;
};
```

---

## 9. EndActionWithResult

`EndActionWithResult(bool bSuccess)` is the full-form continuation API:

```cpp
void EndActionWithResult(bool bSuccess);
```

- Sets `bEndResult = bSuccess` on the action instance
- The result is available for downstream branching via `bLastConditionResult` when the VM reads it on resume
- `EndAction()` is simply `EndActionWithResult(true)`

**Use cases:**
- Actions that can fail (e.g., montage interrupted, network timeout)
- Actions that produce a boolean outcome (e.g., line trace hit/miss)
- Branching after async completion

---

## 10. Inline Execution Fallback

When `OP_CustomAction` fires during **inline execution** (no active `FStatusInstance`), the handler creates one on demand:

```cpp
if (!Context.Instance)
{
    UStatsX_WorldSubsystem* Subsystem = Context.GetSubsystem();
    int64 NewStatusID = Subsystem->RegisterAsActiveInstance();
    // Context.Instance is now set by RegisterAsActiveInstance
}
```

This ensures actions can always suspend/resume, even when called from contexts that don't normally have a persistent instance. The pool manages the newly created instance like any other.

---

## 11. Performance Instrumentation

| Stat Name | Scope |
|-----------|-------|
| `StatsX.CustomLogic.ExecuteAction` | Full OP_CustomAction handler |
| `StatsX.CustomLogic.MarkAsExecuting` | `MarkAsExecuting()` — state setup before Execute |
| `StatsX.CustomLogic.EndAction` | `EndActionWithResult()` — resumption signal |
| `StatsX.CustomLogic.SetupContext` | Context injection (inherited from base) |
| `StatsX.CustomLogic.ClearContext` | Context cleanup (inherited from base) |
| `StatsX.CustomLogic.InjectForgeParams` | Property injection (inherited from base) |

---

## 12. API Reference

### UForgeCustomAction

| Category | Method | Signature |
|----------|--------|-----------|
| **Execution** | `Execute` | `void Execute()` — BlueprintNativeEvent |
| **Execution** | `ChainableAction` | `bool ChainableAction()` — BlueprintNativeEvent |
| **Continuation** | `EndAction` | `void EndAction()` — BlueprintCallable |
| **Continuation** | `EndActionWithResult` | `void EndActionWithResult(bool bSuccess)` — BlueprintCallable |
| **State** | `IsExecuting` | `bool IsExecuting() const` — BlueprintPure |
| **System** | `MarkAsExecuting` | `void MarkAsExecuting(UStatsX_WorldSubsystem*)` |

### Inherited from UForgeCustomLogicBase

See [12 — Custom Logic — Check](12_Custom_Logic_Check.md#12-api-reference) for:
- Context accessors (GetCasterActor, GetTargetActor, etc.)
- Variable accessors (GetVariable*, SetVariable*)
- Lifecycle hooks (Cancel, Cleanup)
- ForgeParam injection (InjectForgeParams)

### Handler Registration

| OpCode | Name | Handler |
|--------|------|---------|
| 256 | `OP_CustomAction` | `Nodes_CustomLogic::ExecuteCustomAction` |

### Related Instance State

| Field | Type | Role |
|-------|------|------|
| `FStatusInstance::ActiveCustomLogic` | `TObjectPtr<UForgeCustomLogicBase>` | GC protection during async gap |
| `FStatusInstance::SavedPC` | `int32` | PC to resume from after EndAction |
| `FStatusInstance::SuspendTimer` | `float` | `-1.f` = infinite wait; `0.f` = ready to resume |
| `FStatusInstance::State` | `EStatusInstanceState` | `Suspended` during async; `Active` after EndAction |

### EStatusInstanceState

```cpp
enum class EStatusInstanceState : uint8
{
    Inactive,
    Pending,        // Queued for activation
    Active,         // Running normally
    Suspended,      // Paused (e.g. inside an async action)
    Terminating,    // Cleanup in progress
};
```

---

*Document generated from source — Stats_X v1.404*
