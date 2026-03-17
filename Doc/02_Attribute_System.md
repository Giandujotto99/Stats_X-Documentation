# Attribute System

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Table of Contents

1. [Overview](#overview)
2. [Core Concept: The Value Triplet](#core-concept-the-value-triplet)
3. [Attribute Categories](#attribute-categories)
4. [FStatAttribute Struct](#fstatattribute-struct)
5. [Sub-Attributes](#sub-attributes)
6. [Clamping & Overflow](#clamping--overflow)
7. [Modifier Integration](#modifier-integration)
8. [Initialization API](#initialization-api)
9. [Modification API](#modification-api)
10. [Query API](#query-api)
11. [Threshold System](#threshold-system)
12. [Replication](#replication)
13. [Events & Delegates](#events--delegates)
14. [Damage Mitigation Integration](#damage-mitigation-integration)
15. [VM Interaction](#vm-interaction)
16. [Operator Overloads](#operator-overloads)
17. [Best Practices](#best-practices)

---

## Overview

Every gameplay-relevant value in Stats_X is an **Attribute** — a tag-identified value triplet stored in `UStatsX_StatsComponentBase`. Attributes represent anything from player health and mana to movement speed, armor, or arbitrary storage values.

The system is built on three pillars:

| Pillar | Description |
|---|---|
| **Tag-driven identity** | Every attribute is identified by a `FGameplayTag` under `StatsX.Attribute.*`, enabling data-driven design with zero hard-coded references |
| **Triplet structure** | Each attribute holds three floats (`Current`, `Max`, `Base`) plus behavior flags, covering both resource-type and stat-type use cases in a single struct |
| **Modifier-aware Max** | The `Max` value is recalculated from `Base` + modifiers whenever the modifier stack changes, keeping the separation between base stats and runtime buffs/debuffs |

---

## Core Concept: The Value Triplet

Every attribute stores three numeric values and two behavioral flags:

```
┌─────────────────────────────────────────────────────┐
│                   FStatAttribute                     │
├─────────────────────────────────────────────────────┤
│  Current  : float   (the live, usable value)        │
│  Max      : float   (upper bound, modifier-derived) │
│  Base     : float   (innate value, level/design)    │
│  bOverflows  : bool (disable all clamping)          │
│  bReplicated : bool (network sync flag)             │
└─────────────────────────────────────────────────────┘
```

**Relationship between values:**

```
Base ──┐
       ├── Modifiers applied ──► Max = (Base + ΣAdditive) × ΠMultiplicative
       │
Current ──── clamped to [0, Max] (unless bOverflows = true)
```

### Example: Health Attribute

```
Base = 100       (innate HP from character level)
Modifiers:       +50 Additive (armor buff), ×1.2 Multiplicative (vitality perk)
Max = (100 + 50) × 1.2 = 180
Current = 180    (full health)

After taking 60 damage:
Current = 120    (clamped to [0, 180])
```

---

## Attribute Categories

Stats_X defines two semantic categories under the `StatsX.Attribute` tag hierarchy. Both use the same `FStatAttribute` struct — the difference is purely semantic and affects editor UI filtering.

### Resource Attributes (`StatsX.Attribute.Resource`)

Resources have **independent** `Current` and `Max` values. `Current` changes frequently during gameplay while `Max` is driven by modifiers.

| Example | Current | Max | Base |
|---|---|---|---|
| Health | 85.0 | 200.0 | 100.0 |
| Mana | 30.0 | 150.0 | 80.0 |
| Stamina | 100.0 | 100.0 | 100.0 |

### Stat Attributes (`StatsX.Attribute.Stat`)

Stats use `Current == Max` at initialization. The value represents a magnitude rather than a consumable pool.

| Example | Current / Max | Base |
|---|---|---|
| MoveSpeed | 600.0 | 600.0 |
| Armor | 45.0 | 25.0 |
| CritChance | 0.15 | 0.05 |

> **Note:** The runtime makes no distinction between Resource and Stat attributes. The separate initialization functions (`InitializeResourceAttribute` / `InitializeStatAttribute`) are convenience methods that differ only in their parameter signatures and editor tag filtering.

---

## FStatAttribute Struct

**Source:** `Data/StatsXTypes.h`

```cpp
USTRUCT(BlueprintType)
struct STATS_X_API FStatAttribute
{
    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    float Current = 0.f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    float Max = 0.f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    float Base = 0.f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    bool bOverflows = false;

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    bool bReplicated = true;
};
```

### Constructors

| Signature | Usage |
|---|---|
| `FStatAttribute()` | Default: all zeros, clamped, replicated |
| `FStatAttribute(float Current, float Max, float Base, bool bOverflows = false, bool bReplicated = true)` | Full parameterized |
| `explicit FStatAttribute(float Value)` | Convenience: sets Current = Max = Base = Value, clamped, replicated |

---

## Sub-Attributes

Each attribute's individual values are addressed through **Sub-Attribute tags**:

| Sub-Attribute Tag | Field | Description |
|---|---|---|
| `StatsX.SubAttribute.Current` | `Current` | The live, consumable value |
| `StatsX.SubAttribute.Max` | `Max` | The modifier-derived upper bound |
| `StatsX.SubAttribute.Base` | `Base` | The innate foundation value |
| `StatsX.SubAttribute.Overflows` | `bOverflows` | Clamping behavior flag |
| `StatsX.SubAttribute.Replicated` | `bReplicated` | Network replication flag |

Sub-Attribute tags are used in both the C++/Blueprint API and in VM instructions to specify which part of an attribute to read or write.

---

## Clamping & Overflow

### Standard Mode (`bOverflows = false`)

All clamping rules are enforced automatically:

| Field | Clamping Rule |
|---|---|
| `Current` | Clamped to `[0, Max]` |
| `Max` | Clamped to `[0, +∞)` |
| `Base` | Clamped to `[0, +∞)` |

Clamping cascades: setting a new `Max` that is lower than `Current` will also re-clamp `Current`.

```
SetMax(50.0)  →  Max = 50.0
                 Current = min(Current, 50.0)
```

### Overflow Mode (`bOverflows = true`)

**All constraints are disabled.** Values can be negative, exceed limits, or take any float value. This mode is designed for:

- Arbitrary storage (e.g., world positions, timer accumulators)
- Signed values (e.g., temperature that can go below zero)
- Uncapped stats (e.g., a damage multiplier with no upper bound)

### Mode Transition

When switching from overflow to standard mode via `SetOverflows(false)`, all values are immediately re-clamped:

```cpp
void SetOverflows(bool InOverflows)
{
    bOverflows = InOverflows;
    if (!bOverflows) { ClampAll(); }  // Base → Max → Current
}
```

---

## Modifier Integration

Modifiers affect **only the Max value** of an attribute. The recalculation formula is:

```
Max = (Base + ΣAdditiveValue) × ΠMultiplicativeValue
```

Where:
- `ΣAdditiveValue` = sum of all `FStatModifier.AdditiveValue` for this attribute
- `ΠMultiplicativeValue` = product of all `FStatModifier.MultiplicativeValue` for this attribute

### Recalculation Flow

```
AddModifier() / RemoveModifier*()
  │
  ├─ MarkAttributeDirty(AttributeTag)
  │    └─ Adds tag to DirtyAttributes set
  │
  └─ RecalculateAllDirtyAttributes()    [called automatically]
       └─ For each dirty attribute:
            ├─ Compute ΣAdditive, ΠMultiplicative from all modifiers
            ├─ Max = (Base + ΣAdditive) × ΠMultiplicative
            ├─ ClampMax() → ClampCurrent()
            ├─ UpdateReplicatedAttribute()
            ├─ BroadcastAttributeChange()
            └─ CheckAttributeThresholds()
```

> **Important:** Modifiers never touch `Current` or `Base` directly. If a modifier is removed and `Max` drops below `Current`, the system re-clamps `Current` automatically.

---

## Initialization API

All initialization methods are `BlueprintCallable` and available on `UStatsX_StatsComponentBase`.

### InitializeAttribute

The generic initializer for any attribute type, including overflow attributes.

```cpp
void InitializeAttribute(
    FGameplayTag AttributeTag,     // e.g., StatsX.Attribute.Resource.Health
    float CurrentValue,            // Initial current value
    float MaxValue,                // Initial max value
    float BaseValue,               // Initial base value
    bool bOverflows,               // Enable overflow mode
    bool bOverwriteExisting,       // Overwrite if already initialized
    bool bReplicated = true);      // Enable replication
```

### InitializeResourceAttribute

Convenience wrapper with editor tag filtering to `StatsX.Attribute.Resource.*`.

```cpp
void InitializeResourceAttribute(
    FGameplayTag AttributeTag,     // Filtered to StatsX.Attribute.Resource.*
    float CurrentValue,
    float MaxValue,
    float BaseValue,
    bool bOverflows,
    bool bOverwriteExisting,
    bool bReplicated = true);
```

### InitializeStatAttribute

Convenience wrapper for stat-type attributes where `Current == Max`.

```cpp
void InitializeStatAttribute(
    FGameplayTag AttributeTag,     // Filtered to StatsX.Attribute.Stat.*
    float Value,                   // Sets both Current and Max
    float BaseValue,
    bool bOverflows,
    bool bOverwriteExisting,
    bool bReplicated = true);
```

### RemoveAttribute

Removes an attribute from the component entirely.

```cpp
void RemoveAttribute(FGameplayTag AttributeTag);
```

---

## Modification API

### Modify Operations

The `EAttributeModifyOp` enum defines six modification operations:

| Operation | Symbol | Formula | Description |
|---|---|---|---|
| `Set` | `=` | `Value = Delta` | Absolute set |
| `Transaction` | `+` | `Value += Delta` | Additive change (positive or negative) |
| `Multiply` | `×` | `Value *= Delta` | Multiplicative scaling |
| `Divide` | `÷` | `Value /= Delta` | Division |
| `Min` | `min` | `Value = min(Value, Delta)` | Floor clamp |
| `Max` | `max` | `Value = max(Value, Delta)` | Ceiling clamp |

### ModifyAttribute

Applies a delta to a specific sub-attribute using the `Transaction` operation.

```cpp
float ModifyAttribute(
    FGameplayTag AttributeTag,      // Which attribute
    FGameplayTag SubAttributeTag,   // Which sub-attribute (Current, Max, Base)
    float Delta,                    // Amount to add (positive or negative)
    AActor* Causer = nullptr);      // Optional causer for threshold callbacks
```

**Returns:** The new value of the modified sub-attribute.

**Side effects:**
1. Automatic clamping applied (unless overflow mode)
2. Replication triggered (if `bReplicated = true`)
3. `OnAttributeChanged` delegate broadcast
4. Threshold checks evaluated

### SetAttribute

Overwrites a sub-attribute value directly.

```cpp
void SetAttribute(
    FGameplayTag AttributeTag,
    FGameplayTag SubAttributeTag,
    float NewValue,
    AActor* Causer = nullptr);
```

### SetEnableOverflows / SetEnableReplicated

Runtime toggles for attribute behavior flags:

```cpp
void SetEnableOverflows(FGameplayTag AttributeTag, bool bOverflowsEnabled);
void SetEnableReplicated(FGameplayTag AttributeTag, bool bReplicated);
```

---

## Query API

| Method | Return Type | Description |
|---|---|---|
| `GetAttributeValue(Tag)` | `FStatAttribute` | Full triplet struct |
| `GetSubAttributeValue(Tag, SubTag)` | `float` | Single sub-attribute value |
| `HasAttribute(Tag)` | `bool` | O(1) existence check |

### Example (Blueprint)

```
// Get current health
float HP = Component->GetSubAttributeValue(
    StatsX.Attribute.Resource.Health,
    StatsX.SubAttribute.Current);

// Get full attribute data
FStatAttribute HealthData = Component->GetAttributeValue(
    StatsX.Attribute.Resource.Health);

float Percent = HealthData.GetPercent();   // Current / Max (0.0 - 1.0)
float Missing = HealthData.GetMissing();   // Max - Current
bool bFull    = HealthData.IsFull();       // Current >= Max
bool bEmpty   = HealthData.IsEmpty();      // Current <= 0
bool bDepleted = HealthData.IsDepleted();  // Alias for IsEmpty()
```

---

## Threshold System

Thresholds are **attribute monitors** that fire a delegate when a sub-attribute value crosses a specified boundary. They run automatically after every attribute modification.

### FAttributeThreshold

```cpp
USTRUCT(BlueprintType)
struct FAttributeThreshold
{
    FGameplayTag AttributeTag;       // Which attribute to monitor
    FGameplayTag SubAttributeTag;    // Which sub-attribute (default: Current)
    float ThresholdValue;            // The boundary value
    EThresholdComparison Comparison; // How to compare
    bool bRemoveAfterTrigger;        // One-shot or persistent
};
```

### Comparison Modes

| Mode | Triggers When |
|---|---|
| `LessOrEqual` | `NewValue <= ThresholdValue` |
| `GreaterOrEqual` | `NewValue >= ThresholdValue` |
| `CrossingBelow` | `OldValue > ThresholdValue && NewValue <= ThresholdValue` |
| `CrossingAbove` | `OldValue < ThresholdValue && NewValue >= ThresholdValue` |

### API

```cpp
// Register a threshold, returns handle for removal
int32 AddAttributeThreshold(const FAttributeThreshold& Threshold);

// Remove by handle
bool RemoveAttributeThreshold(int32 Handle);

// Bulk removal
void ClearAllThresholds();
void ClearThresholdsForAttribute(FGameplayTag AttributeTag);

// Quick check for early-exit optimization
bool HasActiveThresholds() const;
```

### Evaluation Flow

```
ModifyAttribute() or SetAttribute()
  │
  └─ CheckAttributeThresholds(AttributeTag, SubAttributeTag, OldValue, NewValue, Causer)
       │
       └─ For each threshold matching AttributeTag:
            ├─ Evaluate comparison against (OldValue, NewValue)
            ├─ If triggered:
            │    ├─ Broadcast OnAttributeThresholdReached
            │    └─ If bRemoveAfterTrigger → auto-remove threshold
            └─ Continue to next
```

### Delegate Signature

```cpp
DECLARE_DYNAMIC_MULTICAST_DELEGATE_SixParams(FOnAttributeThresholdReached,
    FGameplayTag, AttributeTag,
    FGameplayTag, SubAttributeTag,
    float, OldValue,
    float, NewValue,
    int32, ThresholdHandle,
    AActor*, Causer);
```

### Use Cases

| Scenario | Configuration |
|---|---|
| Death trigger | `Health.Current`, `LessOrEqual`, Value = `0`, one-shot |
| Low health warning | `Health.Current`, `CrossingBelow`, Value = `20%` of Max, persistent |
| Level-up trigger | `Experience.Current`, `GreaterOrEqual`, Value = `NextLevelXP`, one-shot |
| Shield break | `Shield.Current`, `CrossingBelow`, Value = `0`, one-shot |

---

## Replication

### Storage

Attributes are stored locally in:

```cpp
TMap<FGameplayTag, FStatAttribute> StatsAttributes;
```

And replicated via:

```cpp
UPROPERTY(Replicated)
FReplicatedAttributeArray ReplicatedAttributes;  // FFastArraySerializer
```

### Sync Flow

```
Server: ModifyAttribute()
  ├─ Update StatsAttributes[Tag]
  ├─ UpdateReplicatedAttribute(Tag, NewValue)
  │    └─ Find or create item in ReplicatedAttributes
  │    └─ MarkItemDirty() → delta replication
  └─ Broadcast local delegate

Client: OnRep (FastArraySerializer callback)
  ├─ SynchronizeLocalAttributes()
  │    └─ Rebuild StatsAttributes from ReplicatedAttributes
  └─ BroadcastAttributeChange()
```

### Per-Attribute Replication Control

Each attribute has an independent `bReplicated` flag. When `false`, the attribute exists only on the authority side and is never sent to clients. This is useful for:

- Server-only internal tracking values
- Sensitive data that clients should not know
- Optimization: reducing bandwidth for non-essential attributes

```cpp
// Make attribute server-only
Component->SetEnableReplicated(StatsX.Attribute.InternalScore, false);
```

### Client Sync Retry

If a client receives replicated attributes before the component's `StatsAttributes` map is initialized (race condition during BeginPlay), the system schedules a retry:

- Up to **10 retry attempts** (`MaxSyncRetries`)
- Timer-based retry via `ScheduleSyncRetry()`

---

## Events & Delegates

### OnAttributeChanged

Fires after any attribute modification (server and client, post-replication).

```cpp
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnAttributeChanged,
    FGameplayTag, AttributeTag,
    FStatAttribute, NewValue);
```

**Binding (Blueprint):**
```
Component.OnAttributeChanged.AddDynamic(this, &MyClass::HandleAttributeChanged);
```

### OnAttributeThresholdReached

Fires when a monitored threshold boundary is crossed. See [Threshold System](#threshold-system).

### Broadcast Order

After any attribute modification, the system fires events in this order:

1. `UpdateReplicatedAttribute()` — queue for delta replication
2. `BroadcastAttributeChange()` — fire `OnAttributeChanged`
3. `CheckAttributeThresholds()` — evaluate and fire `OnAttributeThresholdReached`

---

## Damage Mitigation Integration

The component provides built-in damage mitigation support through a **DamageType → Resistance** mapping:

```cpp
// Map: DamageType tag → array of resistance attribute tags
TMap<FGameplayTag, FGameplayTagContainer> DamageToResistancesMap;
```

### Mitigation Formulas

Four built-in formulas are available, identified by tags:

| Formula Tag | Formula | Use Case |
|---|---|---|
| `StatsX.MitigationFormula.XFlat` | `Damage - Resistance` | Flat damage reduction |
| `StatsX.MitigationFormula.XPercentage` | `Damage × (1 - Resistance%)` | Percentage damage reduction |
| `StatsX.MitigationFormula.XDiminishing` | `Damage × ScaleFactor / (ScaleFactor + Resistance)` | Diminishing returns (LoL/Dota style) |
| `StatsX.MitigationFormula.XExponentialDecay` | `Damage × e^(-Resistance / ScaleFactor)` | Exponential decay |

### Scale Factors

Two per-component scale factors are available for advanced formulas:

```cpp
float DiminishingMitigationScaleFactor = 100.f;     // Used by Diminishing formula
float ExponentialDecayMitigationScaleFactor = 100.f; // Used by ExponentialDecay formula
```

> Detailed documentation of the mitigation system is covered in **[22 — Damage Mitigation](22_Damage_Mitigation.md)**.

---

## VM Interaction

The ForgeVM interacts with attributes through dedicated OpCodes. The VM reads and writes attribute values on Caster/Target components via the execution context.

### Key OpCodes

| OpCode | Description |
|---|---|
| `OP_ModifyAttribute` | Modify a sub-attribute value (with interceptors) |
| `OP_SetAttribute` | Set a sub-attribute to an absolute value |
| `OP_GetAttribute` | Read a sub-attribute value into the context stack |
| `OP_CheckAttribute` | Branch based on attribute comparison |
| `OP_AddModifier` | Add a modifier to an attribute |
| `OP_RemoveModifiers` | Remove modifiers by filter criteria |
| `OP_CheckCost` | Verify sufficient resource before execution |
| `OP_ApplyCost` | Deduct resource cost |

### Data Source for Attribute Operations

VM instructions reference attributes by tag index (16-bit index into the definition's tag literal pool). The target component is resolved from the `FForgeVMContext` based on a `ENodeLogicTarget` flag (`Caster` or `Target`).

---

## Operator Overloads

`FStatAttribute` supports component-wise arithmetic for batch operations:

| Operator | Behavior |
|---|---|
| `A + B` | Component-wise addition of Current, Max, Base. Overflow = `A.bOverflows \|\| B.bOverflows` |
| `A - B` | Component-wise subtraction. Same overflow propagation |
| `A += B` | In-place add with auto-clamp |
| `A -= B` | In-place subtract with auto-clamp |
| `A == B` | True if Current, Max, and Base all match |
| `A != B` | True if any value differs |

---

## Best Practices

### 1. Choose the Right Initialization Method

| Scenario | Method |
|---|---|
| Health, Mana, Stamina | `InitializeResourceAttribute()` — independent Current and Max |
| Speed, Armor, CritChance | `InitializeStatAttribute()` — Current mirrors Max |
| Timers, positions, uncapped values | `InitializeAttribute()` with `bOverflows = true` |

### 2. Prefer Transaction Over Set

Use `ModifyAttribute()` (Transaction) for gameplay changes. Use `SetAttribute()` only for absolute resets (respawn, initialization). Transaction preserves the existing value context and plays well with interceptors.

### 3. Use Thresholds Instead of Polling

Instead of checking `if (Health <= 0)` every frame, register a threshold:

```cpp
FAttributeThreshold DeathThreshold;
DeathThreshold.AttributeTag = HealthTag;
DeathThreshold.ThresholdValue = 0.f;
DeathThreshold.Comparison = EThresholdComparison::LessOrEqual;
DeathThreshold.bRemoveAfterTrigger = true;
Component->AddAttributeThreshold(DeathThreshold);
```

### 4. Control Replication Granularity

Mark non-essential attributes as `bReplicated = false` to reduce bandwidth:

```cpp
// Server-only analytics tracking
InitializeAttribute(InternalDPSTracker, 0, 0, 0, true, false, /*bReplicated*/ false);
```

### 5. Batch Modifier Operations

When applying multiple modifiers simultaneously (e.g., equipping a full gear set), the dirty flag system naturally batches recalculations. All modifiers are added, then `RecalculateAllDirtyAttributes()` processes them in a single pass.

### 6. Tag Hierarchy for Flexible Queries

Structure your attribute tags hierarchically:

```
StatsX.Attribute.Resource.Health
StatsX.Attribute.Resource.Mana
StatsX.Attribute.Resource.Stamina
StatsX.Attribute.Stat.MoveSpeed
StatsX.Attribute.Stat.Armor
StatsX.Attribute.Stat.CritChance
```

This enables broad queries (e.g., "has any Resource attribute") while keeping individual attributes addressable.
