# 12 — Custom Logic — Check

> **Stats_X v1.404** — UForgeCustomCheck, UForgeCustomLogicBase, Built-in Check Handlers
> Synchronous condition evaluation within the ForgeVM — from user-defined
> Blueprint/C++ checks to built-in attribute, tag, chance, and comparison nodes.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Class Hierarchy](#2-class-hierarchy)
3. [UForgeCustomLogicBase](#3-forgecustomlogicbase)
4. [UForgeCustomCheck](#4-forgecustomcheck)
5. [OP_CustomCheck Handler](#5-op_customcheck-handler)
6. [ForgeParam Injection](#6-forgeparam-injection)
7. [Variable Accessors](#7-variable-accessors)
8. [Built-in Check Nodes](#8-built-in-check-nodes)
9. [Condition Register](#9-condition-register)
10. [Supported Enumerations](#10-supported-enumerations)
11. [Performance Instrumentation](#11-performance-instrumentation)
12. [API Reference](#12-api-reference)

---

## 1. Design Philosophy

Check nodes are the **branching primitives** of the ForgeVM. Every check writes a boolean result into `Context.bLastConditionResult`, which downstream flow-control instructions (`OP_Branch`, `OP_WhileLoop`, system conditional jumps) consume to decide execution paths.

| Decision | Rationale |
|----------|-----------|
| **Synchronous only** | Checks are condition evaluations — they must return immediately so the VM never suspends on a branch |
| **Read-only context** | Checks observe state but do not mutate it (actions handle mutations) |
| **Single result register** | `bLastConditionResult` — one bool, consumed by the next flow instruction |
| **ForgeParam injection** | User-defined UPROPERTY fields on custom check subclasses are auto-populated from compiled instruction data |
| **Built-in + extensible** | 9 built-in check opcodes + unlimited user-defined checks via `UForgeCustomCheck` subclassing |

---

## 2. Class Hierarchy

```
UObject
  └── UForgeCustomLogicBase         (Abstract — shared base for Checks and Actions)
        │
        ├── UForgeCustomCheck       (Abstract — synchronous condition check)
        │     └── User subclasses   (Blueprint or C++)
        │
        └── UForgeCustomAction      (Abstract — async action, documented separately)
```

Both Checks and Actions inherit the same context setup, variable access, ForgeParam injection, and lifecycle hooks from `UForgeCustomLogicBase`. The key difference: Checks are **synchronous** and **read-only**; Actions may be **asynchronous** and **mutable**.

---

## 3. UForgeCustomLogicBase

```
Header  : Public/CustomLogics/ForgeCustomLogicBase.h
Source  : Private/CustomLogics/ForgeCustomLogicBase.cpp
```

```cpp
UCLASS(Abstract, BlueprintType, Blueprintable)
class STATS_X_API UForgeCustomLogicBase : public UObject
```

### 3.1 Context Data

| Field | Type | Description |
|-------|------|-------------|
| `StatusID` | `int64` | StatusID of current execution (0 for inline) |
| `StatusInstance` | `FStatusInstance*` | Active instance pointer (nullptr for inline) |
| `Definition` | `const UPDA_StatusDefinition*` | The status definition being executed (`UPROPERTY(Transient)`) |
| `CasterActor` | `TWeakObjectPtr<AActor>` | Actor that casted the status |
| `TargetActor` | `TWeakObjectPtr<AActor>` | Actor that receives the status |
| `CasterComponent` | `TWeakObjectPtr<UStatsX_StatsComponentBase>` | Caster's StatsComponent |
| `TargetComponent` | `TWeakObjectPtr<UStatsX_StatsComponentBase>` | Target's StatsComponent |
| `bIsActive` | `uint8 : 1` | True while execution is in progress |
| `bIsCancelled` | `uint8 : 1` | True if Cancel() was called |

### 3.2 Context Setup (System-Called)

```cpp
void SetupContext(FForgeVMContext& Context);
```

Copies all relevant pointers from the VM context into the logic object's cached fields. Called by the handler **before** `Execute()`.

```cpp
void ClearContext();
```

Resets all context fields to null/zero. Called by the handler **after** `Cleanup()`.

### 3.3 Lifecycle Hooks

| Method | Default | Purpose |
|--------|---------|---------|
| `Cancel()` | Sets `bIsCancelled = true` | Called when the status is terminated externally while logic is active |
| `Cleanup()` | No-op | Called after execution completes; override to release resources |

Both are `BlueprintNativeEvent` — overridable in Blueprint or C++.

### 3.4 Context Accessors (BlueprintPure)

| Function | Return | Description |
|----------|--------|-------------|
| `GetCasterActor()` | `AActor*` | Actor that casted the status |
| `GetTargetActor()` | `AActor*` | Target actor |
| `GetCasterComponent()` | `UStatsX_StatsComponentBase*` | Caster's component |
| `GetTargetComponent()` | `UStatsX_StatsComponentBase*` | Target's component |
| `GetDefinition()` | `const UPDA_StatusDefinition*` | The status definition |
| `GetStatusID()` | `int64` | StatusID (0 if inline) |
| `GetStatusInstance()` | `FStatusInstance*` | Raw instance pointer (not exposed to BP) |

---

## 4. UForgeCustomCheck

```
Header  : Public/CustomLogics/ForgeCustomCheck.h
Source  : Private/CustomLogics/ForgeCustomCheck.cpp
```

```cpp
UCLASS(Abstract, BlueprintType, Blueprintable, meta = (DisplayName = "Custom Check"))
class STATS_X_API UForgeCustomCheck : public UForgeCustomLogicBase
```

### 4.1 Override Point

```cpp
UFUNCTION(BlueprintNativeEvent, Category = "ForgeCustomLogic|Execution")
bool Execute();
virtual bool Execute_Implementation();  // Default: return true
```

Override `Execute()` to implement custom condition logic. Return `true` if the condition passes, `false` otherwise.

### 4.2 Design Constraints

| Constraint | Detail |
|------------|--------|
| **Synchronous** | Blocks the VM until `Execute()` returns — no suspend/resume |
| **Read-only** | Should not modify execution state (attribute changes, status casts, etc.) |
| **No loop support** | Single execution per node invocation |
| **Short-lived** | Created via `NewObject`, used once, then cleaned up — GC reclaims |

### 4.3 Usage Example (C++)

```cpp
UCLASS()
class UCheck_HasTag : public UForgeCustomCheck
{
    GENERATED_BODY()
public:
    virtual bool Execute_Implementation() override
    {
        return GetTargetComponent()->HasReceivedStatus(TagToCheck);
    }

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    FGameplayTag TagToCheck;
};
```

The `TagToCheck` property is automatically injected from the compiled instruction data via ForgeParam injection (see Section 6).

---

## 5. OP_CustomCheck Handler

```
Source  : Private/Nodes/Nodes_Core.cpp (Nodes_CustomLogic namespace)
OpCode  : 257
```

### 5.1 Instruction Layout

```
Data0[24-39]:  Pool_Classes index (16 bits) — UForgeCustomCheck subclass
Data0[42+]:    ForgeParam fields (18 bits each, sequentially packed)
               Continuation instructions used when params overflow Data0/Data1
```

### 5.2 Execution Sequence

```
ExecuteCustomCheck(Context, Instr)
│
├─ 1. Save FallthroughPC = Context.PC
│
├─ 2. Extract ClassIndex from Instr.Data0[24..39]
│
├─ 3. Validate: Definition exists, Pool_Classes[ClassIndex] is valid
│     └─ Error if index out of bounds
│
├─ 4. Get UClass* from Pool_Classes, verify IsChildOf(UForgeCustomCheck)
│     └─ Error if wrong class hierarchy
│
├─ 5. NewObject<UForgeCustomCheck>(GetTransientPackage(), CheckClass)
│     └─ Error if instantiation fails
│
├─ 6. Check->SetupContext(Context)
│     └─ Copies caster, target, definition, statusID into check
│
├─ 7. Check->InjectForgeParams(Context, Instr, 42)
│     └─ Populates UPROPERTY fields from instruction data starting at bit 42
│
├─ 8. bResult = Check->Execute()
│     └─ Calls the user-overridden condition logic
│
├─ 9. Context.bLastConditionResult = bResult
│     └─ Stores in VM condition register
│
├─ 10. Check->Cleanup(), Check->ClearContext()
│      └─ Release context references, GC handles the UObject
│
├─ 11. SkipInstructionContinuationSlotsIfFallthrough(Context, Instr, FallthroughPC)
│      └─ Advance PC past continuation instructions if not branched
│
└─ return EForgeExecutionResult::Continue
```

### 5.3 Key Implementation Details

- **Transient outer:** `NewObject` is outed to `GetTransientPackage()` — the check object has no persistent owner and will be GC'd.
- **ForgeParam start bit = 42:** The first 42 bits of Data0 are reserved (16 OpCode + 2 reserved + 24 for ClassIndex). ForgeParams begin at bit 42.
- **Continuation skip:** If the instruction has continuation slots (for checks with many ForgeParams), the PC is advanced past them after execution.

---

## 6. ForgeParam Injection

```cpp
void InjectForgeParams(FForgeVMContext& Context, const FStatusInstruction& Instr, uint8 FirstParamBit);
```

### 6.1 Property Discovery

At runtime, `InjectForgeParams` iterates the **concrete class only** (`EFieldIteratorFlags::ExcludeSuper`) to find eligible properties:

| Requirement | Flag Check |
|-------------|------------|
| Editable | `CPF_Edit` |
| Blueprint-visible | `CPF_BlueprintVisible` |
| Instance-editable | NOT `CPF_DisableEditOnInstance` |
| Not transient/deprecated | NOT `CPF_Transient`, NOT `CPF_Deprecated` |
| Supported type | `IsSupportedCustomLogicParamProperty()` |

### 6.2 Supported Property Types

| Category | Types |
|----------|-------|
| **Numeric** | `float`, `double` (promoted from float), `int32`, `int64`, `uint8`, `bool` |
| **Enum** | `FEnumProperty` (stored as `uint8` underneath) |
| **String** | `FName`, `FString`, `FText` (from FString) |
| **Object** | `UObject*`, `UClass*` |
| **Struct** | `FVector`, `FRotator`, `FTransform`, `FLinearColor` (from FVector RGB), `FGameplayTag`, `FGameplayTagContainer` |

### 6.3 Bit Packing

Each ForgeParam occupies **18 bits**: 2-bit source + 16-bit payload, matching the standard data operand encoding:

```
┌──────────────────────── 18 bits per ForgeParam ─────────────────────────┐
│  Source (2 bits)  │  Payload (16 bits: pool index / inline value)       │
└───────────────────┴─────────────────────────────────────────────────────┘
```

Parameters are packed sequentially starting from `FirstParamBit`. When the current 64-bit data slot runs out of space (`CurrentBit + 18 > 64`), the system advances to the next slot:

| DataSlot | Source |
|----------|--------|
| 0 | `Instr.Data0` |
| 1 | `Instr.Data1` |
| 2, 3 | Continuation instruction 1 (Data0, Data1) |
| 4, 5 | Continuation instruction 2 (Data0, Data1) |
| ... | Up to 7 continuation instructions |

### 6.4 Value Reading

Each property type is read via `Context.ReadValue<T>(Instr, DataSlot, BitOffset)`, which resolves the 2-bit source tag and reads from the appropriate pool:

```cpp
// Example for a float property
if (FFloatProperty* FloatProp = CastField<FFloatProperty>(Prop))
{
    float Value = Context.ReadValue<float>(*ReadInstr, LocalDataSlot, CurrentBit);
    FloatProp->SetPropertyValue_InContainer(this, Value);
}
```

### 6.5 Special Cases

| Type | Handling |
|------|----------|
| `double` | Read as `float`, promoted via `static_cast<double>` |
| `FText` | Read as `FString`, wrapped via `FText::FromString()` |
| `FLinearColor` | Read as `FVector` (RGB), alpha set to 1.0f |
| Enum | Underlying numeric property receives `static_cast<int64>(uint8_value)` |

---

## 7. Variable Accessors

Custom logic nodes can read and write **status variables** via the `ForgeVariableAccess` helper. The variable blob is resolved from `StatusInstance->VariableBlob`.

### 7.1 Read Path

```cpp
float UForgeCustomLogicBase::GetVariableFloat(FGameplayTag VariableTag, bool& bFound) const
{
    float Value = 0.f;
    if (!Definition) { bFound = false; return Value; }
    const TArray<uint8>& Blob = StatusInstance ? StatusInstance->VariableBlob : TArray<uint8>();
    if (Blob.Num() == 0) { bFound = false; return Value; }
    bFound = ForgeVariableAccess::ReadVariable<float>(
        Definition, Blob, VariableTag, ForgeFieldTypes::Float, Value);
    return Value;
}
```

### 7.2 Write Path

Write operations require a valid `StatusInstance` (no inline execution):

```cpp
bool UForgeCustomLogicBase::SetVariableFloat(FGameplayTag VariableTag, float Value)
{
    if (!Definition || !StatusInstance) return false;
    return ForgeVariableAccess::WriteVariable<float>(
        Definition, StatusInstance->VariableBlob, VariableTag, ForgeFieldTypes::Float, Value);
}
```

### 7.3 Object Variable Indirection

Objects are stored as `uint16` pool indices in the variable blob:

- **Read:** Resolves from `StatusInstance->InstanceObjectPool[ObjectIndex]`
- **Write:** Allocates via `StatusInstance->AllocObject(Value)` (with dedup + overflow guard), then writes the index

### 7.4 Blueprint API

All variable accessors use `meta = (Categories = "StatsX.Variable")` for filtered tag picker.

| Getters (BlueprintPure) | Setters (BlueprintCallable) |
|--------------------------|----------------------------|
| `GetVariableFloat` → `float` | `SetVariableFloat(float)` → `bool` |
| `GetVariableInt` → `int32` | `SetVariableInt(int32)` → `bool` |
| `GetVariableBool` → `bool` | `SetVariableBool(bool)` → `bool` |
| `GetVariableTag` → `FGameplayTag` | `SetVariableTag(FGameplayTag)` → `bool` |
| `GetVariableVector` → `FVector` | `SetVariableVector(FVector)` → `bool` |
| `GetVariableObject` → `UObject*` | `SetVariableObject(UObject*)` → `bool` |

---

## 8. Built-in Check Nodes

All built-in checks are registered in `RegisterCoreNodes()` and follow the same pattern: read inputs from instruction data, evaluate condition, write result to `Context.bLastConditionResult`.

### 8.1 OP_CheckChance (267)

**Purpose:** Random probability check.

```
Data0[24]: Chance (inline float, 0.0–1.0)
```

```cpp
const float RandomRoll = FMath::FRandRange(0.0f, 1.0f);
Context.bLastConditionResult = (RandomRoll <= Chance);
```

| Input | Type | Description |
|-------|------|-------------|
| Chance | `float` (inline) | Probability threshold (0.0 = never, 1.0 = always) |

---

### 8.2 OP_CompareFloats (268)

**Purpose:** Compare two float values.

```
Data0[24]: Float A (inline float)
Data1[0]:  Float B (inline float)
Data1[34]: Comparison method (uint8 → EComparationMethod)
```

| Input | Type | Description |
|-------|------|-------------|
| A | `float` (inline) | Left operand |
| B | `float` (inline) | Right operand |
| Method | `EComparationMethod` | `<`, `>`, `<=`, `>=`, `==`, `!=` |

---

### 8.3 OP_CompareIntegers (273)

**Purpose:** Compare two integer values.

```
Data0[24]: Int A (inline int32)
Data1[0]:  Int B (inline int32)
Data1[34]: Comparison method (uint8 → EComparationMethod)
```

Identical logic to CompareFloats but with `int32` operands.

---

### 8.4 OP_CheckCost (258)

**Purpose:** Check if an attribute has sufficient value for a cost operation.

```
Data0[24-41]: Stats Component (18-bit data operand → UObject*)
Data0[42-59]: Attribute Tag (18-bit → FGameplayTag)
Data1[0-17]:  Sub-Attribute Tag (18-bit → FGameplayTag: Current/Max/Base)
Data1[18]:    Cost Value (inline float)
```

**Logic:**

```
if (!Attribute.bOverflows)
    result = (AttributeValue + CostValue) >= 0 AND
             (AttributeValue + CostValue) <= Attribute.Max
else
    result = true   // Overflow-allowed attributes always pass
```

The cost value is typically negative (e.g., -50 mana). The check verifies the result stays within `[0, Max]`.

| Input | Type | Description |
|-------|------|-------------|
| Component | `UObject*` (data operand) | Target StatsComponent (or IStatsXComponentProvider) |
| AttributeTag | `FGameplayTag` | Which attribute to check |
| SubAttributeTag | `FGameplayTag` | Which sub-attribute (Current, Max, Base) |
| CostValue | `float` (inline) | Delta to apply (typically negative) |

---

### 8.5 OP_CheckTags (266)

**Purpose:** Query gameplay tags on a component's status tracking containers.

```
Data0[24-41]: Stats Component (18-bit → UObject*)
Data0[42-59]: Container To Check (18-bit → FGameplayTag: CastedStatuses/ReceivedStatuses)
Data1[0-17]:  Query Method (18-bit → EQueryMethod)
Data1[18-35]: Literal Tag Container (18-bit → FGameplayTagContainer via ArrayHeader)
Data1[36-53]: Literal Tag (18-bit → FGameplayTag)
```

**Supported containers:** `StatsX_ContainerType_CastedStatuses`, `StatsX_ContainerType_ReceivedStatuses`

**Query methods and their resolution:**

| Method | Single Tag | Container |
|--------|------------|-----------|
| `HasTag` | `HasCastedStatus(Tag)` / `HasReceivedStatus(Tag)` | — |
| `HasTagExact` | `HasExactCastedStatus(Tag)` / `HasExactReceivedStatus(Tag)` | — |
| `HasAny` | — | `HasAnyCastedStatus(Container)` / `HasAnyReceivedStatus(Container)` |
| `HasAnyExact` | — | `CastedStatusesContainer.HasAnyExact(Container)` |
| `HasAll` | — | `HasAllCastedStatus(Container)` / `HasAllReceivedStatus(Container)` |
| `HasAllExact` | — | `CastedStatusesContainer.HasAllExact(Container)` |
| `HasNone` | — | `!HasAllCastedStatus(Container)` |
| `HasNoneExact` | — | `!CastedStatusesContainer.HasAllExact(Container)` |

---

### 8.6 OP_CheckAttributeRequirement (265)

**Purpose:** Compare an attribute's sub-value against a threshold.

```
Data0[24-41]: Stats Component (18-bit → UObject*)
Data0[42-59]: Attribute Tag (18-bit → FGameplayTag)
Data1[0-17]:  Sub-Attribute Tag (18-bit → FGameplayTag: Current/Max/Base)
Data1[18-35]: Comparison Method (18-bit → EComparationMethod)
Data1[36-53]: Compare Value (18-bit → float)
```

**Logic:**

```cpp
float AttributeValue = StatsComponent->GetSubAttributeValue(AttributeTag, SubAttributeTag);
// Then apply comparison: AttributeValue <method> CompareValue
```

| Input | Type | Description |
|-------|------|-------------|
| Component | `UObject*` | Target StatsComponent |
| AttributeTag | `FGameplayTag` | Which attribute |
| SubAttributeTag | `FGameplayTag` | Current, Max, or Base |
| Method | `EComparationMethod` | Comparison operator |
| CompareValue | `float` | Threshold value |

---

### 8.7 OP_Branch (311)

**Purpose:** Route execution based on an input boolean value.

```
Data0[24-41]: Condition (18-bit data operand → bool)
```

Reads a boolean from any data source and stores it directly in `bLastConditionResult`. Used as a generic "value-to-condition" bridge.

---

### 8.8 OP_IsValid (317)

**Purpose:** Check if an object reference is valid.

```
Data0[24-41]: Object (18-bit data operand → UObject*)
```

```cpp
Context.bLastConditionResult = (Obj != nullptr && ::IsValid(Obj));
```

Performs both null check and UObject validity check (not pending kill).

---

### 8.9 Component Resolution Pattern

All component-accepting checks (`CheckCost`, `CheckTags`, `CheckAttributeRequirement`) share a common resolution pattern:

```
Read UObject* from data operand
│
├─ nullptr → Error
├─ == Context.CasterComponent → use directly
├─ == Context.TargetComponent → use directly
└─ else → Cast<IStatsXComponentProvider> → GetStatsComponent()
          └─ fails → Error
```

This enables checks to operate on any object that implements `IStatsXComponentProvider`, not just direct component references.

---

## 9. Condition Register

```cpp
// In FForgeVMContext:
bool bLastConditionResult;
```

**Every** check node writes to this single boolean register. The flow control system reads it to decide branching:

| Consumer | Behavior |
|----------|----------|
| System conditional jump | If `bLastConditionResult == true`, follow True branch PC; else follow False branch PC |
| `OP_WhileLoop` | Continue looping while `bLastConditionResult == true` |
| `OP_Gate` | May check condition to decide open/close state |
| Subsequent checks | Overwrite — only the last check before a branch matters |

**Important:** The condition register is **global** within the execution context. There is no stack of conditions — each check overwrites the previous result.

---

## 10. Supported Enumerations

### EComparationMethod

```cpp
UENUM(BlueprintType)
enum class EComparationMethod : uint8
{
    LessThan        UMETA(DisplayName = "<"),
    GreaterThan     UMETA(DisplayName = ">"),
    LessOrEqual     UMETA(DisplayName = "<="),
    GreaterOrEqual  UMETA(DisplayName = ">="),
    Equal           UMETA(DisplayName = "=="),
    Different       UMETA(DisplayName = "!=")
};
```

Used by: `OP_CompareFloats`, `OP_CompareIntegers`, `OP_CheckAttributeRequirement`.

### EQueryMethod

```cpp
UENUM(BlueprintType)
enum class EQueryMethod : uint8
{
    HasTag,
    HasAny,
    HasAll,
    HasNone,
    HasTagExact,
    HasAnyExact,
    HasAllExact,
    HasNoneExact
};
```

Used by: `OP_CheckTags`.

---

## 11. Performance Instrumentation

| Stat Name | Scope |
|-----------|-------|
| `StatsX.CustomLogic.SetupContext` | Context injection into logic object |
| `StatsX.CustomLogic.ClearContext` | Context cleanup |
| `StatsX.CustomLogic.InjectForgeParams` | Property discovery and value injection |
| `StatsX.CustomLogic.ExecuteCheck` | Full OP_CustomCheck handler |

---

## 12. API Reference

### UForgeCustomLogicBase (Base)

| Category | Method | Signature |
|----------|--------|-----------|
| **Context** | `GetCasterActor` | `AActor* GetCasterActor() const` |
| **Context** | `GetTargetActor` | `AActor* GetTargetActor() const` |
| **Context** | `GetCasterComponent` | `UStatsX_StatsComponentBase* GetCasterComponent() const` |
| **Context** | `GetTargetComponent` | `UStatsX_StatsComponentBase* GetTargetComponent() const` |
| **Context** | `GetDefinition` | `const UPDA_StatusDefinition* GetDefinition() const` |
| **Context** | `GetStatusID` | `int64 GetStatusID() const` |
| **Context** | `GetStatusInstance` | `FStatusInstance* GetStatusInstance() const` |
| **Lifecycle** | `Cancel` | `void Cancel()` — BlueprintNativeEvent |
| **Lifecycle** | `Cleanup` | `void Cleanup()` — BlueprintNativeEvent |
| **System** | `SetupContext` | `void SetupContext(FForgeVMContext&)` |
| **System** | `InjectForgeParams` | `void InjectForgeParams(FForgeVMContext&, const FStatusInstruction&, uint8 FirstParamBit)` |
| **System** | `ClearContext` | `void ClearContext()` |
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

### UForgeCustomCheck

| Method | Signature |
|--------|-----------|
| `Execute` | `bool Execute()` — BlueprintNativeEvent, return `true` if condition passes |

### Built-in Check Handlers (registered in ForgeVM)

| OpCode | Name | Handler Namespace |
|--------|------|-------------------|
| 257 | `OP_CustomCheck` | `Nodes_CustomLogic::ExecuteCustomCheck` |
| 258 | `OP_CheckCost` | `Nodes_Check::CheckCost` |
| 265 | `OP_CheckAttributeRequirement` | `Nodes_Check::CheckAttributeRequirement` |
| 266 | `OP_CheckTags` | `Nodes_Check::CheckTags` |
| 267 | `OP_CheckChance` | `Nodes_Check::CheckChance` |
| 268 | `OP_CompareFloats` | `Nodes_Check::CompareFloats` |
| 273 | `OP_CompareIntegers` | `Nodes_Check::CompareIntegers` |
| 311 | `OP_Branch` | `Nodes_Check::Branch` |
| 317 | `OP_IsValid` | `Nodes_Check::IsValid` |

---

*Document generated from source — Stats_X v1.404*
