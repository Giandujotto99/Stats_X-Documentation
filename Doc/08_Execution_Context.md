# 08 — Execution Context

> **Stats_X v1.404** — FForgeVMContext
> Transient execution state: the single shared scratchpad through which every
> handler reads inputs, writes outputs, and accesses the running status.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Struct Overview](#2-struct-overview)
3. [Lifetime & Reset Semantics](#3-lifetime--reset-semantics)
4. [Data Sources (EForgeDataSource)](#4-data-sources-eforgedatasource)
5. [Memory Regions](#5-memory-regions)
6. [Object Indirection — GC-Safe Pattern](#6-object-indirection--gc-safe-pattern)
7. [Array Indirection](#7-array-indirection)
8. [Data Access Templates](#8-data-access-templates)
9. [Inline Literal Packing](#9-inline-literal-packing)
10. [Output Writing](#10-output-writing)
11. [Function Call Frame Access](#11-function-call-frame-access)
12. [Flow Control Stack](#12-flow-control-stack)
13. [Interceptor Payload](#13-interceptor-payload)
14. [Branching Registers](#14-branching-registers)
15. [Continuation Instructions](#15-continuation-instructions)
16. [Subsystem Access](#16-subsystem-access)
17. [Error Reporting](#17-error-reporting)
18. [Function State Persistence](#18-function-state-persistence)
19. [Debug-Only Facilities](#19-debug-only-facilities)
20. [Literal Pool Specialisations](#20-literal-pool-specialisations)
21. [Complex Type Specialisations](#21-complex-type-specialisations)
22. [Struct Reference](#22-struct-reference)

---

## 1. Design Philosophy

`FForgeVMContext` exists for one purpose: **eliminate per-execution allocation**.

The VM owns a single `GlobalContext` that is reset and repopulated at the start of every `ExecuteStatus()` or `ResumeInstance()` call.  All internal arrays use `SetNum(0, EAllowShrinking::No)` — capacity survives across executions, only logical size resets to zero.  After a few warm-up frames, the context reaches a high-water mark and performs zero heap allocations for the remainder of the session.

The context is **transient by contract**: any data that must survive beyond `Execute()` is migrated to `FStatusInstance` by the handler that promoted the execution.  The context itself never persists.

---

## 2. Struct Overview

```
USTRUCT()
struct FForgeVMContext
{
    // ── Execution State ──────────────────────────
    int64                StatusID;
    int32                PC;
    UPDA_StatusDefinition* Definition;
    FStatusInstance*      Instance;          // nullptr for inline execution

    // ── Actor & Component Refs ───────────────────
    TWeakObjectPtr<AActor>                    CasterActor;
    TWeakObjectPtr<AActor>                    TargetActor;
    TWeakObjectPtr<UStatsX_StatsComponentBase> CasterComponent;
    TWeakObjectPtr<UStatsX_StatsComponentBase> TargetComponent;

    // ── Stack Memory ─────────────────────────────
    TArray<uint8>              ContextStack;          // Transient byte blob
    TArray<UObject*>           ContextObjectStack;    // GC-tracked objects (UPROPERTY)
    TArray<uint8>              VariableBlob;           // Dedicated variable storage
    TArray<FForgeArraySlot>    ContextArrayPool;       // Dynamic arrays
    uint16                     ActiveTransientArrays;

    // ── Flow Control ─────────────────────────────
    TArray<FForgeFlowBlock>    FlowBlockStack;

    // ── Function Call ABI ────────────────────────
    TArray<FForgeFunctionCallFrame>  FunctionCallStack;
    TArray<FForgeFunctionArgSlot>    FunctionArgSlots;
    TArray<uint8>                    FunctionArgBlob;
    TArray<UObject*>                 FunctionArgObjectPool;  // (UPROPERTY)

    // ── Interceptor Payload ──────────────────────
    const FForgePayloadEntry*  ActivePayloadEntries;
    uint16                     ActivePayloadCount;

    // ── Branching Registers ──────────────────────
    bool   bLastConditionResult;
    int32  LastSwitchValue;

    // ── Error State ──────────────────────────────
    FString LastError;

    // ── Debug Only (WITH_EDITOR) ─────────────────
    TArray<FString> ContextStringStack;
};
```

---

## 3. Lifetime & Reset Semantics

### Reset()

Called at the start of every `ExecuteStatus()` and `ResumeInstance()`:

```cpp
void Reset(int64 InStatusID,
           const UPDA_StatusDefinition* InDefinition,
           FStatusInstance* InInstance);
```

| Field | Reset Action |
|-------|-------------|
| `StatusID`, `Definition`, `Instance` | Assigned from parameters |
| `PC` | Set to 0 |
| `CasterActor`, `TargetActor`, `CasterComponent`, `TargetComponent` | `.Reset()` (caller sets after) |
| `bLastConditionResult`, `LastSwitchValue` | Zeroed |
| `LastError` | `.Empty()` |
| `ContextStack` | `Memzero` (preserves allocation) |
| `VariableBlob` | `Memzero` (preserves allocation) |
| `ContextObjectStack` | `SetNum(0, No)` (preserves capacity) |
| `FlowBlockStack` | `SetNum(0, No)` |
| `FunctionCallStack` | `SetNum(0, No)` |
| `FunctionArgSlots` | `SetNum(0, No)` |
| `FunctionArgBlob` | `SetNum(0, No)` |
| `FunctionArgObjectPool` | `SetNum(0, No)` |
| `ContextArrayPool` | `SetNum(0, No)` |
| `ActiveTransientArrays` | 0 |
| `ContextStringStack` (editor) | `SetNum(0, No)` |

**Key principle:** `EAllowShrinking::No` on every `SetNum(0)` call ensures the underlying TArray capacity is never deallocated between executions.

### AllocateStack / AllocateVariableBlob

```cpp
void AllocateStack(int32 SizeInBytes);
void AllocateVariableBlob(int32 SizeInBytes);
```

Both follow the same pattern:
1. If current size differs from requested → `SetNumUninitialized(SizeInBytes)`
2. If size > 0 → `Memzero` to guarantee clean reads

These are called by the VM after `Reset()` — the size comes from the compiled `Definition->ContextStackSize` and `Definition->VariableBlobSize`.

---

## 4. Data Sources (EForgeDataSource)

Every data operand in an instruction encodes a **2-bit source flag** followed by a **16-bit payload**:

```
┌──────────┬──────────────────┐
│ Source(2) │   Payload(16)    │  = 18 bits per operand
└──────────┴──────────────────┘
```

| Value | Name | Payload Meaning | Storage |
|-------|------|-----------------|---------|
| 0 | **Literal** | Pool index into Definition pools | Immutable, compiled |
| 1 | **Context** | Byte offset into `ContextStack` | Transient, per-tick |
| 2 | **Instance** | Byte offset into `Instance->InstanceBlob` | Persistent, cross-tick |
| 3 | **CallFrame** | Argument index into current `FForgeFunctionCallFrame` | Per-function-call |

### Source Resolution Hierarchy

```
ReadValue<T>(Instr, DataSlot, StartBit)
  │
  ├─ Literal  → ReadLiteral<T>(PoolIndex)
  │               └─ Definition->Pool_Floats/Ints/Bools/Tags/...
  │
  ├─ Context  → ReadFromMemory<T>(ContextStack, Offset)
  │               └─ Memcpy from transient byte blob
  │
  ├─ Instance → ReadFromInstanceBlob<T>(Offset)
  │               └─ Memcpy from Instance->InstanceBlob
  │
  └─ CallFrame → ReadCallFrameValue<T>(ArgIndex)
                    └─ Slot lookup → Memcpy from FunctionArgBlob
```

---

## 5. Memory Regions

The context manages four distinct memory regions, each serving a different lifecycle:

### 5.1 ContextStack — Transient Byte Blob

```
TArray<uint8> ContextStack;
```

- **Lifecycle:** Allocated once per definition, zero-initialised each execution
- **Purpose:** Temporary inter-node data passing (pin connections in the graph)
- **Addressing:** Byte offset, compiler-assigned at compile time
- **Size:** `Definition->ContextStackSize` (typically 64–512 bytes)

Scalars are stored inline (`float` at offset N = 4 bytes).  Object references store a `uint16` index into `ContextObjectStack` (see Section 6).

### 5.2 VariableBlob — Dedicated Variable Storage

```
TArray<uint8> VariableBlob;
```

- **Lifecycle:** Allocated per execution, initialised from pool defaults, overridden, then used
- **Purpose:** Variable values during inline (no-instance) execution
- **Addressing:** Byte offset from `FForgeVariableHeader::Offset`
- **Size:** `Definition->VariableBlobSize`
- **Instance promotion:** When a handler creates an instance, variable data migrates to `Instance->VariableBlob`.  After promotion, handlers read/write directly from `Instance->VariableBlob` via the Instance data source.

### 5.3 ContextArrayPool — Dynamic Arrays

```
TArray<FForgeArraySlot> ContextArrayPool;
uint16 ActiveTransientArrays;
```

- **Layout:** `[0..ArraySlotCount)` = variable arrays, `[ArraySlotCount..)` = transient (MakeArray, etc.)
- **Handle:** `uint16` index into the pool
- **Instance redirection:** When `Instance` exists, variable handles (`< ArraySlotCount`) resolve to `Instance->ArrayPool` via `ResolveArraySlot()`

### 5.4 Function Call ABI Storage

```
TArray<FForgeFunctionCallFrame> FunctionCallStack;
TArray<FForgeFunctionArgSlot>   FunctionArgSlots;
TArray<uint8>                   FunctionArgBlob;
TArray<UObject*>                FunctionArgObjectPool;
```

Flattened storage shared across all active call frames.  Each frame records snapshot indices into the arg arrays; cleanup truncates back to those snapshots.

---

## 6. Object Indirection — GC-Safe Pattern

Raw `UObject*` pointers cannot be stored in byte blobs — the garbage collector would not trace them.  ForgeVM solves this with a **uint16 index indirection**:

```
┌─────────────────────────────────┐
│  ContextStack / VariableBlob    │
│                                 │
│  Offset 24: [uint16 = 3]  ─────┼──┐
│                                 │  │
└─────────────────────────────────┘  │
                                     │
┌─────────────────────────────────┐  │
│  ContextObjectStack (UPROPERTY) │  │  ← GC traces this array
│                                 │  │
│  [0] UObject* = ...             │  │
│  [1] UObject* = ...             │  │
│  [2] UObject* = ...             │  │
│  [3] UObject* = AMyActor* ◄────┼──┘
│  [4] UObject* = ...             │
└─────────────────────────────────┘
```

### Write Path

```cpp
// Specialisation: WriteToMemory<UObject*>
uint16 ObjectIndex = AllocContextObject(Value);  // dedup + add
Memcpy(Memory + Offset, &ObjectIndex, sizeof(uint16));
```

### Read Path

```cpp
// Specialisation: ReadFromMemory<UObject*>
uint16 ObjectIndex;
Memcpy(&ObjectIndex, Memory + Offset, sizeof(uint16));
return GetContextObject(ObjectIndex);  // bounds-checked lookup
```

### Deduplication

`AllocContextObject()` performs a linear scan for duplicates (`IndexOfByKey`).  This is O(n) but optimal for the typical pool size (< 20 entries per execution).

### Object Pool Variants

| Pool | UPROPERTY | Used By | Allocation |
|------|-----------|---------|------------|
| `ContextObjectStack` | Yes | Context data source | `AllocContextObject()` |
| `Instance->InstanceObjectPool` | Yes | Instance data source | `AllocInstanceObject()` → `Instance->AllocObject()` |
| `FunctionArgObjectPool` | Yes | CallFrame data source | `AllocCallArgObject()` |

### UClass* Specialisations

`UClass*` is a `UObject` subtype but requires separate template specialisations because C++ treats `UClass*` and `UObject*` as distinct types.  Both use the same indirection pools, with `Cast<UClass>()` on read.

### Overflow Guard

All three pools guard against exceeding `uint16` capacity (65 535 = `FORGE_INVALID_INDEX` sentinel):

```cpp
if (ContextObjectStack.Num() >= FORGE_INVALID_INDEX)
    return FORGE_INVALID_INDEX;  // 0xFFFF
```

---

## 7. Array Indirection

### FForgeArraySlot

```cpp
struct FForgeArraySlot
{
    uint8         ElementType;  // EForgeFieldType
    uint16        Count;        // Valid element count
    TArray<uint8> Data;         // Raw contiguous storage
};
```

### Handle Resolution

```cpp
FForgeArraySlot* ResolveArraySlot(uint16 Handle);
```

```
Handle < ArraySlotCount AND Instance exists?
  ├─ YES → Instance->GetArraySlot(Handle)    // Persistent variable array
  └─ NO  → ContextArrayPool[Handle]           // Inline variable or transient
```

This dual-path resolution means the same handler code works identically for both inline (fire-and-forget) and instanced (persistent) execution — the slot indirection is transparent.

### Transient Array Lifecycle

```
AllocContextArraySlot(FieldType)
  └─ Appends beyond variable region, increments ActiveTransientArrays

ResetTransientArrays()
  └─ Truncates ContextArrayPool to ArraySlotCount (no shrinking)
     └─ Called at start of each execution to reclaim transient handles
```

---

## 8. Data Access Templates

### ReadValue\<T\> — Generic Pool-Index Packing

```cpp
template<typename T>
T ReadValue(const FStatusInstruction& Instr, uint8 DataSlot, uint8 StartBit);
```

Bit layout: `[Source:2][Payload:16]` = 18 bits total

```
1. Source = Instr.ExtractBits(DataSlot, StartBit, 2)
2. Payload = Instr.ExtractBits(DataSlot, StartBit + 2, 16)
3. Dispatch on Source:
   - Literal  → ReadLiteral<T>(Payload)
   - Context  → ReadFromMemory<T>(ContextStack, Payload)
   - Instance → ReadFromInstanceBlob<T>(Payload)
   - CallFrame → ReadCallFrameValue<T>(Payload)
```

### WriteValue\<T\>

```cpp
template<typename T>
void WriteValue(EForgeDataSource Target, int32 Offset, const T& Value);
```

Only supports `Context` and `Instance` targets (Literal is read-only, CallFrame is read-only).

### ReadFromMemory / WriteToMemory

Generic implementation uses `FMemory::Memcpy` for platform-safe unaligned access:

```cpp
template<typename T>
T ReadFromMemory(const TArray<uint8>& Memory, int32 Offset) const
{
    T Result;
    FMemory::Memcpy(&Result, Memory.GetData() + Offset, sizeof(T));
    return Result;
}
```

Both are bounds-checked: offset validity and `Offset + sizeof(T) <= Memory.Num()`.

---

## 9. Inline Literal Packing

For high-frequency types, ForgeVM provides specialised read methods that embed literal values **directly in the instruction bits**, eliminating pool lookups entirely.

### ReadInlineFloat — Float32 Packing

```cpp
float ReadInlineFloat(const FStatusInstruction& Instr, uint8 DataSlot, uint8 StartBit);
```

Bit layout: `[Source:2][Payload:32]` = 34 bits

```
Source == Literal?
  ├─ YES → Instr.ExtractFloat(DataSlot, StartBit + 2)  // IEEE 754 from bits
  └─ NO  → next 16 bits = offset → ReadFromMemory/InstanceBlob/CallFrame
```

### ReadInlineInt32 — Signed Int32 Packing

```cpp
int32 ReadInlineInt32(const FStatusInstruction& Instr, uint8 DataSlot, uint8 StartBit);
```

Same pattern — 32-bit literal value or 16-bit offset for non-literal sources.

### ReadInlineHalfFloat — Float16 Packing

```cpp
float ReadInlineHalfFloat(const FStatusInstruction& Instr, uint8 DataSlot, uint8 StartBit);
```

Bit layout: `[Source:2][Payload:16]` = 18 bits

Uses `Instr.ExtractHalfFloat()` for half-precision IEEE 754.  Most useful for compact constants where full precision is not needed (e.g., damage multipliers, cooldown factors).

### Packing Comparison

| Method | Literal Bits | Pool Lookup | Best For |
|--------|-------------|-------------|----------|
| `ReadValue<float>` | 16 (pool index) | Yes | Large literal pools |
| `ReadInlineFloat` | 32 (full IEEE 754) | No | Unique constants |
| `ReadInlineHalfFloat` | 16 (half float) | No | Compact constants |
| `ReadInlineInt32` | 32 (full int) | No | Integer constants |

---

## 10. Output Writing

Outputs use a simpler encoding than inputs — they store only a **16-bit byte offset** with no source flag.  The destination (Context vs Instance) is determined by the node's async flag.

### ReadOutputOffset

```cpp
uint16 ReadOutputOffset(const FStatusInstruction& Instr, uint8 DataSlot, uint8 StartBit) const;
```

Returns the raw 16-bit offset from the instruction.

### WriteOutput\<T\> — Context Target

```cpp
template<typename T>
void WriteOutput(uint16 Offset, const T& Value);
// → WriteToMemory<T>(ContextStack, Offset, Value)
```

Standard path for synchronous nodes — writes to the transient `ContextStack`.

### WriteOutputToInstance\<T\> — Instance Target

```cpp
template<typename T>
void WriteOutputToInstance(uint16 Offset, const T& Value);
// → WriteToInstanceBlob<T>(Offset, Value)
```

Used by async nodes whose outputs must persist across suspension/resumption.  The `InstanceBlob` auto-expands if the offset exceeds current size.

### Handler Usage Pattern

```cpp
// Typical handler output
uint16 OutOffset = Context.ReadOutputOffset(Instr, 1, 0);
Context.WriteOutput<float>(OutOffset, ComputedResult);

// Async handler output (persists across suspend/resume)
uint16 OutOffset = Context.ReadOutputOffset(Instr, 1, 0);
Context.WriteOutputToInstance<float>(OutOffset, ComputedResult);
```

---

## 11. Function Call Frame Access

### ReadCallFrameValue\<T\>

```cpp
template<typename T>
T ReadCallFrameValue(uint16 ArgIndex) const;
```

Resolution chain:

```
1. Get current frame: FunctionCallStack.Last()
2. Validate: ArgIndex < Frame.ArgCount
3. Slot = FunctionArgSlots[Frame.ArgStartIndex + ArgIndex]
4. Validate: Slot.ByteOffset >= 0, Slot.ByteSize >= sizeof(T)
5. ReadFromMemory<T>(FunctionArgBlob, Slot.ByteOffset)
```

### Object/Class Specialisations

`ReadCallFrameValue<UObject*>` and `ReadCallFrameValue<UClass*>` follow the same indirection pattern:

```
1. Read uint16 from FunctionArgBlob at Slot.ByteOffset
2. Validate FieldType matches (Object=5 or Class=8)
3. return GetCallArgObject(ObjectIndex)   // → FunctionArgObjectPool lookup
```

### FForgeFunctionArgSlot

```cpp
struct FForgeFunctionArgSlot
{
    int32  ByteOffset;   // Offset in FunctionArgBlob
    uint16 ByteSize;     // Byte size of value
    uint8  FieldType;    // EForgeFieldType
};
```

### FForgeFunctionCallFrame

```cpp
struct FForgeFunctionCallFrame
{
    int32  ReturnPC;
    uint16 OutTargetDescriptorIndex;  // 0xFFFF = none
    int32  ArgStartIndex;
    int32  ArgCount;
    int32  ArgBlobStartOffset;
    int32  ObjectStartIndex;
};
```

---

## 12. Flow Control Stack

```cpp
TArray<FForgeFlowBlock> FlowBlockStack;
```

```cpp
struct FForgeFlowBlock
{
    int32 BeginPC;          // Where the block starts
    int32 OnCompletedPC;    // Jump target when block finishes
    int32 BlockIndex;       // Current iteration (for loops)
    int32 LoopCount;        // Total iterations (0 for non-loop blocks)
};
```

- `OP_BeginBlock` pushes a new frame
- Flow nodes read/modify `BlockIndex` and `LoopCount`
- `OP_EndBlock` signals block completion — the flow node decides whether to loop or exit
- `Break` / `Continue` operations manipulate `PC` and `FlowBlockStack` directly

---

## 13. Interceptor Payload

```cpp
const FForgePayloadEntry* ActivePayloadEntries = nullptr;
uint16 ActivePayloadCount = 0;
```

Set by `CallPropagation` handlers before broadcasting interceptor events.  These are **non-owning pointers** into the compiled `UPDA_StatusDefinition::Pool_PayloadEntries` — valid only during the synchronous interceptor dispatch.  Reset to null after the broadcast completes.

---

## 14. Branching Registers

```cpp
bool  bLastConditionResult = false;
int32 LastSwitchValue = 0;
```

Used by condition and switch nodes to communicate results to subsequent `OP_JumpIfFalse` and `OP_JumpTable` system ops.  These are single-value registers — not a stack — because branching is never nested within a single instruction step.

---

## 15. Continuation Instructions

```cpp
FORCEINLINE const FStatusInstruction* GetContinuationInstruction(int32 Offset) const;
```

Handlers that need more than 104 payload bits use **continuation slots** — `OP_ContinueData` instructions that follow the primary instruction in the bytecode stream.

```
PC was pre-incremented before handler call, so:

  Offset 1 → Instructions[PC]       (first continuation)
  Offset 2 → Instructions[PC + 1]   (second continuation)
  ...
```

The handler reads continuation data, then advances `PC` past the continuation slots:

```cpp
// In handler:
const FStatusInstruction* Cont = Context.GetContinuationInstruction(1);
// ... read extra data from Cont ...
Context.PC += 1;  // Skip the continuation slot
```

---

## 16. Subsystem Access

```cpp
UStatsX_WorldSubsystem* GetSubsystem() const;
```

Resolves the `WorldSubsystem` from the first available actor world:

```
1. Try TargetActor->GetWorld()->GetSubsystem<UStatsX_WorldSubsystem>()
2. Fallback: CasterActor->GetWorld()->GetSubsystem<UStatsX_WorldSubsystem>()
3. Fallback: nullptr
```

Primarily used by handlers that need to promote the execution to an active instance (`RegisterAsActiveInstance`).

---

## 17. Error Reporting

### Editor Builds (WITH_EDITOR)

```cpp
bool ReportError(const FString& ErrorMsg);
```

- Sets `LastError = ErrorMsg`
- Logs via `FORGEVM_LOG(Error, ...)` with PC and StatusTag context
- Returns `false` (convenience for guard clauses)

### Shipping Builds

```cpp
bool ReportErrorShipped(const FString& ErrorMsg = TEXT("Unknown"));
```

- Logs via `UE_LOG(LogForgeVM, Error, ...)` with PC and StatusTag
- Returns `false`
- Does **not** store in `LastError` (shipping builds minimise string allocations)

---

## 18. Function State Persistence

When execution suspends inside a function call, the entire call ABI state must survive to the next `ResumeInstance()` call.

### PersistFunctionStateToInstance()

```
Context.FunctionCallStack    → Instance->FunctionCallStack
Context.FunctionArgSlots     → Instance->FunctionArgSlots
Context.FunctionArgBlob      → Instance->FunctionArgBlob
Context.FunctionArgObjectPool → Instance->FunctionCallObjectPool (TObjectPtr copy)
```

The object pool is converted from raw `UObject*` to `TObjectPtr<UObject>` for GC safety during the instance's persistent lifetime.

### LoadFunctionStateFromInstance()

```
Instance->FunctionCallStack  → Context.FunctionCallStack
Instance->FunctionArgSlots   → Context.FunctionArgSlots
Instance->FunctionArgBlob    → Context.FunctionArgBlob
Instance->FunctionCallObjectPool → Context.FunctionArgObjectPool (TObjectPtr→raw)
```

Reverse conversion: `TObjectPtr::Get()` back to raw pointers for the transient context.

Both operations use array assignment (not swap) to preserve Instance storage for the next suspension.

---

## 19. Debug-Only Facilities

### ContextStringStack (WITH_EDITOR)

```cpp
TArray<FString> ContextStringStack;
uint16 AllocContextString(const FString& Str);
FString GetContextString(uint16 Index) const;
```

Stores transient `FString` values for debug nodes (`PrintString`, `FloatToString`, etc.).  The `ContextStack` stores `uint16` indices, same pattern as the object indirection.

**Not available in shipping builds** — string operations are stripped in production bytecode.

---

## 20. Literal Pool Specialisations

Each type has a `ReadLiteral<T>` specialisation that maps a `uint16` pool index to the correct compiled pool:

| Type | Pool | Default |
|------|------|---------|
| `float` | `Pool_Floats[idx]` | `0.0f` |
| `int32` | `Pool_Ints[idx]` | `0` |
| `bool` | `Pool_Bools[idx]` | `false` |
| `uint8` | `Pool_Bytes[idx]` | `0` |
| `uint16` | `Pool_Bytes[idx]` | `0` |
| `FVector` | `Pool_Vectors[idx]` | `ZeroVector` |
| `FRotator` | `Pool_Rotator[idx]` | `ZeroRotator` |
| `FTransform` | `Pool_Transforms[idx]` | `Identity` |
| `FName` | `Pool_Names[idx]` | `NAME_None` |
| `FGameplayTag` | `Pool_Tags[idx]` | `FGameplayTag()` |
| `FString` | `Pool_Strings[idx]` | `FString()` |
| `UObject*` | `Pool_Objects[idx]` | `nullptr` |
| `UClass*` | `Pool_Classes[idx]` | `nullptr` |
| `FForgeArrayHeader` | `Pool_ArraysHeaders[idx]` | default |

### Wide Literal Packing

Some types occupy multiple consecutive pool entries:

| Type | Pool Entries | Layout |
|------|-------------|--------|
| `int64` | `Pool_Ints[idx]` + `Pool_Ints[idx+1]` | Low 32 bits + High 32 bits |
| `double` | `Pool_Ints[idx]` + `Pool_Ints[idx+1]` | Reinterpreted 64-bit pattern |
| `FLinearColor` | `Pool_Floats[idx..idx+3]` | R, G, B, A |

### FGameplayTagContainer

Uses a two-level lookup:

```
PoolIndex → Pool_ArraysHeaders[PoolIndex]
  └─ { StartIndex, Count }
     └─ Pool_Tags[StartIndex .. StartIndex+Count)
```

---

## 21. Complex Type Specialisations

### UObject* / UClass* — Full Indirection

Both read and write paths use the index indirection pattern described in Section 6.  Four storage targets × two pointer types = 8 explicit specialisations:

| Operation | UObject* | UClass* |
|-----------|----------|---------|
| `ReadFromMemory` | `ContextObjectStack[idx]` | `Cast<UClass>(ContextObjectStack[idx])` |
| `WriteToMemory` | `AllocContextObject` → write idx | `AllocContextObject` → write idx |
| `ReadFromInstanceBlob` | `InstanceObjectPool[idx]` | `Cast<UClass>(InstanceObjectPool[idx])` |
| `WriteToInstanceBlob` | `AllocInstanceObject` → write idx | `AllocInstanceObject` → write idx |

### FGameplayTagContainer — Inline Blob Layout

Stored in both Context and Instance blobs as:

```
┌──────────────┬─────────────────┬─────────────────┬───┐
│ Count(uint16)│ Tag0(GameplayTag)│ Tag1(GameplayTag)│...│
└──────────────┴─────────────────┴─────────────────┴───┘
```

- **Read:** Extract count, then `Memcpy` each `FGameplayTag` from blob → `AddTag()` to container
- **Write:** Write count prefix, then `Memcpy` each tag inline
- Auto-expands blob if needed (for writes that exceed current size)

### FString — Literal-Only

`FString` is supported only as a `Literal` source (read from `Pool_Strings`).  Runtime string variables in blob storage are not supported — strings are complex heap-allocated types that cannot be safely `Memcpy`'d.  The editor `ContextStringStack` provides debug-time string handling.

---

## 22. Struct Reference

### FForgeVMContext — Fields

| Field | Type | Description |
|-------|------|-------------|
| `StatusID` | `int64` | Pre-generated ID, used if execution becomes an instance |
| `PC` | `int32` | Instruction pointer (index into `Definition->Instructions`) |
| `Definition` | `const UPDA_StatusDefinition*` | Compiled status being executed |
| `Instance` | `FStatusInstance*` | Active instance (nullptr for inline execution) |
| `CasterActor` | `TWeakObjectPtr<AActor>` | Casting actor |
| `TargetActor` | `TWeakObjectPtr<AActor>` | Receiving actor |
| `CasterComponent` | `TWeakObjectPtr<UStatsX_StatsComponentBase>` | Cached caster component |
| `TargetComponent` | `TWeakObjectPtr<UStatsX_StatsComponentBase>` | Cached target component |
| `ContextStack` | `TArray<uint8>` | Transient inter-node byte blob |
| `ContextObjectStack` | `TArray<UObject*>` | GC-tracked object pool (UPROPERTY) |
| `VariableBlob` | `TArray<uint8>` | Dedicated variable storage |
| `ContextArrayPool` | `TArray<FForgeArraySlot>` | Dynamic array pool |
| `ActiveTransientArrays` | `uint16` | Transient slot count for efficient reset |
| `FlowBlockStack` | `TArray<FForgeFlowBlock>` | Nested loop/block stack |
| `FunctionCallStack` | `TArray<FForgeFunctionCallFrame>` | Function call return stack |
| `FunctionArgSlots` | `TArray<FForgeFunctionArgSlot>` | Captured argument metadata |
| `FunctionArgBlob` | `TArray<uint8>` | Captured argument raw bytes |
| `FunctionArgObjectPool` | `TArray<UObject*>` | Captured argument objects (UPROPERTY) |
| `ActivePayloadEntries` | `const FForgePayloadEntry*` | Interceptor payload (non-owning) |
| `ActivePayloadCount` | `uint16` | Interceptor payload entry count |
| `bLastConditionResult` | `bool` | Last condition evaluation result |
| `LastSwitchValue` | `int32` | Last switch node value |
| `LastError` | `FString` | Most recent error message |

### FForgeVMContext — Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `Reset()` | `(int64, UPDA_StatusDefinition*, FStatusInstance*)` | Prepare for new execution |
| `AllocateStack()` | `(int32 SizeInBytes)` | Allocate/resize ContextStack |
| `AllocateVariableBlob()` | `(int32 SizeInBytes)` | Allocate/resize VariableBlob |
| `GetSubsystem()` | `→ UStatsX_WorldSubsystem*` | Resolve world subsystem from actors |
| `GetContinuationInstruction()` | `(int32 Offset) → const FStatusInstruction*` | Read continuation slot |
| `ReadValue<T>()` | `(Instr, DataSlot, StartBit) → T` | Generic data read (pool-index packing) |
| `ReadInlineFloat()` | `(Instr, DataSlot, StartBit) → float` | Float32 inline literal read |
| `ReadInlineInt32()` | `(Instr, DataSlot, StartBit) → int32` | Int32 inline literal read |
| `ReadInlineHalfFloat()` | `(Instr, DataSlot, StartBit) → float` | Half-float inline literal read |
| `WriteValue<T>()` | `(Target, Offset, Value)` | Generic data write |
| `ReadOutputOffset()` | `(Instr, DataSlot, StartBit) → uint16` | Read output byte offset |
| `WriteOutput<T>()` | `(Offset, Value)` | Write to ContextStack |
| `WriteOutputToInstance<T>()` | `(Offset, Value)` | Write to InstanceBlob |
| `ReadCallFrameValue<T>()` | `(ArgIndex) → T` | Read from current function frame |
| `AllocContextObject()` | `(UObject*) → uint16` | Allocate GC-safe context object |
| `GetContextObject()` | `(uint16) → UObject*` | Retrieve context object by index |
| `AllocInstanceObject()` | `(UObject*) → uint16` | Allocate GC-safe instance object |
| `GetInstanceObject()` | `(uint16) → UObject*` | Retrieve instance object by index |
| `AllocContextArraySlot()` | `(uint8 FieldType) → uint16` | Allocate transient array slot |
| `ResetTransientArrays()` | `()` | Truncate transient array region |
| `ResolveArraySlot()` | `(uint16 Handle) → FForgeArraySlot*` | Handle → slot with instance redirection |
| `AllocCallArgObject()` | `(UObject*) → uint16` | Allocate function arg object |
| `GetCallArgObject()` | `(uint16) → UObject*` | Retrieve function arg object |
| `GetCurrentFunctionFrame()` | `→ const FForgeFunctionCallFrame*` | Current call frame (or nullptr) |
| `LoadFunctionStateFromInstance()` | `()` | Restore persisted call ABI from Instance |
| `PersistFunctionStateToInstance()` | `()` | Save call ABI state to Instance |
| `ReportError()` | `(FString) → bool` | Editor-only error report |
| `ReportErrorShipped()` | `(FString) → bool` | Shipping build error report |

### EForgeDataSource

| Value | Name | Description |
|-------|------|-------------|
| 0 | `Literal` | Compiled constant in definition pool |
| 1 | `Context` | Transient per-tick byte blob |
| 2 | `Instance` | Persistent cross-tick instance blob |
| 3 | `CallFrame` | Captured function argument |

---

*Stats_X v1.404 — Execution Context*
