# Modifier System

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Table of Contents

1. [Overview](#overview)
2. [FStatModifier Struct](#fstatmodifier-struct)
3. [Recalculation Formula](#recalculation-formula)
4. [Recalculation Behavior by Attribute Category](#recalculation-behavior-by-attribute-category)
5. [Identification Model](#identification-model)
6. [Application API](#application-api)
7. [Removal API](#removal-api)
8. [Filtered Removal](#filtered-removal)
9. [Query API](#query-api)
10. [Dirty Flag & Recalculation Pipeline](#dirty-flag--recalculation-pipeline)
11. [Index Caches](#index-caches)
12. [Replication](#replication)
13. [Authority Model](#authority-model)
14. [VM Integration](#vm-integration)
15. [Lifecycle Binding](#lifecycle-binding)
16. [Performance Characteristics](#performance-characteristics)
17. [Best Practices](#best-practices)

---

## Overview

Modifiers are **runtime-applied adjustments** to an attribute's `Max` value. They represent buffs, debuffs, equipment bonuses, auras, and any other gameplay effect that should alter an attribute without touching its `Base` value.

The system is designed around three core requirements:

| Requirement | Implementation |
|---|---|
| **Non-destructive** | Modifiers affect `Max` only. `Base` is never touched. Removing all modifiers restores the original stat |
| **Batch-friendly** | A status effect can add multiple modifiers; removing the status removes all of them in one call via `OwnerID` |
| **Network-transparent** | Modifiers replicate via `FFastArraySerializer` — clients see the full modifier stack and can compute derived values locally |

---

## FStatModifier Struct

**Source:** `Data/StatsXTypes.h`

```cpp
USTRUCT(BlueprintType)
struct STATS_X_API FStatModifier
{
    UPROPERTY(BlueprintReadOnly)
    int32 InstanceID;           // Unique modifier identifier

    UPROPERTY(BlueprintReadOnly)
    int64 OwnerID;              // Grouping key (typically StatusID)

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    FGameplayTag AttributeTag;  // Target attribute

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    FGameplayTag SourceTag;     // Origin classification

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    float AdditiveValue = 0.f;  // Flat bonus: Max += AdditiveValue

    UPROPERTY(EditAnywhere, BlueprintReadWrite)
    float MultiplicativeValue = 1.f; // Multiplier: Max *= MultiplicativeValue
};
```

### Field Descriptions

| Field | Type | Description |
|---|---|---|
| `InstanceID` | `int32` | Auto-generated unique ID returned by `AddModifier()`. Used for targeted removal |
| `OwnerID` | `int64` | Grouping key. Typically the `StatusID` of the status that created this modifier. Enables batch removal when the status ends |
| `AttributeTag` | `FGameplayTag` | The attribute this modifier affects (e.g., `StatsX.Attribute.Stat.Armor`) |
| `SourceTag` | `FGameplayTag` | Classification tag for the modifier's origin (e.g., `StatsX.ModSource.Buff`, `StatsX.Status.FireResistanceAura`). Used for queries and filtered removal |
| `AdditiveValue` | `float` | Flat value added to `Base` before multiplication. Default `0.0` = no additive effect |
| `MultiplicativeValue` | `float` | Multiplier applied after additive sum. Default `1.0` = no multiplicative effect |

### Utility Methods

| Method | Returns | Description |
|---|---|---|
| `HasEffect()` | `bool` | `true` if Additive ≠ 0 or Multiplicative ≠ 1.0 |
| `IsAdditiveOnly()` | `bool` | `true` if only the additive component has an effect |
| `IsMultiplicativeOnly()` | `bool` | `true` if only the multiplicative component has an effect |

---

## Recalculation Formula

When any modifier is added or removed, the affected attribute's `Max` is recalculated:

```
Max = (Base + ΣAdditiveValue) × ΠMultiplicativeValue
```

Where:
- **ΣAdditiveValue** — Sum of `AdditiveValue` across all modifiers targeting this attribute
- **ΠMultiplicativeValue** — Product of `MultiplicativeValue` across all modifiers targeting this attribute

### Example

```
Base = 100 (Armor)

Modifiers:
  [1] +20 Additive  (heavy shield)
  [2] +10 Additive  (enchantment)
  [3] ×1.5 Multiplicative (guardian aura)
  [4] ×0.8 Multiplicative (cursed debuff)

ΣAdditive = 20 + 10 = 30
ΠMultiplicative = 1.5 × 0.8 = 1.2

Max = (100 + 30) × 1.2 = 156
```

### Implementation

```cpp
void UStatsX_StatsComponentBase::RecalculateAttribute(FGameplayTag AttributeTag)
{
    float TotalAdditive = 0.0f;
    float TotalMultiplicative = 1.0f;

    // O(1) lookup via ModifiersByAttribute cache
    if (const TArray<int32>* ModifierIndices = ModifiersByAttribute.Find(AttributeTag))
    {
        for (int32 Index : *ModifierIndices)
        {
            const FStatModifier& Mod = ReplicatedModifiers.Items[Index].Modifier;
            TotalAdditive += Mod.AdditiveValue;
            TotalMultiplicative *= Mod.MultiplicativeValue;
        }
    }

    const float NewMax = (Stat->Base + TotalAdditive) * TotalMultiplicative;
    // ... apply to attribute with clamping
}
```

---

## Recalculation Behavior by Attribute Category

The recalculation applies differently depending on the attribute's tag hierarchy:

### Stat Attributes (`StatsX.Attribute.Stat.*`)

`Current` and `Max` are always synchronized:

```cpp
if (AttributeTag.MatchesTag(StatsX_Attribute_Stat))
{
    Stat->Max = NewMax;
    Stat->Current = NewMax;  // Current mirrors Max
}
```

This means modifiers on Stat attributes directly change the usable value. A +50 Armor modifier immediately grants +50 effective armor.

### Resource Attributes (`StatsX.Attribute.Resource.*`)

`Current` remains independent — only `Max` changes:

```cpp
else  // Resource or other
{
    Stat->SetMax(NewMax);  // SetMax() auto-reclamps Current to [0, Max]
}
```

This means a +100 Max Health modifier increases the cap but does **not** heal. However, if the new `Max` is lower than `Current`, `Current` is clamped down automatically.

### Summary

| Category | Max Changes | Current Changes |
|---|---|---|
| **Stat** | Yes — recalculated from formula | Yes — set equal to Max |
| **Resource** | Yes — recalculated from formula | Only if Current > new Max (clamped) |

---

## Identification Model

Each modifier carries two identification fields that serve different purposes:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Modifier Identification                      │
├──────────────────┬──────────────────────────────────────────────┤
│   InstanceID     │  Unique per modifier. Auto-generated.        │
│   (int32)        │  Used for: RemoveModifierByID()              │
├──────────────────┼──────────────────────────────────────────────┤
│   OwnerID        │  Shared by all modifiers from one source.    │
│   (int64)        │  Typically = StatusID of creating status.    │
│                  │  Used for: RemoveModifiersByOwner()           │
├──────────────────┼──────────────────────────────────────────────┤
│   SourceTag      │  Classification tag. Shared by category.     │
│   (FGameplayTag) │  e.g., StatsX.ModSource.Buff                │
│                  │  Used for: RemoveModifiersBySource()          │
├──────────────────┼──────────────────────────────────────────────┤
│   AttributeTag   │  Target attribute. Shared by attribute.      │
│   (FGameplayTag) │  Used for: RemoveModifiersByAttribute()      │
└──────────────────┴──────────────────────────────────────────────┘
```

### ID Generation

`InstanceID` is generated by a monotonic counter on the component:

```cpp
int32 NextModifierID = INT32_MIN + 1;

FORCEINLINE int32 GenerateModifierID()
{
    int32 ID = NextModifierID++;
    if (NextModifierID == INT32_MAX)
        NextModifierID = INT32_MIN + 1;  // Wrap-around
    return ID;
}
```

- Range: `INT32_MIN + 1` to `INT32_MAX - 1` (~4.29 billion unique IDs before wrap)
- Per-component counter (not global)

---

## Application API

### AddModifier

Adds a single modifier to the component. **Server-only** — clients cannot add modifiers.

```cpp
UFUNCTION(BlueprintCallable)
int32 AddModifier(
    FGameplayTag AttributeTag,       // Target attribute
    FGameplayTag SourceTag,          // Origin classification
    int64 OwnerID,                   // Grouping key (typically StatusID)
    float AdditiveValue,             // Flat bonus
    float MultiplicativeValue = 1.0f // Multiplier (default: no effect)
);
```

**Returns:** `InstanceID` of the created modifier, or `-1` on failure.

**Failure conditions:**
- Invalid `AttributeTag`
- Caller is not `ROLE_Authority` (server)

### Internal Flow

```
AddModifier()
  │
  ├─ Validate AttributeTag
  ├─ Check authority (server only)
  ├─ GenerateModifierID() → InstanceID
  ├─ Create FStatModifier
  ├─ Add to ReplicatedModifiers (FastArray)
  │    └─ MarkItemDirty() → queued for delta replication
  ├─ Update caches:
  │    ├─ ModifierIDToIndex[InstanceID] = newIndex
  │    └─ ModifiersByAttribute[AttributeTag].Add(newIndex)
  └─ MarkAttributeDirty(AttributeTag)
       └─ RecalculateAttribute() → immediate recalc
```

---

## Removal API

All removal methods are **server-only** and return the number of modifiers removed (or `bool` for single removal). Every removal triggers cache rebuild and attribute recalculation for affected attributes.

### RemoveModifierByID

Removes a single modifier by its unique `InstanceID`.

```cpp
UFUNCTION(BlueprintCallable)
bool RemoveModifierByID(int32 InstanceID);
```

**Returns:** `true` if found and removed.

### RemoveModifiersByOwner

Removes **all** modifiers sharing an `OwnerID`. This is the primary cleanup path when a status effect ends.

```cpp
UFUNCTION(BlueprintCallable)
int32 RemoveModifiersByOwner(int64 OwnerID);
```

**Returns:** Number of modifiers removed.

**Typical usage:** When a status instance is terminated, the system calls `RemoveModifiersByOwner(StatusID)` to clean up all modifiers created by that status.

### RemoveModifiersBySource

Removes all modifiers with a matching `SourceTag` (exact match).

```cpp
UFUNCTION(BlueprintCallable)
int32 RemoveModifiersBySource(FGameplayTag SourceTag);
```

**Returns:** Number of modifiers removed.

**Use case:** Remove all buff-type modifiers: `RemoveModifiersBySource(StatsX.ModSource.Buff)`

### RemoveModifiersByAttribute

Removes all modifiers targeting a specific attribute.

```cpp
UFUNCTION(BlueprintCallable)
int32 RemoveModifiersByAttribute(FGameplayTag AttributeTag);
```

**Returns:** Number of modifiers removed.

**Use case:** Strip all modifiers from Armor: `RemoveModifiersByAttribute(StatsX.Attribute.Stat.Armor)`

---

## Filtered Removal

### RemoveModifiersWithFilters

The most flexible removal method. Applies **AND logic** across multiple filter criteria — a modifier is only removed if it matches **all** active filters.

```cpp
UFUNCTION(BlueprintCallable)
int32 RemoveModifiersWithFilters(
    int32 Count,               // Max removals (0 = unlimited)
    int32 InstanceID,          // Filter by InstanceID (INT32_MIN = disabled)
    int64 OwnerID,             // Filter by OwnerID (0 = disabled)
    FGameplayTag SourceTag,    // Filter by SourceTag (empty = disabled)
    FGameplayTag AttributeTag  // Filter by AttributeTag (empty = disabled)
);
```

**Returns:** Number of modifiers removed.

### Filter Activation Rules

| Filter | Considered Active When |
|---|---|
| `InstanceID` | `InstanceID > INT32_MIN` |
| `OwnerID` | `OwnerID != 0` |
| `SourceTag` | `SourceTag.IsValid()` |
| `AttributeTag` | `AttributeTag.IsValid()` |

If **no** filter is active, the call returns `0` immediately (safety guard).

### Count Parameter

| Value | Behavior |
|---|---|
| `0` | Remove all matching modifiers |
| `N > 0` | Remove at most `N` matching modifiers (first found) |

### Example

Remove the first 2 buff modifiers on Armor owned by status 42:

```cpp
Component->RemoveModifiersWithFilters(
    2,                              // Count: max 2
    INT32_MIN,                      // InstanceID: disabled
    42,                             // OwnerID: status 42
    StatsX_ModSource_Buff,          // SourceTag: buffs only
    StatsX_Attribute_Stat_Armor     // AttributeTag: armor only
);
```

---

## Query API

All query methods are `const` and available on both server and client.

### GetModifiersForAttribute

Returns all active modifiers affecting a specific attribute.

```cpp
UFUNCTION(BlueprintCallable)
TArray<FStatModifier> GetModifiersForAttribute(FGameplayTag AttributeTag) const;
```

### GetModifiersByOwner

Returns all modifiers created by a specific owner (e.g., a status instance).

```cpp
UFUNCTION(BlueprintCallable)
TArray<FStatModifier> GetModifiersByOwner(int64 OwnerID) const;
```

### GetModifiersBySource

Returns all modifiers from a specific source category.

```cpp
UFUNCTION(BlueprintCallable)
TArray<FStatModifier> GetModifiersBySource(FGameplayTag SourceTag) const;
```

### GetModifierCount

Returns the total number of active modifiers on the component.

```cpp
UFUNCTION(BlueprintPure)
int32 GetModifierCount() const;
```

---

## Dirty Flag & Recalculation Pipeline

The modifier system uses a dirty flag pattern to batch and optimize recalculations.

### Data Structures

```cpp
// Set of attribute tags pending recalculation
TSet<FGameplayTag> DirtyAttributes;
```

### Pipeline

```
Modifier Add/Remove
  │
  ├─ MarkAttributeDirty(AttributeTag)
  │    ├─ DirtyAttributes.Add(AttributeTag)
  │    ├─ RecalculateAttribute(AttributeTag)   ← immediate recalc
  │    └─ DirtyAttributes.Remove(AttributeTag)
  │
  └─ (For batch removals: multiple MarkAttributeDirty calls)

RecalculateAttribute(AttributeTag)
  │
  ├─ Find FStatAttribute* in StatsAttributes map
  ├─ Lookup ModifiersByAttribute cache → TArray<int32> indices
  ├─ Accumulate ΣAdditive, ΠMultiplicative
  ├─ Compute Max = (Base + ΣAdditive) × ΠMultiplicative
  ├─ Apply category-specific logic:
  │    ├─ Stat: Current = Max
  │    └─ Resource: SetMax(NewMax) → auto-clamp Current
  ├─ Replicate if bReplicated
  └─ Done
```

### Batch Removal Optimization

When removing multiple modifiers (e.g., `RemoveModifiersByOwner`), affected attributes are collected into a `TSet<FGameplayTag>` first, then each is recalculated once — regardless of how many modifiers were removed from that attribute.

```cpp
TSet<FGameplayTag> AffectedAttributes;
// ... remove loop collects tags ...
for (const FGameplayTag& Tag : AffectedAttributes)
{
    MarkAttributeDirty(Tag);  // One recalc per attribute
}
```

---

## Index Caches

Two cache structures accelerate modifier lookups:

### ModifierIDToIndex

```cpp
TMap<int32, int32> ModifierIDToIndex;
// Maps InstanceID → index in ReplicatedModifiers.Items array
```

Enables O(1) lookup by `InstanceID`. Rebuilt after any removal.

### ModifiersByAttribute

```cpp
TMap<FGameplayTag, TArray<int32>> ModifiersByAttribute;
// Maps AttributeTag → array of indices in ReplicatedModifiers.Items
```

Enables O(1) lookup of all modifiers for a given attribute during recalculation.

### Cache Rebuild

Both caches are rebuilt from scratch after any removal operation:

```cpp
void RebuildModifierIndexCache()
{
    ModifierIDToIndex.Empty(ReplicatedModifiers.Items.Num());
    ModifiersByAttribute.Empty();

    for (int32 i = 0; i < ReplicatedModifiers.Items.Num(); ++i)
    {
        const FStatModifier& Mod = ReplicatedModifiers.Items[i].Modifier;
        ModifierIDToIndex.Add(Mod.InstanceID, i);
        ModifiersByAttribute.FindOrAdd(Mod.AttributeTag).Add(i);
    }
}
```

This is necessary because removal uses `RemoveAtSwap` (O(1) array removal) which changes the indices of remaining elements.

---

## Replication

### FastArraySerializer

Modifiers replicate via `FReplicatedModifierArray`, a `FFastArraySerializer` subclass:

```cpp
USTRUCT()
struct FReplicatedModifierItem : public FFastArraySerializerItem
{
    UPROPERTY()
    FStatModifier Modifier;
};

USTRUCT()
struct FReplicatedModifierArray : public FFastArraySerializer
{
    UPROPERTY()
    TArray<FReplicatedModifierItem> Items;

    UPROPERTY(NotReplicated)
    TWeakObjectPtr<UStatsX_StatsComponentBase> OwnerComponent;
};
```

### Replication Callbacks

| Callback | Trigger | Client-Side Action |
|---|---|---|
| `PostReplicatedAdd` | Server added a modifier | `MarkAttributeDirty()` → recalc on client |
| `PostReplicatedChange` | Server modified a modifier | `MarkAttributeDirty()` → recalc on client |
| `PreReplicatedRemove` | Server removed a modifier | `MarkAttributeDirty()` → recalc on client |

All callbacks skip processing on authority (`ROLE_Authority`) to avoid double-processing on listen servers.

### Delta Efficiency

- **Add:** `MarkItemDirty()` → only the new item is sent
- **Remove:** `MarkArrayDirty()` → minimal delta update
- **Bulk operations:** Single `MarkArrayDirty()` after all removals, then one replication pass

---

## Authority Model

The modifier system enforces **strict server authority**:

| Operation | Server | Client |
|---|---|---|
| `AddModifier()` | Allowed, returns InstanceID | Returns `-1`, no-op |
| `RemoveModifierByID()` | Allowed | Returns `false`, no-op |
| `RemoveModifiersByOwner()` | Allowed | Returns `0`, no-op |
| `RemoveModifiersBySource()` | Allowed | Returns `0`, no-op |
| `RemoveModifiersByAttribute()` | Allowed | Returns `0`, no-op |
| `RemoveModifiersWithFilters()` | Allowed | Returns `0`, no-op |
| `GetModifiers*()` (queries) | Allowed | Allowed (reads replicated data) |
| `GetModifierCount()` | Allowed | Allowed |

Clients see the modifier stack through replication and can query it, but cannot mutate it. All mutations flow: **Server → FastArray replication → Client callback → local recalc**.

---

## VM Integration

The ForgeVM interacts with modifiers through dedicated OpCodes executed during status bytecode.

### Key OpCodes

| OpCode | Description |
|---|---|
| `OP_AddModifier` | Adds a modifier to the target or caster component. Encodes AttributeTag, SourceTag, Additive, Multiplicative in instruction payload. OwnerID is auto-set to the current StatusID |
| `OP_RemoveModifiers` | Removes modifiers matching filter criteria. Supports all the same filters as `RemoveModifiersWithFilters()` |
| `OP_RemoveModifiersByOwner` | Convenience: removes all modifiers from a specific owner |

### Automatic Cleanup

When a status instance is terminated (for any reason), the system automatically removes all modifiers owned by that `StatusID` via `RemoveModifiersByOwner(StatusID)`. This ensures no orphaned modifiers remain after a buff/debuff expires.

---

## Lifecycle Binding

Modifiers are typically bound to a status effect's lifecycle:

```
Status Applied (OP_AddModifier)
  │
  ├─ AddModifier(Armor, BuffSource, StatusID=42, +50, 1.0)
  │    → InstanceID = 7, OwnerID = 42
  │
  ├─ AddModifier(MoveSpeed, BuffSource, StatusID=42, 0, 1.25)
  │    → InstanceID = 8, OwnerID = 42
  │
  │   ... status is active ...
  │
Status Terminated (any reason)
  │
  └─ RemoveModifiersByOwner(42)
       ├─ Removes InstanceID 7 (Armor +50)
       ├─ Removes InstanceID 8 (MoveSpeed ×1.25)
       ├─ Recalculates Armor
       └─ Recalculates MoveSpeed
```

This pattern guarantees clean modifier lifecycle regardless of how the status ends (expiry, explicit removal, owner destroyed, replaced, etc.).

---

## Performance Characteristics

| Operation | Complexity | Notes |
|---|---|---|
| `AddModifier` | O(1) | Append to array + cache update |
| `RemoveModifierByID` | O(N) | Linear scan + O(N) cache rebuild |
| `RemoveModifiersByOwner` | O(N) | Single reverse-iteration pass + O(N) cache rebuild |
| `RemoveModifiersBySource` | O(N) | Single reverse-iteration pass + O(N) cache rebuild |
| `RemoveModifiersByAttribute` | O(N) | Single reverse-iteration pass + O(N) cache rebuild |
| `RemoveModifiersWithFilters` | O(N) | Single reverse-iteration pass + O(N) cache rebuild |
| `RecalculateAttribute` | O(K) | K = number of modifiers on this attribute (via cache) |
| `GetModifiersForAttribute` | O(N) | Linear scan (copies results) |
| `GetModifierCount` | O(1) | Direct array size |
| Array removal | O(1) per item | `RemoveAtSwap` — no element shifting |

Where N = total modifiers on the component, K = modifiers for one attribute.

**Typical enterprise scenario:** A character with 20–50 active modifiers. All operations complete in microseconds.

---

## Best Practices

### 1. Always Use OwnerID for Status-Bound Modifiers

Set `OwnerID` to the `StatusID` of the creating status. This guarantees automatic cleanup:

```cpp
// In status bytecode (via OP_AddModifier):
Component->AddModifier(ArmorTag, BuffTag, /*OwnerID=*/StatusID, 50.f, 1.f);

// Automatic on status end:
Component->RemoveModifiersByOwner(StatusID);
```

### 2. Use SourceTag for Category-Based Queries

Structure your source tags for flexible filtering:

```
StatsX.ModSource.Buff
StatsX.ModSource.Debuff
StatsX.ModSource.Equipment
StatsX.ModSource.Passive
StatsX.ModSource.Aura
```

This enables UI queries like "show all buff modifiers" without knowing individual status IDs.

### 3. Additive vs Multiplicative: When to Use Each

| Scenario | Approach | Example |
|---|---|---|
| Flat bonus (item stat) | Additive | +50 Armor from shield |
| Percentage buff/debuff | Multiplicative | ×1.2 for 20% increase, ×0.7 for 30% reduction |
| Combined effect | Both | +30 Additive + ×1.1 Multiplicative |

### 4. Avoid Redundant Modifiers

Use `HasEffect()` before adding to skip no-op modifiers:

```cpp
if (FStatModifier(0, 0, Tag, Source, Additive, Multiplicative).HasEffect())
{
    Component->AddModifier(Tag, Source, OwnerID, Additive, Multiplicative);
}
```

### 5. Use Filtered Removal for Fine-Grained Control

When you need to remove specific subsets (e.g., "remove the first 3 buff modifiers on Armor from status 42"), use `RemoveModifiersWithFilters()` with its AND-logic and Count parameter instead of chaining multiple removal calls.

### 6. Query on Client, Mutate on Server

Leverage the replicated modifier stack on clients for UI display:

```cpp
// Client-safe: display modifier breakdown in UI
TArray<FStatModifier> ArmorMods = Component->GetModifiersForAttribute(ArmorTag);
for (const FStatModifier& Mod : ArmorMods)
{
    // Show: Source, Additive, Multiplicative
}
```
