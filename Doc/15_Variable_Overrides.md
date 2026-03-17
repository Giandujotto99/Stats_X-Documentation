# 15 — Variable Overrides

> **Stats_X v1.404** — FForgeVariableOverride, ApplyVariableOverrides, UStatsXBlueprintLibrary
> Caller-side variable customization at cast time — type-safe factories, raw byte serialization,
> object pool allocation, event payload reuse, and the full application pipeline.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Override Pipeline](#2-override-pipeline)
3. [FForgeVariableOverride Struct](#3-forgevariableoverride-struct)
4. [Factory Methods (C++)](#4-factory-methods-c)
5. [Blueprint Library](#5-blueprint-library)
6. [ApplyVariableOverrides — Full Flow](#6-applyvariableoverrides--full-flow)
7. [Type Validation (Editor-Only)](#7-type-validation-editor-only)
8. [Object & Class Overrides](#8-object--class-overrides)
9. [Unsupported Override Targets](#9-unsupported-override-targets)
10. [Cast API Integration](#10-cast-api-integration)
11. [Event Payload Reuse](#11-event-payload-reuse)
12. [Async Load & Override Capture](#12-async-load--override-capture)
13. [API Reference](#13-api-reference)

---

## 1. Design Philosophy

Variable overrides allow callers to **customize initial variable values when casting a status**, without modifying the compiled StatusDefinition. They are the primary mechanism for parameterizing generic statuses (e.g., setting damage amount, target tag, or duration multiplier at cast time).

| Decision | Rationale |
|----------|-----------|
| **Pre-serialized raw bytes** | Scalar overrides stored as `TArray<uint8>` — memcpy directly into blob, no runtime type conversion |
| **Separate object path** | UObject* can't be stored as raw bytes — dedicated `ObjectValue` field with pool allocation |
| **Type-safe factories** | `MakeFloat()`, `MakeInt32()`, etc. prevent byte-size mismatches at creation time |
| **Blueprint-exposed** | Full `UStatsXBlueprintLibrary` mirrors all C++ factories for visual scripting |
| **Applied after defaults, before execution** | Override values replace defaults without affecting compilation |
| **Reused as event payload** | `SendForgeEvent()` accepts `TArray<FForgeVariableOverride>` as payload — same struct, same factories |

---

## 2. Override Pipeline

```
Caller (C++ or Blueprint)
│
├─ Create TArray<FForgeVariableOverride>
│   ├─ MakeFloat(StatsX.Variable.Damage, 150.f)
│   ├─ MakeGameplayTag(StatsX.Variable.DamageType, Tag_Fire)
│   └─ MakeObject(StatsX.Variable.Instigator, InstigatorActor)
│
├─ CastStatusAsync(StatusTag, Caster, Target, Overrides)
│   └─ or CastStatusSync(...)
│
└───────────────────────────────────────────────────────────┐
                                                            ▼
ForgeVM::ExecuteStatus(StatusID, Definition, Caster, Target, &Overrides)
│
├─ Pass 1: Allocate VariableBlob
├─ Pass 2: Copy defaults from Pool_StructData
├─ Pass 3: Fix up pool-backed defaults (tags, objects, arrays)
│
├─ ★ ApplyVariableOverrides(Overrides)  ← overrides applied here
│   ├─ For each override: FindVariable(Tag) → memcpy or alloc object
│   └─ Blob now contains overridden values
│
└─ Execute bytecode (handlers read overridden values from blob)
```

**Timing guarantee:** Overrides are applied **after** all default initialization is complete and **before** the first instruction executes. This means override values are always visible to the status logic from the very first instruction.

---

## 3. FForgeVariableOverride Struct

```
Source  : Public/Data/StatsXTypes.h (lines 955–1008)
```

```cpp
USTRUCT(BlueprintType)
struct STATS_X_API FForgeVariableOverride
{
    GENERATED_BODY()

    /** Variable tag identifying which variable to override */
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Variable Override",
              meta = (Categories = "StatsX.Variable"))
    FGameplayTag VariableTag;

    /** Pre-serialized raw bytes in VariableBlob native format.
     *  Ignored when bIsObjectOverride is true. */
    UPROPERTY()
    TArray<uint8> RawValue;

    /** For Object/Class overrides: the UObject* to register in the context object pool. */
    UPROPERTY()
    TObjectPtr<UObject> ObjectValue = nullptr;

    /** True if this override targets an Object/Class variable. */
    UPROPERTY()
    bool bIsObjectOverride = false;
};
```

### Field Responsibilities

| Field | Scalar Types | Object/Class Types |
|-------|-------------|-------------------|
| `VariableTag` | Identifies the variable | Identifies the variable |
| `RawValue` | Pre-serialized bytes (sizeof(T)) | Ignored |
| `ObjectValue` | Unused (nullptr) | The UObject* to inject |
| `bIsObjectOverride` | `false` | `true` |

### Internal Serialization Template

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

All scalar factories delegate to `MakeRaw<T>()`, which performs a bitwise copy of the value into a byte array of exactly `sizeof(T)` bytes.

---

## 4. Factory Methods (C++)

```
Source  : Public/Data/StatsXTypes.h (static methods)
         Private/Data/StatsXTypes.cpp (implementations)
```

### Scalar Factories (via MakeRaw)

| Factory | Value Type | RawValue Size |
|---------|-----------|---------------|
| `MakeFloat(Tag, float)` | `float` | 4 bytes |
| `MakeInt32(Tag, int32)` | `int32` | 4 bytes |
| `MakeBool(Tag, bool)` | `uint8` (0/1) | 1 byte |
| `MakeByte(Tag, uint8)` | `uint8` | 1 byte |
| `MakeInt64(Tag, int64)` | `int64` | 8 bytes |
| `MakeDouble(Tag, double)` | `double` | 8 bytes |
| `MakeVector(Tag, FVector)` | `FVector` | 24 bytes |
| `MakeRotator(Tag, FRotator)` | `FRotator` | 24 bytes |
| `MakeTransform(Tag, FTransform)` | `FTransform` | 80 bytes |
| `MakeLinearColor(Tag, FLinearColor)` | `FLinearColor` | 16 bytes |
| `MakeGameplayTag(Tag, FGameplayTag)` | `FGameplayTag` | `sizeof(FGameplayTag)` |
| `MakeName(Tag, FName)` | `FName` | `sizeof(FName)` |

### Bool Special Case

```cpp
FForgeVariableOverride FForgeVariableOverride::MakeBool(FGameplayTag Tag, bool Value)
{
    uint8 ByteVal = Value ? 1 : 0;
    return MakeRaw(Tag, ByteVal);  // Serializes as uint8, not bool
}
```

Booleans are stored as `uint8` in the blob (1 byte), matching the VariableBlob encoding.

### Object/Class Factories

```cpp
FForgeVariableOverride FForgeVariableOverride::MakeObject(FGameplayTag Tag, UObject* Value)
{
    FForgeVariableOverride Override;
    Override.VariableTag = Tag;
    Override.ObjectValue = Value;
    Override.bIsObjectOverride = true;
    return Override;
}

FForgeVariableOverride FForgeVariableOverride::MakeClass(FGameplayTag Tag, UClass* Value)
{
    FForgeVariableOverride Override;
    Override.VariableTag = Tag;
    Override.ObjectValue = Value;      // UClass* stored as UObject*
    Override.bIsObjectOverride = true;
    return Override;
}
```

Object/Class overrides do **not** use `RawValue` — the actual UObject* is stored in `ObjectValue` and allocated into the context object pool at apply time.

---

## 5. Blueprint Library

```
Header  : Public/Helpers/StatsXBlueprintLibrary.h
Source  : Private/Helpers/StatsXBlueprintLibrary.cpp
```

```cpp
UCLASS()
class STATS_X_API UStatsXBlueprintLibrary : public UBlueprintFunctionLibrary
```

All Blueprint factory nodes are `BlueprintPure` and delegate directly to the corresponding C++ static method:

| Blueprint Node | Category | Delegates To |
|---------------|----------|-------------|
| `MakeFloatOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeFloat` |
| `MakeIntOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeInt32` |
| `MakeBoolOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeBool` |
| `MakeByteOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeByte` |
| `MakeInt64Override` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeInt64` |
| `MakeDoubleOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeDouble` |
| `MakeVectorOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeVector` |
| `MakeRotatorOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeRotator` |
| `MakeTransformOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeTransform` |
| `MakeLinearColorOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeLinearColor` |
| `MakeGameplayTagOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeGameplayTag` |
| `MakeNameOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeName` |
| `MakeObjectOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeObject` |
| `MakeClassOverride` | `StatsX\|Variable Override` | `FForgeVariableOverride::MakeClass` |

All tag parameters use `meta = (Categories = "StatsX.Variable")` for filtered tag picker in the editor.

### Blueprint Usage Pattern

```
[Make Float Override] ─── Tag: StatsX.Variable.Damage, Value: 150
          │
[Make Tag Override] ────── Tag: StatsX.Variable.Element, Value: StatsX.Element.Fire
          │
[Make Array] ─────────────── TArray<FForgeVariableOverride>
          │
[Cast Status Async] ──────── StatusTag, Caster, Target, Overrides
```

---

## 6. ApplyVariableOverrides — Full Flow

```
Source  : Private/VM/ForgeVM.cpp (lines 1382–1473)
```

```cpp
void FForgeVM::ApplyVariableOverrides(const TArray<FForgeVariableOverride>& Overrides)
```

### Step-by-Step Flow

```
ApplyVariableOverrides(Overrides[])
│
├─ Guard: Definition must exist, VariableBlob must be non-empty
│
├─ For each FForgeVariableOverride:
│   │
│   ├─ 1. FindVariable(Override.VariableTag)
│   │     └─ Binary search on sorted VariableHeaders
│   │     └─ Not found → SKIP (editor warning)
│   │
│   ├─ 2. Container Mode Check
│   │     └─ Array (1) or Set (2) → SKIP (unsafe, see Section 9)
│   │
│   ├─ 3a. [bIsObjectOverride == true]
│   │     ├─ AllocContextObject(Override.ObjectValue) → uint16 index
│   │     ├─ Bounds check: Header->Offset + 2 ≤ BlobSize
│   │     └─ Memcpy uint16 index → BlobData + Header->Offset
│   │
│   └─ 3b. [bIsObjectOverride == false]  (Scalar)
│         ├─ ValueSize = Override.RawValue.Num()
│         ├─ Bounds check: Header->Offset + ValueSize ≤ BlobSize
│         ├─ [Editor-only] Type size validation (Section 7)
│         └─ Memcpy RawValue → BlobData + Header->Offset
│
└─ Done — blob contains overridden values
```

### Key Characteristics

| Property | Detail |
|----------|--------|
| **Iteration** | Linear scan over overrides array — O(n × log m) total where n = overrides, m = variable count |
| **Lookup** | `FindVariable()` — linear for ≤16 headers, binary search for >16 |
| **Write** | Direct `FMemory::Memcpy` into blob — no allocation for scalar types |
| **Safety** | Bounds-checked: offset + size must fit within blob |
| **Idempotent** | Multiple overrides for the same tag: last one wins (sequential application) |

---

## 7. Type Validation (Editor-Only)

In `WITH_EDITOR` builds, `ApplyVariableOverrides` performs a size validation check before writing scalar overrides:

```cpp
int32 ExpectedSize = 0;
switch (Header->FieldType)
{
    case 1:  ExpectedSize = 4; break;                   // Float
    case 2:  ExpectedSize = 4; break;                   // Int32
    case 3:  ExpectedSize = 1; break;                   // Bool
    case 4:  ExpectedSize = sizeof(FGameplayTag); break; // GameplayTag
    case 6:  ExpectedSize = 4; break;                   // Enum
    case 9:  ExpectedSize = sizeof(FName); break;       // Name
    case 11: ExpectedSize = 1; break;                   // Byte
    case 12: ExpectedSize = 8; break;                   // Int64
    case 13: ExpectedSize = 8; break;                   // Double
    case 14: ExpectedSize = sizeof(FVector); break;     // Vector
    case 15: ExpectedSize = sizeof(FRotator); break;    // Rotator
    case 16: ExpectedSize = sizeof(FTransform); break;  // Transform
    case 17: ExpectedSize = sizeof(FLinearColor); break; // LinearColor
    default: ExpectedSize = 0; break;
}

if (ExpectedSize > 0 && ValueSize != ExpectedSize)
{
    STATSX_LOG(Warning,
        "ApplyVariableOverrides: Variable '%s' type size mismatch (expected %d, got %d)",
        *Override.VariableTag.ToString(), ExpectedSize, ValueSize);
    continue;  // SKIP — prevents corrupting adjacent variables
}
```

This catches mismatches like passing a `MakeFloat()` override for an `int64` variable (4 bytes vs 8 bytes). In shipping builds, the size check is skipped for performance — factories guarantee correct sizes when used properly.

---

## 8. Object & Class Overrides

Object/Class variables use **pool index indirection** in the blob (see doc 14). The override system handles this:

```
Override.ObjectValue = SomeActor*
         │
         ▼
AllocContextObject(SomeActor) → uint16 PoolIndex (e.g., 3)
         │
         ▼
VariableBlob[Header->Offset] = 0x0003 (2 bytes)
         │
         ▼
Context.ContextObjectStack[3] = SomeActor*
```

### Why Not RawValue?

| Reason | Detail |
|--------|--------|
| **GC safety** | UObject* must be in a UPROPERTY-tracked container — raw bytes aren't tracked |
| **Pool allocation** | The blob stores a `uint16` index, not the pointer — allocation must happen at apply time |
| **Cross-domain** | Context pool indices are assigned per-execution — they can't be pre-baked |

### Object Override Field Sizes

Both Object and Class types occupy exactly 2 bytes in the blob (`sizeof(uint16)` = pool index).

---

## 9. Unsupported Override Targets

### Array / Set Variables

```cpp
if (Header->ContainerMode == 1 /*Array*/ || Header->ContainerMode == 2 /*Set*/)
{
    continue;  // Skip silently
}
```

Array and Set variables store a `uint16` handle into the `ContextArrayPool`. Overwriting this handle with raw bytes would **corrupt the pool mapping** — the handle is an opaque index assigned during initialization.

### Struct Variables

Struct variables (FieldType 20) are not explicitly handled by the override system's size validation table. While raw byte overrides could theoretically work for POD-only structs, struct overrides are not officially supported because:

- Struct layouts depend on `FForgeStructDescriptor` (internal to the compiler)
- Object/Class fields within structs need pool remapping
- No factory method exists for arbitrary struct types

### GameplayTagContainer Variables

GameplayTagContainer overrides are not covered by the size validation table. The inline blob format (`[uint16 Count][Tag × Count]`) has a variable size depending on tag count, making raw byte override fragile.

---

## 10. Cast API Integration

Both status casting APIs accept overrides as their final parameter:

### CastStatusAsync

```cpp
UFUNCTION(BlueprintCallable, Category = "-XForge|Stats_X|Component|Status|Execution")
int64 CastStatusAsync(
    UPARAM(meta = (Categories = "StatsX.Status")) FGameplayTag StatusTag,
    AActor* CasterActor,
    AActor* TargetActor,
    const TArray<FForgeVariableOverride>& Overrides);
```

### CastStatusSync

```cpp
UFUNCTION(BlueprintCallable, Category = "-XForge|Stats_X|Component|Status|Execution")
EForgeExecutionResult CastStatusSync(
    UPARAM(meta = (Categories = "StatsX.Status")) FGameplayTag StatusTag,
    AActor* CasterActor,
    AActor* TargetActor,
    const TArray<FForgeVariableOverride>& Overrides);
```

### ForgeVM::ExecuteStatus

Both cast methods forward to the VM, which accepts overrides as an optional pointer:

```cpp
EForgeExecutionResult ExecuteStatus(
    int64 StatusID,
    const UPDA_StatusDefinition* Definition,
    AActor* CasterActor,
    AActor* TargetActor,
    const TArray<FForgeVariableOverride>* Overrides = nullptr);
```

**nullptr optimization:** When the override array is empty, the component passes `nullptr` to avoid the overhead of iterating an empty array:

```cpp
const bool bHasOverrides = Overrides.Num() > 0;
// ...
StatsXWorldSubsystem->ExecuteStatus(StatusID, DA_StatusDefinition,
    CasterActor, TargetActor, bHasOverrides ? &Overrides : nullptr);
```

---

## 11. Event Payload Reuse

`FForgeVariableOverride` is reused as the **event payload** for the Forge Event System:

### Component API

```cpp
UFUNCTION(BlueprintCallable, Category = "StatsX|Events",
          meta = (AutoCreateRefTerm = "Payload"))
int32 SendForgeEvent(
    UPARAM(meta = (Categories = "StatsX.Event")) FGameplayTag EventTag,
    const TArray<FForgeVariableOverride>& Payload);
```

### WorldSubsystem API

```cpp
int32 SendForgeEvent(
    FGameplayTag EventTag,
    AActor* ScopeActor,
    const TArray<FForgeVariableOverride>& Payload);
```

### Blueprint Library (Static)

```cpp
UFUNCTION(BlueprintCallable, Category = "StatsX|Events",
          meta = (WorldContext = "WorldContextObject", AutoCreateRefTerm = "Payload"))
static int32 SendForgeEvent(
    const UObject* WorldContextObject,
    FGameplayTag EventTag,
    AActor* ScopeActor,
    const TArray<FForgeVariableOverride>& Payload);
```

**Same factories, same struct** — the `MakeFloat()`, `MakeObject()`, etc. factories work identically for both variable overrides and event payloads. When a `WaitForEvent` listener resumes, the payload overrides are applied to its variables automatically.

---

## 12. Async Load & Override Capture

When `CastStatusAsync` triggers an async asset load, overrides must **survive the async gap**:

```cpp
if (bHasOverrides)
{
    // Copy overrides into lambda capture (must survive async load)
    TArray<FForgeVariableOverride> OverridesCopy = Overrides;

    StreamableManager.RequestAsyncLoad(AssetToLoad,
        FStreamableDelegate::CreateLambda(
            [StatusID, SoftRefStatusData, WeakCaster, WeakTarget, WeakSubsystem,
             CapturedOverrides = MoveTemp(OverridesCopy)]()
            {
                if (auto* Subsystem = WeakSubsystem.Get())
                {
                    Subsystem->ExecuteStatus(StatusID, LoadedDef,
                        WeakCaster.Get(), WeakTarget.Get(), &CapturedOverrides);
                }
            }));
}
else
{
    // No overrides — lightweight lambda without extra capture
    StreamableManager.RequestAsyncLoad(AssetToLoad,
        FStreamableDelegate::CreateLambda([...]() { /* no override param */ }));
}
```

### Key Details

| Aspect | Detail |
|--------|--------|
| **Copy semantics** | Overrides array is **deep copied** before capture (`OverridesCopy = Overrides`) |
| **Move into lambda** | `MoveTemp(OverridesCopy)` avoids a second copy when captured |
| **Branch optimization** | Two lambda paths — with and without overrides — avoid empty array overhead |
| **Object lifetime** | `ObjectValue` is `TObjectPtr<UObject>` — GC-tracked within the override copy |
| **Actor safety** | Caster/Target captured as `TWeakObjectPtr` — may be null by the time the load completes |

---

## 13. API Reference

### FForgeVariableOverride

| Field | Type | Description |
|-------|------|-------------|
| `VariableTag` | `FGameplayTag` | Target variable identifier |
| `RawValue` | `TArray<uint8>` | Pre-serialized scalar bytes |
| `ObjectValue` | `TObjectPtr<UObject>` | UObject* for object/class overrides |
| `bIsObjectOverride` | `bool` | Discriminant for object vs scalar path |

### C++ Factory Methods (Static on FForgeVariableOverride)

| Method | Parameter Type | Blob Size |
|--------|---------------|-----------|
| `MakeFloat` | `float` | 4 |
| `MakeInt32` | `int32` | 4 |
| `MakeBool` | `bool` → `uint8` | 1 |
| `MakeByte` | `uint8` | 1 |
| `MakeInt64` | `int64` | 8 |
| `MakeDouble` | `double` | 8 |
| `MakeVector` | `FVector` | 24 |
| `MakeRotator` | `FRotator` | 24 |
| `MakeTransform` | `FTransform` | 80 |
| `MakeLinearColor` | `FLinearColor` | 16 |
| `MakeGameplayTag` | `FGameplayTag` | `sizeof(FGameplayTag)` |
| `MakeName` | `FName` | `sizeof(FName)` |
| `MakeObject` | `UObject*` | 2 (pool index) |
| `MakeClass` | `UClass*` | 2 (pool index) |

### Blueprint Factory Nodes (UStatsXBlueprintLibrary)

| Node | Category |
|------|----------|
| `MakeFloatOverride` | `StatsX\|Variable Override` |
| `MakeIntOverride` | `StatsX\|Variable Override` |
| `MakeBoolOverride` | `StatsX\|Variable Override` |
| `MakeByteOverride` | `StatsX\|Variable Override` |
| `MakeInt64Override` | `StatsX\|Variable Override` |
| `MakeDoubleOverride` | `StatsX\|Variable Override` |
| `MakeVectorOverride` | `StatsX\|Variable Override` |
| `MakeRotatorOverride` | `StatsX\|Variable Override` |
| `MakeTransformOverride` | `StatsX\|Variable Override` |
| `MakeLinearColorOverride` | `StatsX\|Variable Override` |
| `MakeGameplayTagOverride` | `StatsX\|Variable Override` |
| `MakeNameOverride` | `StatsX\|Variable Override` |
| `MakeObjectOverride` | `StatsX\|Variable Override` |
| `MakeClassOverride` | `StatsX\|Variable Override` |

### VM Integration

| Function | Signature |
|----------|-----------|
| `FForgeVM::ApplyVariableOverrides` | `void ApplyVariableOverrides(const TArray<FForgeVariableOverride>&)` |
| `FForgeVM::ExecuteStatus` | `EForgeExecutionResult ExecuteStatus(int64, const UPDA_StatusDefinition*, AActor*, AActor*, const TArray<FForgeVariableOverride>* = nullptr)` |

### Cast APIs (UStatsX_StatsComponentBase)

| Function | Returns | Override Param |
|----------|---------|----------------|
| `CastStatusAsync` | `int64` (StatusID) | `const TArray<FForgeVariableOverride>&` |
| `CastStatusSync` | `EForgeExecutionResult` | `const TArray<FForgeVariableOverride>&` |

### Event APIs (Using Override as Payload)

| Function | Owner | Override/Payload Param |
|----------|-------|----------------------|
| `SendForgeEvent` | `UStatsX_StatsComponentBase` | `const TArray<FForgeVariableOverride>& Payload` |
| `SendForgeEvent` | `UStatsX_WorldSubsystem` | `const TArray<FForgeVariableOverride>& Payload` |
| `SendForgeEvent` | `UStatsXBlueprintLibrary` (static) | `const TArray<FForgeVariableOverride>& Payload` |

---

*Document generated from source — Stats_X v1.404*
