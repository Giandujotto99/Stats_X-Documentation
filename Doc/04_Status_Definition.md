# Status Definition

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Table of Contents

1. [Overview](#overview)
2. [UPDA_StatusDefinition Class](#upda_statusdefinition-class)
3. [Identity & Metadata](#identity--metadata)
4. [Memory Layout Declarations](#memory-layout-declarations)
5. [Stacking Configuration](#stacking-configuration)
6. [Instruction Array](#instruction-array)
7. [Literal Pools](#literal-pools)
8. [Object Pools](#object-pools)
9. [Complex Type Pools](#complex-type-pools)
10. [Interceptor Payload System](#interceptor-payload-system)
11. [Function Call ABI](#function-call-abi)
12. [Variable Table](#variable-table)
13. [Array Indirection Metadata](#array-indirection-metadata)
14. [Struct Descriptors](#struct-descriptors)
15. [Native Struct Thunks](#native-struct-thunks)
16. [Global Status Registry](#global-status-registry)
17. [Asset Lifecycle](#asset-lifecycle)
18. [Pool Access Pattern](#pool-access-pattern)
19. [Best Practices](#best-practices)

---

## Overview

`UPDA_StatusDefinition` is the **compiled output** of the StatusForge visual editor. It is a `UPrimaryDataAsset` that contains everything the ForgeVM needs to execute a status effect: bytecode instructions, literal constant pools, variable declarations, struct layout descriptors, and interceptor payload metadata.

### Design Principles

| Principle | Implementation |
|---|---|
| **Immutable at runtime** | Definitions are never modified after compilation. All mutable state lives in `FStatusInstance` or `FForgeVMContext` |
| **Flat pool architecture** | All constants are stored in contiguous typed arrays (pools). Instructions reference pools via 16-bit indices, maximizing cache locality |
| **Zero-allocation execution** | The VM reads directly from pool arrays. No allocations occur during instruction dispatch |
| **Self-contained** | A single `UPDA_StatusDefinition` contains the full description of a status — bytecode, constants, variables, struct layouts, function metadata |

---

## UPDA_StatusDefinition Class

**Source:** `Data/StatusDefinition.h`
**Parent:** `UPrimaryDataAsset`

```cpp
UCLASS()
class STATS_X_API UPDA_StatusDefinition : public UPrimaryDataAsset
{
    // Identity
    FGameplayTag StatusTag;

    // Memory layout
    int32 InstanceBlobSize;
    int32 GateStateRegionBytes;
    int32 ContextStackSize;

    // Stacking
    EStatusStackingPolicy StackingPolicy;
    int32 MaxStacks;
    bool bStackPerCaster;

    // Bytecode
    TArray<FStatusInstruction> Instructions;

    // Literal Pools (14 typed pools)
    // Object Pools (4 reference pools)
    // Complex Type Pools (struct data, array/map headers)
    // Interceptor Payload metadata
    // Function Call ABI
    // Variable Table
    // Struct Descriptors
    // Native Struct Thunks
};
```

---

## Identity & Metadata

### StatusTag

```cpp
UPROPERTY(EditAnywhere, BlueprintReadOnly)
FGameplayTag StatusTag;
```

The unique identifier for this status definition. Must be under the `StatsX.Status.*` hierarchy. This tag is used for:

- **Casting by tag** — `CastStatusSync()` / `CastStatusAsync()` resolve this tag from the global registry
- **Stacking resolution** — `FindExistingStatus()` matches definitions by this tag
- **Status tracking** — Components store this tag in their `CastedStatusesContainer` / `ReceivedStatusesContainer`
- **Removal by tag** — `RemoveStatusByTag()` matches against this tag

---

## Memory Layout Declarations

The compiler calculates three memory sizes that the VM uses to pre-allocate execution buffers:

| Field | Type | Description |
|---|---|---|
| `InstanceBlobSize` | `int32` | Total bytes required for the persistent instance blob (`FStatusInstance.InstanceBlob`). Includes gate/DoOnce state region + user instance variables |
| `GateStateRegionBytes` | `int32` | Prefix bytes in `InstanceBlob` reserved for internal control state (Gate, DoOnce, FlipFlop nodes). User instance variables start after this offset |
| `ContextStackSize` | `int32` | Total bytes required for the transient context stack (`FForgeVMContext.ContextStack`). Covers all temporary values during a single execution slice |

### Memory Regions Diagram

```
InstanceBlob (InstanceBlobSize bytes):
┌──────────────────────────┬───────────────────────────────────┐
│  Gate/DoOnce Region      │  User Instance Variables          │
│  (GateStateRegionBytes)  │  (InstanceBlobSize - GateState)   │
└──────────────────────────┴───────────────────────────────────┘

ContextStack (ContextStackSize bytes):
┌──────────────────────────────────────────────────────────────┐
│  Transient values (cleared every execution slice)            │
│  Written by node outputs, read by subsequent node inputs     │
└──────────────────────────────────────────────────────────────┘

VariableBlob (VariableBlobSize bytes):
┌──────────────────────────────────────────────────────────────┐
│  User-declared variables (persist across execution slices)   │
│  Initialized from defaults, modifiable by OP_SetVariable     │
└──────────────────────────────────────────────────────────────┘
```

---

## Stacking Configuration

Three fields control how the status behaves when applied to a target that already has an active instance of the same definition.

### Fields

```cpp
UPROPERTY(EditAnywhere, BlueprintReadOnly)
EStatusStackingPolicy StackingPolicy = EStatusStackingPolicy::Aggregate;

UPROPERTY(EditAnywhere, BlueprintReadOnly, meta = (ClampMin = "-1"))
int32 MaxStacks = -1;

UPROPERTY(EditAnywhere, BlueprintReadOnly)
bool bStackPerCaster = false;
```

### Stacking Policies

| Policy | Behavior | Existing Instance | New Application |
|---|---|---|---|
| `Aggregate` | Add stack, keep duration | Stack count incremented | VM does **not** re-execute |
| `AggregateAndRefresh` | Add stack + refresh duration | Stack count incremented, duration reset | VM does **not** re-execute |
| `RefreshOnly` | No stack, refresh duration | Duration reset only | VM does **not** re-execute |
| `Override` | Replace entirely | Old instance terminated (with OnEnd) | New instance created from scratch |
| `Reject` | Block new application | Unchanged | Application silently rejected |
| `Independent` | Always create new | Unchanged | New independent instance created |

### MaxStacks

| Value | Meaning |
|---|---|
| `-1` | Unlimited stacks |
| `0` | Unlimited stacks (same as -1) |
| `N > 0` | Cap at N stacks. Further Aggregate/AggregateAndRefresh applications above the cap behave according to the policy but won't exceed N |

### bStackPerCaster

| Value | Behavior |
|---|---|
| `false` | All casters share one instance on the target. Stacking from different casters affects the same instance |
| `true` | Each caster gets their own independent instance on the target. Caster A's poison and Caster B's poison are tracked separately |

---

## Instruction Array

```cpp
UPROPERTY(EditAnywhere, BlueprintReadOnly)
TArray<FStatusInstruction> Instructions;
```

The compiled bytecode — a flat array of 128-bit instructions. The VM executes these sequentially via a Program Counter (PC).

Each `FStatusInstruction` is 16 bytes:

```
┌─────────── Data0 (64 bits) ─────────────┬─── Data1 (64 bits) ───┐
│ OpCode(16) │ Flags(8) │ Payload1(40)     │ Payload2 (64 bits)    │
└──────────────────────────────────────────┴───────────────────────┘
```

**Cache alignment:** 4 instructions per 64-byte L1 cache line.

**Continuation instructions:** When a node needs more than 104 bits of payload data, additional instructions with `OpCode = OP_Continue` serve as pure data slots. The `HasContinuation` flag on the parent instruction signals the VM to read subsequent slots.

> Detailed instruction encoding is covered in **[09 — Instruction Format](09_Instruction_Format.md)**.

---

## Literal Pools

Literal pools store **immutable constant values** referenced by instructions via 16-bit indices. The pool architecture eliminates pointer chasing and maximizes data locality.

### Primitive Pools

| Pool | Type | Index Range | Notes |
|---|---|---|---|
| `Pool_Floats` | `TArray<float>` | 0–65535 | Standard float constants |
| `Pool_Ints` | `TArray<int32>` | 0–65535 | Integer constants |
| `Pool_Bools` | `TArray<bool>` | 0–65535 | Packed boolean array. Access via `Pool_Bools[Index] ? 1 : 0` (not pointer arithmetic) |
| `Pool_Bytes` | `TArray<uint8>` | 0–65535 | Enum values and small integers |
| `Pool_Names` | `TArray<FName>` | 0–65535 | Unreal FName constants |
| `Pool_Strings` | `TArray<FString>` | 0–65535 | String constants |
| `Pool_Vectors` | `TArray<FVector>` | 0–65535 | 3D vector constants |
| `Pool_Rotator` | `TArray<FRotator>` | 0–65535 | Rotation constants |
| `Pool_Transforms` | `TArray<FTransform>` | 0–65535 | Pre-allocated for alignment |
| `Pool_Tags` | `TArray<FGameplayTag>` | 0–65535 | Gameplay tag constants |

### Access Pattern

An instruction referencing a float literal encodes:

```
Data Source = Literal (0)
Pool Index  = 16-bit index into Pool_Floats
```

The VM reads: `Definition->Pool_Floats[Index]`

---

## Object Pools

Object references are stored in separate pools to support different lifecycle semantics:

| Pool | Type | Reference Type | Loading |
|---|---|---|---|
| `Pool_Objects` | `TArray<TObjectPtr<UObject>>` | Hard reference | Loaded with asset |
| `Pool_Classes` | `TArray<TObjectPtr<UClass>>` | Hard class reference | Loaded with asset |
| `Pool_SoftObjects` | `TArray<TSoftObjectPtr<UObject>>` | Soft reference | Async/lazy load |
| `Pool_SoftClasses` | `TArray<TSoftClassPtr<UObject>>` | Soft class reference | Async/lazy load |

**16-bit compression:** Instructions store a 16-bit pool index rather than a 64-bit pointer, saving instruction payload space. At runtime, the VM dereferences: `Definition->Pool_Objects[Index]`.

---

## Complex Type Pools

### Struct Data

Custom structs (e.g., `FHitResult`, user-defined structs) are serialized into a contiguous byte blob, with headers providing offset and size:

```cpp
TArray<FForgeStructHeader> Pool_StructHeaders;  // Offset + Size + StructType
TArray<uint8> Pool_StructData;                  // Raw bytes, sequential layout
```

**FForgeStructHeader:**

| Field | Type | Description |
|---|---|---|
| `Offset` | `int32` | Byte offset in `Pool_StructData` |
| `Size` | `int32` | Byte count of the serialized struct |
| `StructType` | `UScriptStruct*` | Type pointer for safety checks |

**Access:** `Definition->GetStructLiteral<T>(HeaderIndex)` — type-safe with editor/development runtime checks.

### Array / Set Headers

Arrays and sets of primitives are stored as ranges within their respective primitive pools:

```cpp
TArray<FForgeArrayHeader> Pool_ArraysHeaders;  // StartIndex + Count
```

**FForgeArrayHeader:**

| Field | Type | Description |
|---|---|---|
| `StartIndex` | `uint16` | First element index in the target pool |
| `Count` | `uint16` | Number of elements to read |

**Example:** An array of 3 tags: `Header{Start:5, Count:3}` → read `Pool_Tags[5]`, `Pool_Tags[6]`, `Pool_Tags[7]`.

### Map Headers

Maps use parallel key/value pool iteration:

```cpp
TArray<FForgeArrayHeader> Pool_MapsHeaders;  // StartIndex + Count
```

Logic: Read `StartIndex` and `Count`, then iterate both `Pool_MapKeys` and `Pool_MapValues` in parallel from `StartIndex` to `StartIndex + Count - 1`.

---

## Interceptor Payload System

When a node triggers interceptor events (Pre/Post), it needs to expose its data to interceptor `Condition()` and `Action()` methods. The payload system provides a compile-time resolved, zero-allocation data descriptor.

### FForgePayloadEntry

Describes one named field accessible to interceptors:

```cpp
USTRUCT()
struct FForgePayloadEntry
{
    FName FieldName;      // Pin name (e.g., "EffectiveChange", "AttributeTag")
    uint16 Offset;        // Byte offset / pool index depending on Source
    uint8 Source;          // EForgeDataSource (Literal, Context, Instance, CallFrame)
    uint8 FieldType;       // EForgeFieldType (Float, Int32, Bool, Tag, Object, Vector...)
};
```

### FForgePayloadDescriptor

Groups entries for a single `CallPropagation` node:

```cpp
USTRUCT()
struct FForgePayloadDescriptor
{
    uint16 StartIndex;    // Into Pool_PayloadEntries
    uint16 Count;         // Number of entries
};
```

### Pool Layout

```
Pool_PayloadDescriptors: [ Desc0, Desc1, Desc2, ... ]
                            │
                            ▼
Pool_PayloadEntries:     [ Entry0, Entry1, Entry2, ... Entry5, Entry6, ... ]
                           ├──── Desc0 range ────┤  ├── Desc1 range ──┤
```

At runtime, interceptors receive a descriptor index and iterate the entries to read/write payload fields by name.

---

## Function Call ABI

StatusForge supports callable functions (event blocks) with typed arguments and return values. The function call ABI is pre-compiled into the definition.

### FForgeFunctionIOEntry

Single argument or return value descriptor:

```cpp
USTRUCT()
struct FForgeFunctionIOEntry
{
    uint8 FieldType;   // EForgeFieldType
    uint8 Source;       // EForgeDataSource
    uint16 Payload;    // Pool index / byte offset / arg index (source-dependent)
};
```

### FForgeFunctionIODescriptor

Groups entries for one function's inputs or outputs:

```cpp
USTRUCT()
struct FForgeFunctionIODescriptor
{
    uint16 StartIndex;  // Into Pool_FunctionIOEntries
    uint16 Count;       // Number of entries
};
```

### FForgeFunctionCallFrame

Runtime call frame for the function call stack:

```cpp
USTRUCT()
struct FForgeFunctionCallFrame
{
    int32 ReturnPC;                       // Instruction to return to
    uint16 OutTargetDescriptorIndex;      // Descriptor for output routing (0xFFFF = none)
    int32 ArgStartIndex;                  // Start in runtime arg slot array
    int32 ArgCount;                       // Number of captured arguments
    int32 ArgBlobStartOffset;             // Start in argument blob
    int32 ObjectStartIndex;              // Start in runtime object pool
};
```

### FForgeFunctionArgSlot

Metadata for a single captured argument:

```cpp
USTRUCT()
struct FForgeFunctionArgSlot
{
    int32 ByteOffset;    // Offset in captured argument blob
    uint16 ByteSize;     // Size of this value
    uint8 FieldType;     // EForgeFieldType
};
```

---

## Variable Table

User-declared variables are stored in a dedicated `VariableBlob` (separate from the context stack and instance blob). The definition declares variable layouts; the runtime manages the actual data.

### FForgeVariableHeader

```cpp
USTRUCT()
struct FForgeVariableHeader
{
    FGameplayTag Tag;                    // Variable identifier
    uint16 Offset;                       // Byte offset in VariableBlob
    uint8 FieldType;                     // EForgeFieldType value
    uint8 ContainerMode;                 // 0=Single, 1=Array, 2=Set
    uint16 Count;                        // Max capacity (arrays/sets) or max tag count
    uint16 StructDescriptorIndex;        // Index into StructDescriptors (0xFFFF = N/A)
    uint16 DefaultValuePoolIndex;        // Pool-backed default for tags (0xFFFF = N/A)
};
```

### Variable Storage

```cpp
TArray<FForgeVariableHeader> VariableHeaders;  // Sorted by Tag for binary search
int32 VariableBlobSize;                         // Total bytes for the variable blob
int32 VariableDefaultsHeaderIndex;              // Index into Pool_StructHeaders for defaults
```

### Defaults Initialization

1. The compiler serializes all variable default values into `Pool_StructData` at `VariableDefaultsHeaderIndex`
2. At execution start, the VM copies this blob into the runtime `VariableBlob` via `memcpy`
3. Pool-backed defaults (Object, Class, GameplayTag, GameplayTagContainer) are then fixed up from their pool indices

### Variable Lookup

The definition provides `FindVariable()` with dual-mode search:

| Table Size | Algorithm | Rationale |
|---|---|---|
| ≤ 16 entries | Linear scan | Cache-friendly sequential access wins over branch-heavy binary search |
| > 16 entries | Binary search | Lexical ordering on tag name. O(log N) |

> **Note:** `FindVariable()` is for debug/tool use only. At runtime, all variable offsets are resolved at compile time and encoded directly in instruction payloads.

---

## Array Indirection Metadata

Runtime dynamic arrays use an indirection layer with pre-declared slot metadata:

```cpp
int32 ArraySlotCount;                     // Total slots needed
TArray<uint8> ArraySlotElementTypes;      // Per-slot element type (EForgeFieldType)
TArray<uint16> ArrayDefaultHeaders;       // Per-slot default header index (0xFFFF = empty)
```

At execution start, the VM pre-allocates `ArraySlotCount` `FForgeArraySlot` entries. Each slot is initialized with:
- `ElementType` from `ArraySlotElementTypes`
- Default data from `Pool_ArraysHeaders[ArrayDefaultHeaders[i]]` (if not 0xFFFF)

Slots use `TArray<uint8>` with Unreal's geometric growth for unbounded capacity, eliminating fixed-cap buffer overrun risks.

---

## Struct Descriptors

Pre-computed layout descriptors enable O(k) struct copy operations at runtime (k = number of complex fields) without UScriptStruct reflection.

### FForgeStructDescriptor

```cpp
USTRUCT()
struct FForgeStructDescriptor
{
    TObjectPtr<UScriptStruct> StructType;         // Original type
    uint16 SerializedSize;                         // Blob size (UObject* compressed to uint16)
    TArray<FForgeStructFieldMeta> ComplexFields;   // Fields needing special handling
};
```

### FForgeStructFieldMeta

```cpp
USTRUCT()
struct FForgeStructFieldMeta
{
    uint16 Offset;                    // Byte offset within struct blob
    uint8 FieldType;                  // 5=Object, 8=Class, 20=Struct (nested)
    uint16 NestedDescriptorIndex;     // For nested structs (0xFFFF = N/A)
};
```

**Optimization:** If `ComplexFields` is empty, the struct is pure POD and can be bulk-`memcpy`'d without field-by-field processing.

### Transient Lookup

```cpp
// Built in PostLoad(), not serialized
TMap<TObjectPtr<UScriptStruct>, int32> TransientStructLayoutMap;
```

Enables O(1) `UScriptStruct*` → descriptor index lookup at runtime.

---

## Native Struct Thunks

For native C++ structs (e.g., `FHitResult`, `FTransform`), the compiler generates pre-computed serialization thunks that map native memory layout to VM blob format.

### FForgeNativeStructThunk

```cpp
USTRUCT()
struct FForgeNativeStructThunk
{
    TObjectPtr<UScriptStruct> StructType;    // Native type
    uint16 NativeSize;                        // sizeof(NativeStruct)
    uint16 VMSize;                            // Size in VM blob
    uint16 StructDescriptorIndex;             // Cross-reference (0xFFFF = none)
    TArray<FForgeNativeFieldOp> Ops;          // Pre-computed copy operations
};
```

### FForgeNativeFieldOp

```cpp
USTRUCT()
struct FForgeNativeFieldOp
{
    uint16 NativeOffset;     // Offset in C++ struct
    uint16 VMOffset;         // Offset in VM blob
    uint16 Size;             // Bytes to copy (BulkPOD) or native field size
    uint8 Mode;              // ENativeFieldCopyMode
    uint16 SubThunkIndex;    // For nested structs (0xFFFF = N/A)
};
```

### Copy Modes

| Mode | Value | Description |
|---|---|---|
| `BulkPOD` | 0 | `memcpy` N bytes (adjacent POD fields merged for throughput) |
| `StrongObject` | 1 | `UObject*` (8B native) → `uint16` pool index |
| `WeakObject` | 2 | `TWeakObjectPtr` → resolve → `uint16` pool index |
| `LazyObject` | 3 | `TLazyObjectPtr` → resolve → `uint16` pool index |
| `SoftObject` | 4 | `TSoftObjectPtr` → resolve → `uint16` pool index |
| `NestedStruct` | 5 | Recurse with sub-thunk |

### Key Properties

- Adjacent POD fields are **merged** into single `BulkPOD` operations for minimal loop iterations
- `FName` and `FGameplayTag` are treated as POD (native size, no pool compression)
- `UObject*` is compressed to `uint16` pool indices via `AllocContextObject`
- `FString`, `TArray`, `TMap`, `TSet`, and delegates are **silently skipped** (not VM-compatible)
- Typical operation count: 5–15 ops per struct

---

## Global Status Registry

All compiled status definitions are registered in a global registry for tag-based lookup:

### UPDA_ImmutableGameStatuses

```cpp
UCLASS()
class STATS_X_API UPDA_ImmutableGameStatuses : public UPrimaryDataAsset
{
    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    TMap<FGameplayTag, TSoftObjectPtr<UPDA_StatusDefinition>> StatusesMap;
};
```

- **Soft references** — definitions are not loaded into memory until needed
- **Owned by** `UStatsX_GameInstanceSubsystem` — auto-loaded from plugin content at startup
- **Used by** `CastStatusSync()` / `CastStatusAsync()` for tag-based resolution

### Resolution Flow

```
CastStatusSync(StatsX.Status.Poison, Caster, Target)
  │
  ├─ GameInstanceSubsystem->DA_ImmutableGameStatuses
  │    └─ StatusesMap.Find(StatsX.Status.Poison)
  │         → TSoftObjectPtr<UPDA_StatusDefinition>
  │
  ├─ SynchronousLoad (if not already in memory)
  │    ⚠ May cause hitch on first cast
  │
  └─ WorldSubsystem->ExecuteStatus(ID, Definition, Caster, Target)
```

---

## Asset Lifecycle

### Compilation (Editor Time)

The StatusForge editor compiles a visual graph into `UPDA_StatusDefinition`:

1. **Graph traversal** — walk all nodes in execution order
2. **Instruction generation** — each node emits one or more `FStatusInstruction`
3. **Pool population** — constants extracted into typed pools with deduplication
4. **Variable table** — user-declared variables sorted by tag, offsets calculated
5. **Struct descriptors** — reflection-based layout generation for struct types
6. **Native thunks** — `TFieldIterator<FProperty>` walk for native struct serialization
7. **Size calculation** — `ContextStackSize`, `InstanceBlobSize`, `VariableBlobSize`

### Loading (Runtime)

```
Asset Load (Unreal)
  │
  ├─ Deserialize all UPROPERTYs
  │
  └─ PostLoad()
       └─ RebuildTransientLookups()
            ├─ TransientStructLayoutMap: UScriptStruct* → descriptor index
            └─ TransientNativeThunkMap: UScriptStruct* → thunk index
```

### Execution (Runtime)

The definition is read-only during execution. All mutable state is external:

| Mutable State | Owner |
|---|---|
| Context stack, object pool | `FForgeVMContext` (global, reused) |
| Instance blob, variable blob | `FStatusInstance` (pooled, per-instance) |
| Stack count, timing | `FStatusInstance` |

---

## Pool Access Pattern

Instructions access pool data through a consistent two-step pattern:

### Step 1: Decode Data Source

The instruction's data source field (2 bits) determines where to read:

| Source | Code | Read From |
|---|---|---|
| `Literal` | 0 | Definition pool (immutable) |
| `Context` | 1 | `FForgeVMContext.ContextStack` (transient) |
| `Instance` | 2 | `FStatusInstance.InstanceBlob` (persistent) |
| `CallFrame` | 3 | `FForgeVMContext.FunctionArgBlob` (per-function) |

### Step 2: Resolve Value

For `Literal` source, the instruction encodes a 16-bit index into the appropriate pool. The pool is selected by the node's expected type (known at compile time).

```
Instruction: OP_ModifyAttribute
  Source = Literal (0)
  TypedIndex = 42
  →  Value = Definition->Pool_Floats[42]

Instruction: OP_CheckTags
  Source = Literal (0)
  TypedIndex = 7
  →  Value = Definition->Pool_Tags[7]
```

For `Context`/`Instance`/`CallFrame` sources, the index is a byte offset into the respective blob.

---

## Best Practices

### 1. Use Soft References in the Global Registry

The `UPDA_ImmutableGameStatuses` registry holds `TSoftObjectPtr` references. This prevents loading all status definitions at startup. Use `CastStatusAsync()` for non-critical statuses to avoid synchronous load hitches.

### 2. Keep Pool Sizes Manageable

The 16-bit index limit caps each pool at 65,536 entries per definition. In practice, even the most complex status rarely exceeds a few hundred entries. If approaching the limit, split the status into smaller definitions.

### 3. Leverage Struct Descriptors for Custom Data

For project-specific struct types used in status logic, the compiler automatically generates `FForgeStructDescriptor` entries. Pure-POD structs get optimal `memcpy` paths; structs with object references get safe field-by-field handling.

### 4. Understand the Immutability Contract

`UPDA_StatusDefinition` is **never modified at runtime**. This is critical for thread safety and cache efficiency. All runtime mutation happens in:
- `FForgeVMContext` (transient, per-execution)
- `FStatusInstance` (persistent, per-instance)
- `FForgeVariableOverride` (applied as a copy, not modifying the definition)

### 5. Variable Defaults Are Copied, Not Referenced

When a status is executed, variable defaults are `memcpy`'d from the definition into the runtime blob. Subsequent `OP_SetVariable` instructions modify only the runtime copy. This means multiple instances of the same definition each get independent variable state.
