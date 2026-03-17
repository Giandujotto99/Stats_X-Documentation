# 14 — Variable System

> **Stats_X v1.404** — FForgeVariableHeader, VariableBlob, ForgeVariableAccess, OP_SetVariable / OP_GetVariable
> Typed, tag-addressed, compiler-laid-out variable storage within status instances —
> from blob allocation and defaults initialization to runtime read/write and struct deep-copy.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Architecture Overview](#2-architecture-overview)
3. [FForgeVariableHeader](#3-forgevariableheader)
4. [VariableBlob Layout](#4-variableblob-layout)
5. [Field Type Table](#5-field-type-table)
6. [Variable Table (StatusDefinition)](#6-variable-table-statusdefinition)
7. [FindVariable — Tag Lookup](#7-findvariable--tag-lookup)
8. [Three-Pass Initialization](#8-three-pass-initialization)
9. [OP_SetVariable Handler](#9-op_setvariable-handler)
10. [OP_GetVariable Handler](#10-op_getvariable-handler)
11. [ForgeVariableAccess Helper](#11-forgevariableaccess-helper)
12. [Container Variables (Array / Set)](#12-container-variables-array--set)
13. [GameplayTagContainer Encoding](#13-gameplaytagcontainer-encoding)
14. [Object Indirection & Pool Remapping](#14-object-indirection--pool-remapping)
15. [Struct Variables & Deep-Copy](#15-struct-variables--deep-copy)
16. [Variable Overrides](#16-variable-overrides)
17. [Context vs Instance Blob](#17-context-vs-instance-blob)
18. [API Reference](#18-api-reference)

---

## 1. Design Philosophy

The Variable System provides **typed, tag-addressed, per-instance persistent storage** for status logic. Variables are the primary way for status bytecode to maintain mutable state across ticks, suspensions, and event callbacks.

| Decision | Rationale |
|----------|-----------|
| **Flat binary blob** | All variables packed into a single `TArray<uint8>` — zero indirection, cache-friendly |
| **Compiler-resolved offsets** | Blob offsets are computed at compile time and baked into instructions — no runtime tag lookups in the hot path |
| **Tag-based access for external consumers** | Interceptors and Custom Logics use `FindVariable()` (binary search) — correct but slower than handlers |
| **Typed field descriptors** | 24 supported field types with size validation and pool indirection |
| **Container modes** | Single (scalar), Array, Set — arrays/sets use handle indirection into a separate pool |
| **Three-pass initialization** | Allocate → copy defaults → remap pool-backed defaults (tags, objects) |
| **Object indirection** | UObject* stored as uint16 pool indices — GC-safe, 8→2 byte compression |

---

## 2. Architecture Overview

```
UPDA_StatusDefinition (Compiled Asset)
│
├── VariableHeaders[]          Sorted descriptors (tag, offset, type, container)
├── VariableBlobSize           Total blob allocation in bytes
├── VariableDefaultsHeaderIndex   Pool_StructHeaders index for defaults
├── StructDescriptors[]        Pre-computed struct layouts
├── ArraySlotCount             Number of array/set slots
└── ArraySlotElementTypes[]    Per-slot element type

                 ┌──────── ForgeVM Init ────────┐
                 │ 1. Allocate blob              │
                 │ 2. Copy defaults from pool    │
                 │ 3. Fix up tags/objects/arrays  │
                 └──────────────┬────────────────┘
                                ▼
              ┌──────────── VariableBlob ───────────────┐
              │ [Float][Int32][Bool][Tag][uint16]...     │
              │  ↑offset 0   ↑off 4  ↑off 8  etc.      │
              └─────────────────────────────────────────┘
                                │
           ┌────────────────────┼────────────────────┐
           │                    │                    │
    OP_SetVariable       OP_GetVariable      ForgeVariableAccess
    (compiler offset)    (compiler offset)   (binary search by tag)
```

---

## 3. FForgeVariableHeader

```
Source  : Public/Data/StatusDefinition.h
```

```cpp
USTRUCT()
struct STATS_X_API FForgeVariableHeader
{
    GENERATED_BODY()

    FGameplayTag Tag;               // Variable identifier (e.g. StatsX.Variable.DamageAccumulator)
    uint16 Offset;                  // Byte offset in VariableBlob
    uint8  FieldType;               // EForgeFieldType (1=Float, 2=Int32, ... see Section 5)
    uint8  ContainerMode;           // 0=Single, 1=Array, 2=Set
    uint16 Count;                   // Array/Set: MaxCapacity. TagContainer: max tag count
    uint16 StructDescriptorIndex;   // Index into StructDescriptors (0xFFFF if not struct)
    uint16 DefaultValuePoolIndex;   // Pool index for tag/object defaults (0xFFFF if none)
};
```

### Field Breakdown

| Field | Size | Description |
|-------|------|-------------|
| `Tag` | `FGameplayTag` | Unique identifier under `StatsX.Variable.*` |
| `Offset` | `uint16` | Byte offset in the blob — compiler-determined, baked into instructions |
| `FieldType` | `uint8` | Type discriminant matching `ForgeFieldTypes` constants |
| `ContainerMode` | `uint8` | `0` = scalar, `1` = Array, `2` = Set |
| `Count` | `uint16` | For containers: max capacity. For GameplayTagContainer in Single mode: max tag count |
| `StructDescriptorIndex` | `uint16` | Index into `StructDescriptors[]` for struct-typed variables (0xFFFF if not struct) |
| `DefaultValuePoolIndex` | `uint16` | Pool index for tag-based or object defaults (0xFFFF = no pool-backed default) |

---

## 4. VariableBlob Layout

The VariableBlob is a flat `TArray<uint8>` where each variable occupies a contiguous region at its compile-time `Offset`:

```
Byte 0                                                    VariableBlobSize
├──────┬──────┬──────┬──────────┬──────────┬──────────────┤
│Float │Int32 │uint8 │FGameplay │ uint16   │ uint16+Tags  │
│(4B)  │(4B)  │(1B)  │Tag       │ (handle) │ (container)  │
│      │      │Bool  │          │ Array    │ TagContainer │
└──────┴──────┴──────┴──────────┴──────────┴──────────────┘
 Off 0   Off 4  Off 8  Off 9     Off 17     Off 19
```

**Size per type:**

| Type | Blob Footprint |
|------|----------------|
| Scalar (float, int32, etc.) | `sizeof(T)` |
| Object / Class | `sizeof(uint16)` = 2 bytes (pool index) |
| String / Text | `sizeof(uint16)` = 2 bytes (pool index) |
| FName | `sizeof(FName)` |
| FGameplayTag | `sizeof(FGameplayTag)` |
| FVector | `sizeof(FVector)` = 24 bytes |
| FRotator | `sizeof(FRotator)` = 24 bytes |
| FTransform | `sizeof(FTransform)` = 80 bytes |
| FLinearColor | `sizeof(FLinearColor)` = 16 bytes |
| Array / Set | `sizeof(uint16)` = 2 bytes (handle into array slot pool) |
| GameplayTagContainer | `2 + Count * sizeof(FGameplayTag)` (inline count + tags) |

---

## 5. Field Type Table

```
Source  : Public/Helpers/ForgeVariableAccess.h (ForgeFieldTypes namespace)
```

| Constant | Value | C++ Type | Blob Size |
|----------|-------|----------|-----------|
| `Float` | 1 | `float` | 4 |
| `Int32` | 2 | `int32` | 4 |
| `Bool` | 3 | `uint8` | 1 |
| `GameplayTag` | 4 | `FGameplayTag` | `sizeof(FGameplayTag)` |
| `Object` | 5 | `uint16` (pool index) | 2 |
| `Enum` | 6 | `uint8` | 1 |
| `String` | 7 | `uint16` (pool index) | 2 |
| `Class` | 8 | `uint16` (pool index) | 2 |
| `Name` | 9 | `FName` | `sizeof(FName)` |
| `Text` | 10 | `uint16` (pool index) | 2 |
| `Byte` | 11 | `uint8` | 1 |
| `Int64` | 12 | `int64` | 8 |
| `Double` | 13 | `double` | 8 |
| `Vector` | 14 | `FVector` | 24 |
| `Rotator` | 15 | `FRotator` | 24 |
| `Transform` | 16 | `FTransform` | 80 |
| `LinearColor` | 17 | `FLinearColor` | 16 |
| `SoftObject` | 18 | — | — |
| `SoftClass` | 19 | — | — |
| `Struct` | 20 | Custom | `FForgeStructDescriptor::SerializedSize` |
| `GameplayTagContainer` | 24 | inline | `2 + Count × sizeof(FGameplayTag)` |

---

## 6. Variable Table (StatusDefinition)

```
Source  : Public/Data/StatusDefinition.h (lines 576–607)
```

The compiled `UPDA_StatusDefinition` stores the variable metadata:

```cpp
// Sorted variable headers (binary search by tag)
TArray<FForgeVariableHeader> VariableHeaders;

// Total size in bytes of the dedicated variable blob
int32 VariableBlobSize = 0;

// Index into Pool_StructHeaders for the variable defaults blob in Pool_StructData.
// -1 means no variable defaults.
int32 VariableDefaultsHeaderIndex = -1;

// Pre-computed struct layouts for struct-typed variables
TArray<FForgeStructDescriptor> StructDescriptors;

// Total number of unique array slots required (variable arrays + transient)
int32 ArraySlotCount = 0;

// Per-slot element type (indexed 1:1 by array handle)
TArray<uint8> ArraySlotElementTypes;
```

**VariableHeaders** are sorted lexically by tag name at compile time, enabling O(log n) binary search at runtime.

---

## 7. FindVariable — Tag Lookup

```
Source  : Public/Data/StatusDefinition.h (lines 661–700)
```

```cpp
const FForgeVariableHeader* FindVariable(const FGameplayTag& Tag) const
```

**Dual-strategy lookup:**

| Table Size | Strategy | Rationale |
|------------|----------|-----------|
| ≤ 16 entries | Linear scan | Cache-friendly contiguous walk, lower branch overhead |
| > 16 entries | Binary search | O(log n) with lexical ordering matching compiler sort |

```cpp
constexpr int32 LinearScanThreshold = 16;
if (NumHeaders <= LinearScanThreshold)
{
    // Linear scan — locality-optimized for small tables
    for (const FForgeVariableHeader& Header : VariableHeaders)
    {
        if (Header.Tag.GetTagName() == SearchName)
            return &Header;
    }
    return nullptr;
}

// Binary search — lexical FName ordering
int32 Lo = 0, Hi = NumHeaders - 1;
while (Lo <= Hi)
{
    int32 Mid = (Lo + Hi) / 2;
    const FName MidName = VariableHeaders[Mid].Tag.GetTagName();
    if (MidName == SearchName)       return &VariableHeaders[Mid];
    else if (MidName.LexicalLess(SearchName)) Lo = Mid + 1;
    else                             Hi = Mid - 1;
}
return nullptr;
```

**Note:** Handlers (OP_SetVariable, OP_GetVariable) use **compiler-resolved offsets** and never call `FindVariable()`. This function is used by `ForgeVariableAccess` (interceptors, custom logics) for tag-based external access.

---

## 8. Three-Pass Initialization

```
Source  : Private/VM/ForgeVM.cpp (ExecuteStatus, lines 691–838)
```

When a status begins execution, the ForgeVM initializes the VariableBlob in three passes:

### Pass 1 — Allocate & Copy Defaults

```cpp
if (Definition->VariableBlobSize > 0)
{
    GlobalContext.AllocateVariableBlob(Definition->VariableBlobSize);

    if (Definition->VariableDefaultsHeaderIndex >= 0)
    {
        // memcpy defaults blob from Pool_StructData into VariableBlob
        FMemory::Memcpy(GlobalContext.VariableBlob.GetData(),
                        Definition->Pool_StructData.GetData() + Header.Offset,
                        CopySize);
    }
}
```

The defaults blob is a pre-serialized byte array stored in `Pool_StructData`. POD values (float, int32, vectors, etc.) are correct after this step.

### Pass 2 — Fix Up Pool-Backed Defaults

Certain types can't be stored as raw bytes in the defaults blob and need reconstruction from their respective pools:

| Type | Fix-Up Strategy |
|------|-----------------|
| **GameplayTag** | Read from `Pool_Tags[DefaultValuePoolIndex]`, write `sizeof(FGameplayTag)` to blob |
| **GameplayTagContainer** | Reconstruct from `Pool_ArraysHeaders` + `Pool_Tags`: write `[uint16 Count][FGameplayTag × Count]` |
| **Object / Class** | Read from `Pool_Objects[idx]` / `Pool_Classes[idx]`, allocate in `ContextObjectStack`, write `uint16` pool index |

### Pass 3 — Array Slot Initialization

```cpp
// Allocate ContextArrayPool with Definition->ArraySlotCount slots
// For each slot:
//   - Set ElementType from ArraySlotElementTypes[i]
//   - Populate default data from Pool_ArraysHeaders + value pools
//   - Object elements: remap through ContextObjectStack
```

Array/Set variables store only a `uint16` handle in the blob. The actual data lives in `FForgeArraySlot` entries within the `ContextArrayPool`.

---

## 9. OP_SetVariable Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (lines 9103–9287)
OpCode  : 304
```

### Instruction Layout

```
Data0[0-15]:   OpCode (304)
Data0[16-23]:  Flags
Data0[24-39]:  BlobOffset (16 bit, compiler-inlined)
Data0[40-43]:  FieldType (4 bit, compiler-inlined)
Data0[44-45]:  ContainerMode (2 bit: 0=Single, 1=Array, 2=Set)
Data0[46-63]:  Value input (2-bit source + 16-bit payload)
```

### Container Path (Array / Set)

When `ContainerMode == 1 || 2`:

1. Read destination handle (`uint16`) from VariableBlob at `BlobOffset`
2. Read source handle from instruction (2-bit source + 16-bit payload at bit 46)
3. Resolve both `FForgeArraySlot` pointers
4. Deep copy: `DstSlot->Data = SrcSlot->Data`, copy `Count` and `ElementType`
5. **Object remapping:** If source is Context and destination is Instance, remap all `uint16` element indices through `AllocInstanceObject()`

### Scalar Path

Each field type is handled individually:

| FieldType | Read | Write |
|-----------|------|-------|
| Float (1) | `ReadValue<float>(Instr, 0, 46)` | `Memcpy` 4 bytes |
| Int32 (2) | `ReadValue<int32>` | `Memcpy` 4 bytes |
| Bool (3) | `ReadValue<bool>` | `Memcpy` 1 byte (`true → 1`, `false → 0`) |
| GameplayTag (4) | `ReadValue<FGameplayTag>` | `Memcpy sizeof(FGameplayTag)` |
| Object (5) / Class (8) | `ReadValue<UObject*>` | `AllocInstanceObject` or `AllocContextObject` → write `uint16` |
| Byte (11) | `ReadValue<uint8>` | `Memcpy` 1 byte |
| Int64 (12) | `ReadValue<int64>` | `Memcpy` 8 bytes |
| Vector (14) | `ReadValue<FVector>` | `Memcpy` 24 bytes |
| Rotator (15) | `ReadValue<FRotator>` | `Memcpy` 24 bytes |
| Transform (16) | `ReadValue<FTransform>` | `Memcpy` 80 bytes |
| TagContainer (24) | `ReadValue<FGameplayTagContainer>` | Write `[uint16 Count][Tag × Count]` |

---

## 10. OP_GetVariable Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (lines 9289–9434)
OpCode  : 305
```

### Instruction Layout

```
Data0[0-15]:   OpCode (305)
Data0[16-23]:  Flags
Data0[24-39]:  BlobOffset (16 bit, compiler-inlined)
Data0[40-43]:  FieldType (4 bit, compiler-inlined)
Data0[44-45]:  ContainerMode (2 bit: 0=Single, 1=Array, 2=Set)
Data0[46-61]:  Output offset (16 bit — no source flag, always writes to context stack)
```

### Container Path

Array/Set: reads the `uint16` handle from the blob and writes it directly to the context stack via `WriteOutput<uint16>()`. **Zero-copy** — only the handle is transferred, not the array data.

### Scalar Path

Mirrors OP_SetVariable in reverse — reads from blob, writes to context stack via `WriteOutput<T>()`.

**Object/Class special handling:**

```cpp
uint16 ObjIdx;
FMemory::Memcpy(&ObjIdx, Src, sizeof(uint16));
UObject* Obj = Context.Instance
    ? Context.GetInstanceObject(ObjIdx)
    : Context.GetContextObject(ObjIdx);
Context.WriteOutput<UObject*>(OutputOffset, Obj);
```

Dereferences the pool index to obtain the actual `UObject*` pointer for downstream consumption.

---

## 11. ForgeVariableAccess Helper

```
Source  : Public/Helpers/ForgeVariableAccess.h
```

Stateless template functions used by **interceptors** and **custom logics** for tag-based variable access at runtime.

### ReadVariable

```cpp
template<typename T>
bool ReadVariable(const UPDA_StatusDefinition* Definition, const TArray<uint8>& Blob,
    const FGameplayTag& VariableTag, uint8 ExpectedFieldType, T& OutValue)
{
    const FForgeVariableHeader* Header = Definition->FindVariable(VariableTag);
    if (!Header || Header->FieldType != ExpectedFieldType) return false;
    const int32 Offset = Header->Offset;
    if (Offset + sizeof(T) > Blob.Num()) return false;
    FMemory::Memcpy(&OutValue, Blob.GetData() + Offset, sizeof(T));
    return true;
}
```

### WriteVariable

```cpp
template<typename T>
bool WriteVariable(const UPDA_StatusDefinition* Definition, TArray<uint8>& Blob,
    const FGameplayTag& VariableTag, uint8 ExpectedFieldType, const T& Value)
{
    const FForgeVariableHeader* Header = Definition->FindVariable(VariableTag);
    if (!Header || Header->FieldType != ExpectedFieldType) return false;
    const int32 Offset = Header->Offset;
    if (Offset + sizeof(T) > Blob.Num()) return false;
    FMemory::Memcpy(Blob.GetData() + Offset, &Value, sizeof(T));
    return true;
}
```

### GetVariableBlob

```cpp
inline TArray<uint8>& GetVariableBlob(FForgeVMContext& Context)
{
    if (Context.Instance != nullptr)
        return Context.Instance->VariableBlob;
    return Context.VariableBlob;
}
```

Selects the appropriate blob: **Instance** blob for persistent statuses, **Context** blob for transient/inline execution.

### ForgeFieldSizeHelpers

| Function | Purpose |
|----------|---------|
| `GetScalarFieldSize(uint8 FieldType)` | Returns byte size for a single scalar element |
| `GetExpectedVariableSize(const FForgeVariableHeader&)` | Full blob footprint including containers and TagContainers |
| `IsObjectFieldType(uint8 FieldType)` | Returns true for Object (5) or Class (8) |

---

## 12. Container Variables (Array / Set)

Array and Set variables use **handle indirection** rather than storing data directly in the blob.

### Blob Representation

```
VariableBlob:
  [... other vars ...][uint16 Handle][... other vars ...]
                        ↓
                FForgeArraySlot (in ContextArrayPool)
                  ├── Count: uint16
                  ├── ElementType: uint8
                  └── Data: TArray<uint8>  (packed elements)
```

The blob stores only a `uint16` handle (2 bytes). The actual array data lives in `FForgeArraySlot` entries managed by the `ContextArrayPool`.

### Container Modes

| Mode | Value | Blob Size | Semantics |
|------|-------|-----------|-----------|
| Single | 0 | Type-dependent | Scalar value |
| Array | 1 | 2 (uint16 handle) | Ordered, dynamic growth |
| Set | 2 | 2 (uint16 handle) | Unordered, dynamic growth |

### Array Operations

Related opcodes for array manipulation:

| OpCode | Name | Operation |
|--------|------|-----------|
| 306 | `OP_ArrayAdd` | Append element to array |
| 307 | `OP_ArrayGetAt` | Read element by index |
| 308 | `OP_ArrayLength` | Get element count |

---

## 13. GameplayTagContainer Encoding

GameplayTagContainers in Single mode use a compact inline layout in the blob:

```
┌──────────────────┬────────────────┬────────────────┬───┐
│ uint16 Count     │ FGameplayTag 0 │ FGameplayTag 1 │...│
│ (2 bytes)        │ (sizeof each)  │                │   │
└──────────────────┴────────────────┴────────────────┴───┘
Total size: 2 + Count × sizeof(FGameplayTag)
```

- **Count** header: stores the number of tags currently in the container
- **Max capacity:** `FForgeVariableHeader::Count` defines the maximum number of tags (pre-allocated space)
- **Initialization:** Reconstructed from `Pool_ArraysHeaders` + `Pool_Tags` during Pass 2

---

## 14. Object Indirection & Pool Remapping

UObject references are stored as **uint16 pool indices** in the blob rather than raw pointers:

```
VariableBlob: [...][uint16 = 3][...]
                       │
                       ▼
         InstanceObjectPool[3] → UObject* (actual pointer)
         — or —
         ContextObjectStack[3] → UObject* (transient)
```

### Why Indirection?

| Reason | Detail |
|--------|--------|
| **GC safety** | Pool arrays are UPROPERTY — Unreal tracks references |
| **Compression** | 8-byte pointer → 2-byte index |
| **Cross-domain remapping** | Context→Instance migration remaps through callbacks |

### Pool Selection

| Context | Pool Used | Allocation |
|---------|-----------|------------|
| Instance exists | `InstanceObjectPool` | `AllocInstanceObject()` |
| Transient/inline | `ContextObjectStack` | `AllocContextObject()` |

### Remapping on SetVariable

When writing an array from Context to Instance (e.g., during `InitializeFromContext`), object elements must be remapped:

```cpp
// For each element in the array:
UObject* Obj = Context.GetContextObject(CtxIdx);
const uint16 InstIdx = Context.AllocInstanceObject(Obj);
// Write InstIdx to destination slot
```

---

## 15. Struct Variables & Deep-Copy

```
Source  : Public/Helpers/ForgeVariableAccess.h (ForgeStructCopy namespace)
```

Struct-typed variables (FieldType = 20) use pre-computed layout descriptors for efficient cross-domain copying.

### FForgeStructDescriptor

```cpp
USTRUCT()
struct FForgeStructDescriptor
{
    TObjectPtr<UScriptStruct> StructType;   // Original UScriptStruct (resolved by linker)
    uint16 SerializedSize;                   // Total blob footprint
    TArray<FForgeStructFieldMeta> ComplexFields;  // Object/Class refs, nested structs
};
```

### FForgeStructFieldMeta

```cpp
USTRUCT()
struct FForgeStructFieldMeta
{
    uint16 Offset;                // Byte offset within struct region
    uint8  FieldType;             // 5=Object, 8=Class, 20=Struct (nested)
    uint16 NestedDescriptorIndex; // For nested structs (0xFFFF if not)
};
```

### CopyStructFast

```cpp
void CopyStructFast(
    const FForgeStructDescriptor& Desc,
    const TArray<FForgeStructDescriptor>& AllDescs,
    const TArray<uint8>& SrcBlob, int32 SrcOffset,
    TArray<uint8>& DstBlob, int32 DstOffset,
    TFunctionRef<UObject*(uint16)> ResolveObject,
    TFunctionRef<uint16(UObject*)> AllocObject);
```

**Algorithm:**

1. **Bulk memcpy** — copies entire struct region (handles all POD fields in one pass)
2. **Fix up complex fields** — iterates only `ComplexFields`:
   - Object/Class: read source pool index → resolve UObject* → allocate in dest pool → write dest index
   - Nested struct: recurse `CopyStructFast` with nested descriptor

**Complexity:** O(k) where k = number of complex fields. POD-only structs (empty `ComplexFields`) need only the bulk memcpy — zero fixup overhead.

---

## 16. Variable Overrides

```
Source  : Public/Data/StatsXTypes.h (lines 955–1008)
         Private/VM/ForgeVM.cpp (ApplyVariableOverrides, lines 1382–1473)
```

Variable overrides allow callers to customize initial variable values when casting a status.

### FForgeVariableOverride

```cpp
USTRUCT()
struct FForgeVariableOverride
{
    FGameplayTag VariableTag;         // Which variable to override
    TArray<uint8> RawValue;           // Pre-serialized bytes (scalar types)
    TObjectPtr<UObject> ObjectValue;  // For Object/Class overrides
    bool bIsObjectOverride;           // True for Object/Class
};
```

### Factory Methods

```cpp
static FForgeVariableOverride MakeFloat(FGameplayTag Tag, float Value);
static FForgeVariableOverride MakeInt32(FGameplayTag Tag, int32 Value);
static FForgeVariableOverride MakeBool(FGameplayTag Tag, bool Value);
static FForgeVariableOverride MakeByte(FGameplayTag Tag, uint8 Value);
static FForgeVariableOverride MakeInt64(FGameplayTag Tag, int64 Value);
static FForgeVariableOverride MakeDouble(FGameplayTag Tag, double Value);
static FForgeVariableOverride MakeVector(FGameplayTag Tag, FVector Value);
static FForgeVariableOverride MakeRotator(FGameplayTag Tag, FRotator Value);
static FForgeVariableOverride MakeTransform(FGameplayTag Tag, const FTransform& Value);
static FForgeVariableOverride MakeLinearColor(FGameplayTag Tag, FLinearColor Value);
static FForgeVariableOverride MakeGameplayTag(FGameplayTag Tag, FGameplayTag Value);
static FForgeVariableOverride MakeName(FGameplayTag Tag, FName Value);
static FForgeVariableOverride MakeObject(FGameplayTag Tag, UObject* Value);
static FForgeVariableOverride MakeClass(FGameplayTag Tag, UClass* Value);
```

All scalar factories use a templated internal helper:

```cpp
template <typename T>
static FForgeVariableOverride MakeRaw(FGameplayTag Tag, const T& Value)
{
    FForgeVariableOverride Override;
    Override.VariableTag = Tag;
    Override.RawValue.SetNumUninitialized(sizeof(T));
    FMemory::Memcpy(Override.RawValue.GetData(), &Value, sizeof(T));
    return Override;
}
```

### ApplyVariableOverrides

Called by `ForgeVM::ExecuteStatus()` **after** defaults initialization, **before** execution begins.

```
ApplyVariableOverrides(Context, Overrides[])
│
├─ For each FForgeVariableOverride:
│   ├─ FindVariable(Tag) — binary search on VariableHeaders
│   ├─ Skip Array/Set variables (handle indirection makes override unsafe)
│   │
│   ├─ [Object override]:
│   │   ├─ AllocContextObject(ObjectValue)
│   │   └─ Write uint16 index to blob
│   │
│   └─ [Scalar override]:
│       ├─ Editor-only size validation (RawValue.Num() vs expected field size)
│       └─ Memcpy RawValue into blob at Header->Offset
│
└─ Done — blob now contains overridden values
```

---

## 17. Context vs Instance Blob

The system maintains two potential blob locations:

| Blob | Owner | Lifetime | Usage |
|------|-------|----------|-------|
| `FForgeVMContext::VariableBlob` | VM context (transient) | Single execution frame | Inline/transient execution, before instance migration |
| `FStatusInstance::VariableBlob` | Pool instance (persistent) | Instance lifetime | Persistent status variables across ticks and suspensions |

### Selection Logic

```cpp
TArray<uint8>& GetVariableBlob(FForgeVMContext& Context)
{
    if (Context.Instance != nullptr)
        return Context.Instance->VariableBlob;
    return Context.VariableBlob;
}
```

**Flow:**

1. **ExecuteStatus** initializes `Context.VariableBlob`
2. If the status acquires a pool instance, variables are migrated to `Instance->VariableBlob`
3. All subsequent reads/writes target the instance blob
4. On context reset, the transient blob is zeroed but capacity is preserved

---

## 18. API Reference

### Handler Registration

| OpCode | Name | Handler |
|--------|------|---------|
| 304 | `OP_SetVariable` | `Nodes_Variables::SetVariable` |
| 305 | `OP_GetVariable` | `Nodes_Variables::GetVariable` |

### ForgeVariableAccess

| Function | Signature |
|----------|-----------|
| `ReadVariable<T>` | `bool ReadVariable(const UPDA_StatusDefinition*, const TArray<uint8>&, const FGameplayTag&, uint8 ExpectedFieldType, T& OutValue)` |
| `WriteVariable<T>` | `bool WriteVariable(const UPDA_StatusDefinition*, TArray<uint8>&, const FGameplayTag&, uint8 ExpectedFieldType, const T& Value)` |
| `GetVariableBlob` | `TArray<uint8>& GetVariableBlob(FForgeVMContext&)` |
| `GetVariableBlobConst` | `const TArray<uint8>& GetVariableBlobConst(const FForgeVMContext&)` |

### ForgeFieldSizeHelpers

| Function | Signature |
|----------|-----------|
| `GetScalarFieldSize` | `int32 GetScalarFieldSize(uint8 FieldType)` |
| `GetExpectedVariableSize` | `int32 GetExpectedVariableSize(const FForgeVariableHeader&)` |
| `IsObjectFieldType` | `bool IsObjectFieldType(uint8 FieldType)` |

### ForgeStructCopy

| Function | Signature |
|----------|-----------|
| `CopyStructFast` | `void CopyStructFast(const FForgeStructDescriptor&, const TArray<FForgeStructDescriptor>&, const TArray<uint8>&, int32, TArray<uint8>&, int32, TFunctionRef<UObject*(uint16)>, TFunctionRef<uint16(UObject*)>)` |

### FForgeVariableOverride Factory Methods

| Method | Type |
|--------|------|
| `MakeFloat` | `float` |
| `MakeInt32` | `int32` |
| `MakeBool` | `bool` |
| `MakeByte` | `uint8` |
| `MakeInt64` | `int64` |
| `MakeDouble` | `double` |
| `MakeVector` | `FVector` |
| `MakeRotator` | `FRotator` |
| `MakeTransform` | `FTransform` |
| `MakeLinearColor` | `FLinearColor` |
| `MakeGameplayTag` | `FGameplayTag` |
| `MakeName` | `FName` |
| `MakeObject` | `UObject*` |
| `MakeClass` | `UClass*` |

### Key Structures

| Struct | Source |
|--------|--------|
| `FForgeVariableHeader` | `Public/Data/StatusDefinition.h` |
| `FForgeStructDescriptor` | `Public/Data/StatusDefinition.h` |
| `FForgeStructFieldMeta` | `Public/Data/StatusDefinition.h` |
| `FForgeVariableOverride` | `Public/Data/StatsXTypes.h` |

---

*Document generated from source — Stats_X v1.404*
