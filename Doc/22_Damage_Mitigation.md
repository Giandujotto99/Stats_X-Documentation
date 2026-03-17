# 22 — Damage Mitigation

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Overview

The Damage Mitigation system provides a composable, formula-driven pipeline for reducing incoming damage based on resistance attributes.
The server computes mitigation entirely within ForgeVM through a dedicated opcode (`OP_CalculateMitigation`, 271). Four built-in formulas cover common RPG damage models; a Blueprint-extensible custom formula hook allows game-specific logic without C++ changes.

---

## Architecture

```
ForgeVM Instruction Stream
         │
         ▼
  OP_CalculateMitigation (271)
         │
         ├── Resolve owning UStatsX_StatsComponentBase
         │       via IStatsXComponentProvider
         │
         ├── Read continuation data:
         │     MitigationFormula   (FGameplayTag)
         │     AttributeTag        (FGameplayTag)
         │     SubAttributeTag     (FGameplayTag)
         │     Delta               (float — raw damage)
         │     DamageTypes         (FGameplayTagContainer)
         │     OutputOffset        (int32)
         │
         ├── Accumulate TotalResistance
         │     DamageToResistancesMap  →  per-type resistance attributes
         │
         ├── Dispatch to formula:
         │     ├── Stat.Mitigation.XFlat
         │     ├── Stat.Mitigation.XPercentage
         │     ├── Stat.Mitigation.XDiminishing
         │     ├── Stat.Mitigation.XExponentialDecay
         │     └── (other) → Mitigation_CustomFormula
         │
         └── WriteOutput<float>(mitigated result)
```

---

## Opcode — OP_CalculateMitigation (271)

| Field | Type | Description |
|---|---|---|
| `MitigationFormula` | `FGameplayTag` | Selects which formula to apply. |
| `AttributeTag` | `FGameplayTag` | The attribute being modified (e.g. `Stat.Health`). |
| `SubAttributeTag` | `FGameplayTag` | Sub-attribute channel (e.g. `Stat.Health.Current`). |
| `Delta` | `float` | Raw incoming damage value (negative = damage, positive = heal). |
| `DamageTypes` | `FGameplayTagContainer` | Tags describing the damage source (e.g. `Damage.Fire`, `Damage.Physical`). |
| `OutputOffset` | `int32` | Variable offset for writing the mitigated result. |

**Execution flow** (source: `Nodes_Core.cpp:4021-4121`):

1. Resolve the target component via `IStatsXComponentProvider` on the execution context's target actor.
2. Read all continuation fields from the instruction stream.
3. Iterate `DamageTypes`: for each tag, look up `DamageToResistancesMap` on the component to find associated resistance attribute tags, then sum their `Current` values into `TotalResistance`.
4. Dispatch to the matching formula function based on `MitigationFormula`.
5. Write the mitigated `float` result to the output variable at `OutputOffset`.

---

## Component Configuration

Defined on `UStatsX_StatsComponentBase`:

| Property | Type | Default | Description |
|---|---|---|---|
| `DamageToResistancesMap` | `TMap<FGameplayTag, FGameplayTagContainer>` | empty | Maps each damage-type tag to the set of resistance attribute tags that counter it. |
| `DiminishingMitigationScaleFactor` | `float` | `100.f` | Scale constant for the Diminishing formula. |
| `ExponentialDecayMitigationScaleFactor` | `float` | `100.f` | Scale constant for the Exponential Decay formula. |

### DamageToResistancesMap

The map is the core configuration point. Each key is a damage-type gameplay tag; the value is a container of attribute tags whose `Current` values are summed to produce `TotalResistance` for that damage type.

When multiple damage types are present in a single `OP_CalculateMitigation` call, all resistance values across all matching damage types are accumulated into a single `TotalResistance` before the formula runs.

**Example mapping:**

```
Damage.Physical  →  { Stat.Armor, Stat.PhysicalResistance }
Damage.Fire      →  { Stat.FireResistance }
Damage.Magic     →  { Stat.MagicResistance, Stat.SpellWard }
```

---

## Built-In Formulas

All formulas are implemented as member functions of `UStatsX_StatsComponentBase` (source: `StatsX_StatsComponentBase.cpp:3428-3531`).

Each formula receives:

| Parameter | Type | Description |
|---|---|---|
| `Delta` | `float` | Raw damage value. |
| `TotalResistance` | `float` | Accumulated resistance from all matching attributes. |
| `MitigationInfo` | `FGenericMitigationInfo` | Full context (formula tag, attribute info, damage types). |

### Mitigation_XFlat

**Tag:** `Stat.Mitigation.XFlat`

**Formula:**

```
Mitigated = Delta - (TotalResistance * 100)
```

Subtracts a flat amount from the raw damage. Preserves damage sign: if `Delta` is negative (damage), the result is clamped so it cannot become positive (healing); if `Delta` is positive (healing), the result is clamped so it cannot become negative (damage).

**Behavior:**
- Resistance of `0.5` blocks `50` points of damage.
- Resistance of `2.0` blocks `200` points of damage.
- If resistance exceeds damage magnitude, result clamps to `0`.

### Mitigation_XPercentage

**Tag:** `Stat.Mitigation.XPercentage`

**Formula:**

```
Mitigated = Delta * (1 - clamp(TotalResistance, 0, 1))
```

Reduces damage by a percentage. `TotalResistance` is clamped to `[0, 1]` before application.

**Behavior:**
- Resistance of `0.25` reduces damage by 25%.
- Resistance of `1.0` reduces damage by 100% (full immunity).
- Resistance values above `1.0` are clamped to `1.0`.
- Resistance values below `0.0` are clamped to `0.0` (no amplification).

### Mitigation_XDiminishing

**Tag:** `Stat.Mitigation.XDiminishing`

**Formula:**

```
ScaledResistance = TotalResistance * 100
Mitigated = Delta * (Scale / (Scale + ScaledResistance))
```

Where `Scale` = `DiminishingMitigationScaleFactor` (default `100.f`).

Produces asymptotic damage reduction: each point of resistance provides diminishing returns. Damage can never be fully mitigated.

**Behavior** (with default scale `100`):
- Resistance `0.0` → 0% reduction (multiplier = 1.0)
- Resistance `0.5` → ~33% reduction (multiplier ≈ 0.667)
- Resistance `1.0` → 50% reduction (multiplier = 0.5)
- Resistance `2.0` → ~67% reduction (multiplier ≈ 0.333)
- Resistance `10.0` → ~91% reduction (multiplier ≈ 0.091)
- Resistance → ∞: reduction approaches 100% but never reaches it.

### Mitigation_XExponentialDecay

**Tag:** `Stat.Mitigation.XExponentialDecay`

**Formula:**

```
ScaledResistance = TotalResistance * 100
Mitigated = Delta * e^(-ScaledResistance / Scale)
```

Where `Scale` = `ExponentialDecayMitigationScaleFactor` (default `100.f`).

Damage decays exponentially with resistance. Like Diminishing, damage approaches zero asymptotically but never reaches it.

**Behavior** (with default scale `100`):
- Resistance `0.0` → 0% reduction (multiplier = 1.0)
- Resistance `0.5` → ~39% reduction (multiplier ≈ 0.607)
- Resistance `1.0` → ~63% reduction (multiplier ≈ 0.368)
- Resistance `2.0` → ~86% reduction (multiplier ≈ 0.135)
- Resistance `5.0` → ~99.3% reduction (multiplier ≈ 0.007)

Exponential Decay provides steeper reduction than Diminishing at high resistance values, making it suitable for systems where high resistance should be very effective.

---

## Formula Comparison

| Resistance | XFlat (damage) | XPercentage | XDiminishing | XExponentialDecay |
|---|---|---|---|---|
| 0.0 | 100 | 100 | 100 | 100 |
| 0.25 | 75 | 75 | 80 | 78 |
| 0.5 | 50 | 50 | 67 | 61 |
| 1.0 | 0 | 0 | 50 | 37 |
| 2.0 | 0 | 0 | 33 | 14 |
| 5.0 | 0 | 0 | 9 | 1 |

*Table assumes `Delta = -100` (100 points of damage), default scale factors. Values show remaining damage after mitigation.*

---

## Custom Formula Extension

**Declaration** (on `UStatsX_StatsComponentBase`):

```cpp
UFUNCTION(BlueprintImplementableEvent, Category = "StatsX|Mitigation")
float Mitigation_CustomFormula(
    float Delta,
    float TotalResistance,
    const FGenericMitigationInfo& MitigationInfo
);
```

When `MitigationFormula` does not match any of the four built-in tags, the opcode dispatches to `Mitigation_CustomFormula`. This is a `BlueprintImplementableEvent` — override it in a Blueprint subclass of the stats component to implement arbitrary game-specific formulas.

**Parameters available in the override:**
- `Delta` — raw damage value.
- `TotalResistance` — accumulated resistance from `DamageToResistancesMap`.
- `MitigationInfo` — full context struct (see below).

**Return value:** the mitigated damage `float`, written back to the ForgeVM output variable.

If `Mitigation_CustomFormula` is not overridden, the default implementation returns `Delta` unmodified (no mitigation).

---

## Supporting Data Structures

### FGenericMitigationInfo

| Field | Type | Description |
|---|---|---|
| `MitigationFormula` | `FGameplayTag` | The formula tag dispatched by the opcode. |
| `AttributeModifyInfo` | `FAttributeModifyInfo` | Detailed modification context (see below). |

### FAttributeModifyInfo

| Field | Type | Description |
|---|---|---|
| `DamageTypes` | `FGameplayTagContainer` | All damage-type tags from the instruction. |
| `AttributeTag` | `FGameplayTag` | The attribute being modified. |
| `SubAttributeTag` | `FGameplayTag` | Sub-attribute channel. |
| `Delta` | `float` | Raw damage value before mitigation. |
| `ModifyOp` | `EStatModifyOp` | The modification operation type. |

These structs are passed through to both built-in and custom formulas, providing full context about the damage event for formula-specific logic.

---

## Mitigation Formula Tags

Declared in `StatsXTypes.cpp`:

| Tag | Constant |
|---|---|
| `Stat.Mitigation.XFlat` | Built-in flat subtraction formula. |
| `Stat.Mitigation.XPercentage` | Built-in percentage reduction formula. |
| `Stat.Mitigation.XDiminishing` | Built-in diminishing returns formula. |
| `Stat.Mitigation.XExponentialDecay` | Built-in exponential decay formula. |

Any other `FGameplayTag` used as `MitigationFormula` routes to `Mitigation_CustomFormula`.

---

## Integration Notes

- **Server-only computation.** `OP_CalculateMitigation` executes within ForgeVM on the authority. Clients receive the final attribute change through the standard replication pipeline (see [20 — Replication](20_Replication.md)).
- **Multiple damage types.** When `DamageTypes` contains more than one tag, resistances from all matching entries in `DamageToResistancesMap` are summed into a single `TotalResistance`. This means a single resistance attribute can counter multiple damage types if mapped accordingly.
- **Attribute resolution.** Resistance values are read from the `Current` sub-attribute of each resistance tag. Modifiers affecting resistance attributes (e.g. a buff granting +0.5 fire resistance) are fully resolved before `TotalResistance` is computed.
- **Sign semantics.** Negative `Delta` represents damage; positive `Delta` represents healing. The XFlat formula preserves sign direction. Other formulas apply a multiplier, naturally preserving sign.
- **Scale factor tuning.** `DiminishingMitigationScaleFactor` and `ExponentialDecayMitigationScaleFactor` are exposed as `EditAnywhere` properties on the component, allowing per-actor tuning without code changes.
