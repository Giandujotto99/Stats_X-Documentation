# 07 — ForgeVM

> **Stats_X v1.404** — Forge Virtual Machine
> Singleton bytecode executor with flat handler dispatch, single global context,
> and handler-driven instance lifecycle.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Singleton Architecture](#2-singleton-architecture)
3. [Global Context Model](#3-global-context-model)
4. [Handler Dispatch Table](#4-handler-dispatch-table)
5. [Primary API — ExecuteStatus](#5-primary-api--executestatus)
6. [Primary API — ResumeInstance](#6-primary-api--resumeinstance)
7. [Execution Loop](#7-execution-loop)
8. [System OpCodes (0–31)](#8-system-opcodes-031)
9. [Variable Blob Initialisation](#9-variable-blob-initialisation)
10. [Variable Overrides](#10-variable-overrides)
11. [Nested Execution](#11-nested-execution)
12. [Function Call ABI](#12-function-call-abi)
13. [Safety Mechanisms](#13-safety-mechanisms)
14. [Performance Instrumentation](#14-performance-instrumentation)
15. [Lifecycle Summary](#15-lifecycle-summary)
16. [Class Reference](#16-class-reference)

---

## 1. Design Philosophy

ForgeVM is not a general-purpose scripting engine — it is a **tight, deterministic bytecode executor** purpose-built for the Status lifecycle.  Every design choice serves three goals:

| Goal | Mechanism |
|------|-----------|
| **Zero per-execution allocation** | Single `FForgeVMContext` reused across all calls |
| **Minimal dispatch overhead** | Flat function-pointer table — one indexed dereference, no vtable |
| **Handler autonomy** | The VM never decides when to create an instance — handlers do |

The VM itself is **stateless between executions**: it owns no persistent data about any running status.  All persistence lives in `FStatusInstance` (pool-managed) and the compiled `UPDA_StatusDefinition` (asset-managed).

---

## 2. Singleton Architecture

```
┌─────────────────────────────────────────────┐
│  FForgeVM  (Meyer's Singleton)              │
│                                             │
│  static FForgeVM& Get()                     │
│  {                                          │
│      static FForgeVM Instance;              │
│      return Instance;                       │
│  }                                          │
│                                             │
│  ┌──────────────────────────────────┐       │
│  │ FForgeVMContext  GlobalContext    │       │
│  └──────────────────────────────────┘       │
│  ┌──────────────────────────────────┐       │
│  │ TArray<FForgeNodeFunc> Handlers  │ 65536 │
│  └──────────────────────────────────┘       │
└─────────────────────────────────────────────┘
```

- **One instance, one context, one handler table** — there is no VM-per-world or VM-per-component.
- Construction pre-allocates the handler table with 65 536 entries (one per possible 16-bit OpCode), each initialised to a safe `UnregisteredHandler` stub.
- Context stacks are pre-reserved at construction to minimise runtime allocations:

| Buffer | Reserved Size |
|--------|---------------|
| `ContextStack` | 256 bytes |
| `ContextObjectStack` | 16 entries |
| `FlowBlockStack` | 8 entries |
| `FunctionCallStack` | 8 frames |
| `FunctionArgSlots` | 16 entries |
| `FunctionArgBlob` | 128 bytes |
| `FunctionArgObjectPool` | 8 entries |

---

## 3. Global Context Model

The VM operates through a **single `FForgeVMContext`** that is reset and repopulated at the start of every `ExecuteStatus()` or `ResumeInstance()` call.

```
ExecuteStatus()         ResumeInstance()
      │                        │
      ▼                        ▼
   Reset(StatusID,          Reset(StatusID,
         Definition,              Definition,
         nullptr)                 Instance)
      │                        │
      ├─ Set CasterActor      ├─ Restore from Instance
      ├─ Set TargetActor      ├─ Restore PC (or OverridePC)
      ├─ Cache Components     ├─ Allocate stacks
      ├─ Allocate stacks      ├─ Pre-size array pool
      ├─ Init VariableBlob    ├─ Load function state
      ├─ Init array pool      │
      ├─ Apply overrides      │
      │                        │
      └──── Execute() ◄───────┘
```

Key principle: **the context is transient**.  After `Execute()` returns, any data that must survive is migrated to `FStatusInstance` by the handler that promoted the execution to an instance.

### Component Caching

During context setup the VM performs `FindComponentByClass<UStatsX_StatsComponentBase>()` on both Caster and Target actors **once**, caching the result in `GlobalContext.CasterComponent` / `GlobalContext.TargetComponent`.  Handlers never repeat this lookup.

---

## 4. Handler Dispatch Table

```cpp
// Flat array — index IS the OpCode
TArray<FForgeNodeFunc> Handlers;   // 65536 entries

// typedef
typedef EForgeExecutionResult(*FForgeNodeFunc)(
    FForgeVMContext& Context,
    const FStatusInstruction& Instr);
```

### OpCode Ranges

| Range | Purpose | Dispatch Path |
|-------|---------|---------------|
| `0–31` | **System OpCodes** | Inline `switch` in `ExecuteSystemOp()` |
| `32–9999` | **Built-in Node Handlers** | `Handlers[OpCode](Context, Instr)` |
| `10 000–65 535` | **User / Custom Handlers** | `Handlers[OpCode](Context, Instr)` |

### Registration

```cpp
void RegisterHandler(uint16 OpCode, FForgeNodeFunc HandlerFunc);
```

Handlers are registered at module startup via `RegisterBuiltInHandlers()` and supplemented by `ForgeNodeRegistry_Runtime`.  Invalid OpCodes fall through to `UnregisteredHandler` which returns `EForgeExecutionResult::Error`.

### Dispatch Cost

For user/built-in OpCodes the dispatch is a **single indexed array dereference followed by an indirect function call** — no virtual table, no map lookup, no string comparison.

```
ExecuteStep()
  ├─ OpCode < 32  →  ExecuteSystemOp(OpCode, Instr)   // inline switch
  └─ OpCode ≥ 32  →  PC++; Handlers[OpCode](Ctx, Instr) // one dereference
```

Note: for user handlers, `PC` is incremented **before** the handler call.  System ops manage their own PC advancement.

---

## 5. Primary API — ExecuteStatus

```cpp
EForgeExecutionResult ExecuteStatus(
    int64         StatusID,
    const UPDA_StatusDefinition*  Definition,
    AActor*       CasterActor,
    AActor*       TargetActor,
    const TArray<FForgeVariableOverride>* Overrides = nullptr);
```

This is the **entry point for all new status execution**.  The StatusID is pre-generated by `UStatsX_GameInstanceSubsystem` and passed in — the VM does not allocate IDs.

### Execution Sequence

```
1. Guard: null Definition check
2. Nested execution: save GlobalContext if depth > 0
3. Increment thread_local GForgeVmExecutionDepth
4. Reset GlobalContext (StatusID, Definition, Instance=nullptr)
5. Set CasterActor / TargetActor, cache Components
6. Allocate ContextStack (Definition->ContextStackSize)
7. Initialise VariableBlob:
   a. Allocate blob (Definition->VariableBlobSize)
   b. Copy defaults from Pool_StructData
   c. Remap pool-backed Object/Class defaults → ContextObjectStack indices
   d. Reconstruct GameplayTag/TagContainer from Pool_Tags
8. Initialise ContextArrayPool (Definition->ArraySlotCount)
   a. Per-slot default initialisation from pool
   b. ResetTransientArrays()
9. Apply variable overrides (if any)
10. Execute()
11. If GlobalContext.Instance set (handler promoted): PersistFunctionStateToInstance()
12. Decrement depth, restore saved context if nested
13. Return result
```

### Key Insight — Handler-Driven Lifecycle

The VM **never creates a pool instance**.  The `OP_Start` handler (or any handler in the graph) decides whether the status should become a tracked instance.  If it does, the handler calls `Pool.Acquire()` and sets `GlobalContext.Instance`.  If no handler promotes the execution, it runs as a fire-and-forget inline computation.

---

## 6. Primary API — ResumeInstance

```cpp
EForgeExecutionResult ResumeInstance(
    FStatusInstance* Instance,
    int32 OverridePC = INDEX_NONE);
```

Called by the pool tick (`StatsX_WorldSubsystem`) when a suspended instance's timer expires or its scheduled tick interval fires.

### Execution Sequence

```
1. Guard: null Instance / Definition check
2. Nested execution: save GlobalContext if depth > 0
3. Increment GForgeVmExecutionDepth
4. Reset GlobalContext (StatusID, Definition, Instance)
5. Restore actor/component references from Instance
6. Set PC = OverridePC (if != INDEX_NONE) else Instance->SavedPC
7. Allocate ContextStack
8. Allocate VariableBlob (safety allocation)
9. Pre-size ContextArrayPool to ArraySlotCount
   (Variable slot handles redirect to Instance->ArrayPool via ResolveArraySlot)
10. ResetTransientArrays()
11. LoadFunctionStateFromInstance()
12. Execute()
13. PersistFunctionStateToInstance()
14. Decrement depth, restore saved context if nested
15. Return result
```

### OverridePC — Event Handler Interrupts

When an async event fires (e.g., a Gameplay Event trigger), the pool tick calls `ResumeInstance(Instance, EventHandlerPC)` instead of resuming from `SavedPC`.  This runs the event handler as an "interrupt" — the primary async node's `SavedPC` and `SuspendTimer` remain untouched.  The event handler terminates with `OP_EndAsyncEvent`, which re-suspends the instance with `bWaitingForAsyncEvents = true`.

---

## 7. Execution Loop

### Execute()

```
while (PC < InstructionCount)
{
    if (InstructionsExecuted++ > 10000)  → Error (infinite loop protection)

    Result = ExecuteStep()

    if (Result != Continue)  → return Result
}
return Completed   // Fell off the end of bytecode
```

- The 10 000 instruction limit is a hard safety net.  It is counted **per Execute() call**, not per frame.
- A single `Execute()` call handles the entire run-to-completion or run-to-suspension path.

### ExecuteStep()

```
Fetch:   Instr = Definition->Instructions[PC]
Decode:  OpCode = Instr.GetOpCode()

Dispatch:
  OpCode < 32  →  ExecuteSystemOp(OpCode, Instr)
  OpCode ≥ 32  →  PC++; Handlers[OpCode](Context, Instr)
```

The PC pre-increment for user handlers means most handlers never need to touch `PC`.  Only flow-control handlers (Jump, Branch, Loop) set it explicitly.

---

## 8. System OpCodes (0–31)

System OpCodes are handled inline in `ExecuteSystemOp()` — no function-pointer indirection.

### Complete System OpCode Table

| OpCode | Constant | Description |
|--------|----------|-------------|
| 0 | `OP_Start` | Entry point marker — increments PC |
| 1 | `OP_Jump` | Unconditional jump to `Data0[24..39]` |
| 2 | `OP_JumpIfFalse` | Reads bool from source; jumps to `Data0[24..39]` if false |
| 3 | `OP_JumpTable` | Switch dispatch: reads int32, scans `ContinueData` slots for match → jump |
| 4 | `OP_Nop` | No operation — increments PC |
| 5 | `OP_BeginBlock` | Pushes `FForgeFlowBlock` onto `FlowBlockStack` |
| 6 | `OP_EndBlock` | Pops flow block, resets `TimeSinceLastTick` to –1, jumps to flow node |
| 7 | `OP_ContinueData` | Pure data slot — never executed directly (skipped by preceding handler) |
| 8 | `OP_BeginEventBlock` | Marker for event/function block start — increments PC |
| 9 | `OP_EndEventBlock` | End of event/function block — copies return values, pops call frame |
| 10 | `OP_CallFunction` | Captures args, pushes call frame, jumps to target block |
| 11 | `OP_EndAsyncEvent` | End of async event handler — re-suspends instance |
| 12–31 | — | Reserved for future system use |

### Detailed Behaviour

#### OP_Jump (1)

```
TargetPC = Instr.ExtractBits(0, 24, 16)
PC = TargetPC
```

#### OP_JumpIfFalse (2)

```
Source   = Instr.ExtractBits(0, 56, 8)    // EForgeDataSource
Payload  = Instr.ExtractBits(0, 40, 16)   // pool index or offset
TargetPC = Instr.ExtractBits(0, 24, 16)

Value = ReadTypedFromSource<bool>(Source, Payload)
if (!Value) → PC = TargetPC
else        → PC++
```

#### OP_JumpTable (3)

```
Source  = Instr.ExtractBits(0, 56, 8)
Payload = Instr.ExtractBits(0, 40, 16)
Count   = Instr.ExtractBits(0, 24, 16)

Value = ReadTypedFromSource<int32>(Source, Payload)

// Scan ContinueData slots at PC+1 .. PC+Count
for i in [0..Count):
    ContinueInstr = Instructions[PC + 1 + i]
    CaseValue     = ContinueInstr.ExtractBits(0, 24, 16)  // signed
    JumpTarget    = ContinueInstr.ExtractBits(0, 40, 16)

    if (Value == CaseValue) → PC = JumpTarget; return Continue

// Default: fall through
DefaultTarget = Instr.ExtractBits(1, 0, 16)
PC = DefaultTarget
```

#### OP_BeginBlock (5)

```
FlowNodeIdx   = Instr.ExtractBits(0, 24, 16)
OnCompletedPC = Instr.ExtractBits(0, 40, 16)
LoopCount     = Instr.ExtractBits(1, 0, 16)   // 0 for non-loop blocks

Push FForgeFlowBlock { BeginPC=PC, OnCompletedPC, BlockIndex=0, LoopCount }
PC++
```

#### OP_EndBlock (6)

```
FlowNodeIdx = Instr.ExtractBits(0, 24, 16)

// Reset TimeSinceLastTick sentinel to -1.0 so owning flow node
// can distinguish EndBlock from a pool-tick or timer-driven resume
Instance->TimeSinceLastTick = -1.f

PC = FlowNodeIdx   // Jump back to flow node for next decision
```

This sentinel reset prevents misinterpretation when async child completions flow through inline to a parent's `EndBlock` — without it, the parent would see a positive `TimeSinceLastTick` and treat the re-entry as a pool tick.

#### OP_EndEventBlock (9)

Handles function return values and call-frame cleanup:

```
ReturnDescIdx = Instr.ExtractBits(0, 24, 16)

if (FunctionCallStack not empty):
    // Function return path
    1. Read return descriptor and output-target descriptor
    2. Validate arity match (ReturnCount == TargetCount)
    3. Validate type match per entry (FieldType equality)
    4. CopyFunctionReturnValue() for each return slot
    5. Pop call frame: shrink FunctionCallStack, ArgSlots, ArgBlob, ObjectPool
    6. PC = ReturnPC

    // On any validation error: still clean up frame, then return Error

if (FunctionCallStack empty):
    // External event trigger finished
    return Completed
```

#### OP_CallFunction (10)

```
TargetIndex    = Instr.ExtractBits(0, 24, 16)
ArgDescIdx     = Instr.ExtractBits(0, 40, 16)
OutTargetDescIdx = Instr.ExtractBits(1, 0, 16)

// Validate: stack depth < 32, target exists and is OP_BeginEventBlock
// Validate: descriptor indices and ranges

Frame = {
    ReturnPC = PC + 1,
    OutTargetDescriptorIndex = OutTargetDescIdx,
    ArgStartIndex = FunctionArgSlots.Num(),
    ArgBlobStartOffset = FunctionArgBlob.Num(),
    ObjectStartIndex = FunctionArgObjectPool.Num()
}

// Capture arguments from IODescriptor entries
for each entry in ArgDesc:
    CaptureFunctionArg(Context, Entry)   // pushes to ArgSlots/Blob/ObjectPool

Frame.ArgCount = FunctionArgSlots.Num() - Frame.ArgStartIndex
FunctionCallStack.Push(Frame)
PC = TargetIndex
```

#### OP_EndAsyncEvent (11)

```
Instance->State = Suspended
Instance->SetWaitingForAsyncEvents(true)
return Suspended
```

Used exclusively by async event handlers that were entered via `OverridePC`.  The handler must not corrupt the primary async node's `SavedPC` or `SuspendTimer`.

---

## 9. Variable Blob Initialisation

During `ExecuteStatus()`, the VariableBlob is initialised in multiple passes:

### Pass 1 — Bulk Default Copy

```
Allocate VariableBlob (Definition->VariableBlobSize bytes)
Copy raw defaults from Pool_StructData via VariableDefaultsHeaderIndex
```

This copies the flat byte block compiled by the editor, which contains correct scalar values but uses **pool indices** for Object/Class references and may contain stale tag bytes.

### Pass 2 — Pool-Backed Fixup

Iterate all `FForgeVariableHeader` entries:

| Field Type | Fixup Action |
|------------|--------------|
| **Object / Class** (scalar) | Read `uint16` pool index from blob → resolve to `UObject*` via `Pool_Objects`/`Pool_Classes` → allocate into `ContextObjectStack` → write new `uint16` context index back into blob |
| **GameplayTag** (scalar) | Reconstruct from `Pool_Tags[DefaultValuePoolIndex]` → `Memcpy` into blob |
| **GameplayTagContainer** | Reconstruct from `Pool_ArraysHeaders` → copy up to `Header.Count` tags from `Pool_Tags` → write count prefix + tag array into blob |
| **Array / Set containers** | Skipped (handled by ArraySlot initialisation) |
| **All other scalars** | Already correct from Pass 1 |

### Pass 3 — Array Slot Initialisation

```
ContextArrayPool.SetNum(Definition->ArraySlotCount)

for each slot:
    InitializeArraySlotDefaults(Context, Definition, SlotIndex, Slot)

ResetTransientArrays()   // Keep only variable slots, reset transient count
```

---

## 10. Variable Overrides

After default initialisation and before `Execute()`, runtime overrides are applied via `ApplyVariableOverrides()`.

```cpp
void ApplyVariableOverrides(const TArray<FForgeVariableOverride>& Overrides);
```

### Override Resolution

```
for each Override:
    Header = Definition->FindVariable(Override.VariableTag)  // binary search

    Skip if: not found, or Array/Set container (handle corruption risk)

    if Override.bIsObjectOverride:
        CtxIdx = AllocContextObject(Override.ObjectValue)
        Memcpy(Blob + Offset, &CtxIdx, sizeof(uint16))
    else:
        // Editor-only: validate size matches expected type size
        Memcpy(Blob + Offset, Override.RawValue.GetData(), ValueSize)
```

### Supported Override Types

| FieldType | ID | Override Size |
|-----------|----|---------------|
| Float | 1 | 4 bytes |
| Int32 | 2 | 4 bytes |
| Bool | 3 | 1 byte |
| GameplayTag | 4 | `sizeof(FGameplayTag)` |
| Enum | 6 | 4 bytes |
| Name | 9 | `sizeof(FName)` |
| Byte | 11 | 1 byte |
| Int64 | 12 | 8 bytes |
| Double | 13 | 8 bytes |
| Vector | 14 | `sizeof(FVector)` |
| Rotator | 15 | `sizeof(FRotator)` |
| Transform | 16 | `sizeof(FTransform)` |
| LinearColor | 17 | `sizeof(FLinearColor)` |
| Object | 5 | Via `AllocContextObject` |
| Class | 8 | Via `AllocContextObject` |

**Array/Set variables cannot be overridden** — the blob holds a `uint16` handle; overwriting it would corrupt the array pool mapping.

---

## 11. Nested Execution

A handler may call `ExecuteStatus()` during its own execution (e.g., applying a secondary status as a reaction).  The VM supports this via a **thread_local depth counter and context save/restore**.

```cpp
namespace { thread_local int32 GForgeVmExecutionDepth = 0; }
```

### Nested Execution Flow

```
Handler_A running at depth 0
  │
  ├─ Calls ExecuteStatus() for a secondary status
  │     │
  │     ├─ bIsNestedExecution = (depth > 0) → true
  │     ├─ SavedCallerContext = GlobalContext  (full copy)
  │     ├─ ++depth → 1
  │     ├─ Reset GlobalContext for new status
  │     ├─ Execute() inner status
  │     ├─ --depth → 0
  │     └─ GlobalContext = MoveTemp(SavedCallerContext)  (restore)
  │
  └─ Handler_A continues with original context intact
```

The save/restore is a **full value copy** of `FForgeVMContext`, including all transient stacks.  This is safe because:
- The inner execution completely replaces the context
- On return, `MoveTemp` restores the original without redundant copies
- `thread_local` ensures no cross-thread contention

---

## 12. Function Call ABI

ForgeVM supports **intra-definition function calls** via `OP_CallFunction` / `OP_EndEventBlock`.

### Call Frame Structure

```
FForgeFunctionCallFrame
├── ReturnPC                    // PC to resume after return
├── OutTargetDescriptorIndex    // Where to write return values
├── ArgStartIndex               // Snapshot: FunctionArgSlots.Num()
├── ArgBlobStartOffset          // Snapshot: FunctionArgBlob.Num()
├── ObjectStartIndex            // Snapshot: FunctionArgObjectPool.Num()
└── ArgCount                    // Number of captured arguments
```

### Argument Capture

Arguments are described by `FForgeFunctionIODescriptor` → `FForgeFunctionIOEntry` arrays.  Each entry specifies:
- `FieldType` — the data type
- `Source` — where to read (Literal, Context, Instance, CallFrame)
- `Payload` — pool index or byte offset

`CaptureFunctionArg()` copies each argument value into `FunctionArgSlots` / `FunctionArgBlob` / `FunctionArgObjectPool`.  Inside the callee, arguments are accessed via `EForgeDataSource::CallFrame`.

### Return Value Copy

`OP_EndEventBlock` copies return values from the callee's output locations to the caller's target locations:
1. Validate return descriptor exists and range is valid
2. Validate output-target descriptor exists and range is valid
3. Assert arity match: `ReturnCount == TargetCount`
4. Assert per-entry type match: `SourceEntry.FieldType == TargetEntry.FieldType`
5. `CopyFunctionReturnValue()` for each slot

On **any** validation error, the call frame is **always cleaned up** (ArgSlots/ArgBlob/ObjectPool truncated to snapshot sizes) to keep the stack consistent — then `Error` is returned.

### Stack Depth Limit

```cpp
if (FunctionCallStack.Num() >= 32)
    return Error;  // "Function call stack overflow — possible infinite recursion"
```

### Suspend/Resume Across Function Boundaries

When execution suspends inside a function call:
- `PersistFunctionStateToInstance()` saves the entire call stack, arg slots, arg blob, and object pool into the instance
- On `ResumeInstance()`, `LoadFunctionStateFromInstance()` restores them
- Execution resumes at the exact instruction within the callee

---

## 13. Safety Mechanisms

| Mechanism | Protection |
|-----------|------------|
| **10 000 instruction limit** | Prevents infinite loops from blocking the game thread |
| **32-frame call stack limit** | Prevents infinite recursion in function calls |
| **`UnregisteredHandler` stub** | All 65 536 handler slots default to a safe error handler |
| **Null Definition guards** | Every entry point validates Definition pointer |
| **Descriptor range validation** | Function I/O descriptors are bounds-checked before access |
| **Type match validation** | Return value copies verify `FieldType` equality per entry |
| **Editor-only override size checks** | `WITH_EDITOR` builds validate override byte sizes match expected type sizes |
| **Nested execution isolation** | Thread-local depth counter + context save/restore |
| **EndBlock sentinel reset** | `TimeSinceLastTick = -1` prevents async completion misinterpretation |

---

## 14. Performance Instrumentation

Every major VM path is wrapped with `STATSX_VM_SCOPE`:

| Scope | Stat Name | Path |
|-------|-----------|------|
| `StatsX.VM.Resume` | `STAT_StatsXVMResume` | `ResumeInstance()` |
| `StatsX.VM.Execute` | `STAT_StatsXVMExecute` | `Execute()` |
| `StatsX.VM.ExecuteStep` | `STAT_StatsXVMExecuteStep` | `ExecuteStep()` |

These are available in the UE5 profiler under the `StatsX` category for per-frame and per-instance cost analysis.

---

## 15. Lifecycle Summary

```
                      ┌──────────────────┐
                      │  StatusDefinition │  (compiled asset)
                      │  - Instructions   │
                      │  - Literal Pools  │
                      │  - Variable Table │
                      └────────┬─────────┘
                               │
               ┌───────────────┼───────────────┐
               ▼                               ▼
     ┌─────────────────┐             ┌─────────────────┐
     │  ExecuteStatus() │             │ ResumeInstance() │
     │                  │             │                  │
     │ Setup context    │             │ Restore context  │
     │ Init variables   │             │ from Instance    │
     │ Apply overrides  │             │ Load func state  │
     └────────┬────────┘             └────────┬────────┘
              │                               │
              └───────────┬───────────────────┘
                          ▼
                   ┌─────────────┐
                   │  Execute()   │
                   │  while loop  │
                   └──────┬──────┘
                          │
                   ┌──────▼──────┐
                   │ ExecuteStep()│
                   │             │
                   │ OpCode < 32 │──── ExecuteSystemOp()
                   │ OpCode ≥ 32 │──── Handlers[OpCode]()
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         Completed    Suspended     Error
              │           │
              │     ┌─────▼──────┐
              │     │ SavedPC    │
              │     │ persisted  │
              │     │ to Instance│
              │     └─────┬──────┘
              │           │
              │     (pool tick fires)
              │           │
              │     ResumeInstance()
              │           │
              └───────────┘
```

---

## 16. Class Reference

### FForgeVM

| Member | Type | Description |
|--------|------|-------------|
| `GlobalContext` | `FForgeVMContext` | Single reusable execution context |
| `Handlers` | `TArray<FForgeNodeFunc>` | 65 536-entry flat dispatch table |

### Public API

| Method | Signature | Description |
|--------|-----------|-------------|
| `Get()` | `static FForgeVM&` | Meyer's singleton accessor |
| `ExecuteStatus()` | `(int64, UPDA_StatusDefinition*, AActor*, AActor*, TArray<FForgeVariableOverride>*) → EForgeExecutionResult` | Execute a status definition inline |
| `ResumeInstance()` | `(FStatusInstance*, int32 OverridePC) → EForgeExecutionResult` | Resume a suspended instance |
| `Execute()` | `() → EForgeExecutionResult` | Run GlobalContext to completion/suspension |
| `ExecuteStep()` | `() → EForgeExecutionResult` | Execute single instruction (debug) |
| `GetContext()` | `FForgeVMContext&` | Context access for handlers |
| `RegisterHandler()` | `(uint16, FForgeNodeFunc) → void` | Register handler for OpCode |
| `RegisterBuiltInHandlers()` | `() → void` | Module startup registration |
| `Shutdown()` | `() → void` | Reset all handlers to default |

### EForgeExecutionResult

| Value | Meaning |
|-------|---------|
| `Continue` | Proceed to next instruction |
| `Completed` | Execution finished (reached end or `OP_EndEventBlock` with empty stack) |
| `Suspended` | Async node requested suspension (Delay, WaitForEvent, etc.) |
| `Aborted` | Manual abort triggered |
| `Error` | Runtime error (see `Context.LastError`) |

### FForgeNodeFunc

```cpp
typedef EForgeExecutionResult(*FForgeNodeFunc)(
    FForgeVMContext& Context,
    const FStatusInstruction& Instr);
```

Stateless function pointer — no object, no vtable, no closure.  Handlers read all data from the instruction payload and context.

---

*Stats_X v1.404 — ForgeVM*
