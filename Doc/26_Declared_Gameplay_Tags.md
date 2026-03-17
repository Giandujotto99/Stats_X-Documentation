# 26 — Declared Gameplay Tags

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Overview

Stats_X declares **22 native gameplay tags** using the Unreal Engine `UE_DECLARE_GAMEPLAY_TAG_EXTERN` / `UE_DEFINE_GAMEPLAY_TAG` pattern. All tags are centralized in a single header/definition pair:

| File | Role |
|---|---|
| `Public/Data/StatsXTypes.h` | `UE_DECLARE_GAMEPLAY_TAG_EXTERN` — extern declarations (lines 12–41). |
| `Private/Data/StatsXTypes.cpp` | `UE_DEFINE_GAMEPLAY_TAG` — definitions with tag strings (lines 6–35). |

Tags are registered at module load time via the native gameplay tag system. No `.ini`, `.csv`, or `RequestGameplayTag` dynamic registrations are used.

---

## Tag Hierarchy

```
StatsX
├── Attribute
│   ├── Resource
│   └── Stat
├── SubAttribute
│   ├── Current
│   ├── Max
│   ├── Base
│   ├── Overflows
│   └── Replicated
├── DamageType
├── Status
├── Event
│   ├── Pre
│   ├── Post
│   └── Gameplay
├── ModSource
├── Variable
│   └── Payload
├── ContainerType
│   ├── CastedStatuses
│   └── ReceivedStatuses
└── MitigationFormula
    ├── XFlat
    ├── XPercentage
    ├── XDiminishing
    └── XExponentialDecay
```

---

## Attribute Tags

These tags categorize attributes and control how the attribute system handles value synchronization.

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.Attribute` | `StatsX_Attribute` | Parent tag for all attributes. Used as a category filter for UI parameter dropdowns and hierarchy validation. |
| `StatsX.Attribute.Resource` | `StatsX_Attribute_Resource` | Marks pooled resource attributes (health, mana, stamina) where Current can differ from Max. Validated by `InitializeResourceAttribute`. |
| `StatsX.Attribute.Stat` | `StatsX_Attribute_Stat` | Marks synchronized stat attributes (strength, speed, defense) where Current always equals Max. Modifying Max automatically synchronizes Current. |

---

## Sub-Attribute Tags

Sub-attribute tags identify which facet of an attribute is being read or written by opcodes such as `OP_ModifyAttribute`, `OP_SetAttribute`, and `OP_GetAttributeValue`.

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.SubAttribute.Current` | `StatsX_SubAttribute_Current` | Targets the live/active value of an attribute. Used by mitigation calculations to retrieve resistance values. |
| `StatsX.SubAttribute.Max` | `StatsX_SubAttribute_Max` | Targets the maximum possible value. For Stat-type attributes, changing Max auto-synchronizes Current. |
| `StatsX.SubAttribute.Base` | `StatsX_SubAttribute_Base` | Targets the unmodified foundation value before additive/multiplicative modifiers are applied. |
| `StatsX.SubAttribute.Overflows` | `StatsX_SubAttribute_Overflows` | Read-only. Returns overflow state as float (`1.0` = enabled, `0.0` = disabled). Direct modification forbidden — use `SetEnableOverflows`. |
| `StatsX.SubAttribute.Replicated` | `StatsX_SubAttribute_Replicated` | Read-only. Returns replication state as float (`1.0` = replicated, `0.0` = local-only). Direct modification forbidden — use `SetEnableReplicated`. |

---

## Damage Type Tag

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.DamageType` | `StatsX_DamageType` | Parent tag for all damage type categories (Fire, Physical, Magical, etc.). Used by `OP_CalculateMitigation` to map incoming damage types to resistance attributes via `DamageToResistancesMap`. |

Projects extend this hierarchy with game-specific children (e.g. `StatsX.DamageType.Fire`, `StatsX.DamageType.Physical`).

---

## Status Tag

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.Status` | `StatsX_Status` | Parent tag for all status effect definitions. Validates that cast operations target valid status definitions via `ResolveStatusData` and `GetStatusData`. |

Each status definition is assigned a child tag under this hierarchy (e.g. `StatsX.Status.Burn`, `StatsX.Status.Shield`).

---

## Event Tags

Event tags classify the timing and context of propagation events consumed by the interceptor system.

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.Event.Pre` | `StatsX_Event_Pre` | Marks events that fire **before** mitigation or status effects apply. Interceptors use these to peek at or modify incoming changes before state mutation. |
| `StatsX.Event.Post` | `StatsX_Event_Post` | Marks events that fire **after** all changes have been applied. Interceptors use these to react to final values and trigger side effects. |
| `StatsX.Event.Gameplay` | `StatsX_Event_Gameplay` | Marks gameplay-specific events (skill execution, threshold crossing, status procs). Filters which events are exposed to gameplay systems versus internal processing. |

---

## Modifier Source Tag

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.ModSource` | `StatsX_ModSource` | Parent tag for modifier origin categories. Used by `OP_AddModifier` to stamp the source on each modifier, and by `RemoveModifiersBySource` to batch-remove all modifiers from a given origin. |

Projects extend with game-specific children (e.g. `StatsX.ModSource.Buff`, `StatsX.ModSource.Equipment`, `StatsX.ModSource.Status`).

---

## Variable Tags

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.Variable` | `StatsX_Variable` | Parent tag for all status runtime variables. Enforces category filtering in `GetVariableFloat`, `SetVariableInt`, and custom logic accessor functions. |
| `StatsX.Variable.Payload` | `StatsX_Variable_Payload` | Marks variables exposed as propagation event payload fields. `FForgePayloadEntry` uses these to describe which runtime data is accessible to interceptors during event propagation. |

---

## Container Type Tags

These tags select which status container a conditional check queries.

| Tag String | C++ Variable | Purpose |
|---|---|---|
| `StatsX.ContainerType.CastedStatuses` | `StatsX_ContainerType_CastedStatuses` | Queries statuses this entity has actively cast on others. Dispatches to `HasCastedStatus` / `HasAnyCastedStatus` / `HasAllCastedStatus`. |
| `StatsX.ContainerType.ReceivedStatuses` | `StatsX_ContainerType_ReceivedStatuses` | Queries statuses currently affecting this entity. Dispatches to `HasReceivedStatus` / `HasAnyReceivedStatus` / `HasAllReceivedStatus`. |

---

## Mitigation Formula Tags

These tags select the damage mitigation formula dispatched by `OP_CalculateMitigation` (opcode 271). See [22 — Damage Mitigation](22_Damage_Mitigation.md) for formula details.

| Tag String | C++ Variable | Dispatches To |
|---|---|---|
| `StatsX.MitigationFormula.XFlat` | `StatsX_MitigationFormula_XFlat` | `Mitigation_XFlat` — flat reduction: `Delta - (Resistance * 100)`. |
| `StatsX.MitigationFormula.XPercentage` | `StatsX_MitigationFormula_XPercentage` | `Mitigation_XPercentage` — percentage: `Delta * (1 - clamp(Resistance, 0, 1))`. |
| `StatsX.MitigationFormula.XDiminishing` | `StatsX_MitigationFormula_XDiminishing` | `Mitigation_XDiminishing` — asymptotic: `Delta * (Scale / (Scale + Resistance))`. |
| `StatsX.MitigationFormula.XExponentialDecay` | `StatsX_MitigationFormula_XExponentialDecay` | `Mitigation_XExponentialDecay` — exponential: `Delta * e^(-Resistance / Scale)`. |

If the formula tag does not match any of the four built-ins, the system falls back to `Mitigation_CustomFormula` (Blueprint-implementable event).

---

## Extension Points

Stats_X's native tags are **parent hierarchies** designed for project-level extension. The plugin itself defines only root and structural tags — game projects add children as needed:

| Parent Tag | Example Children (project-defined) |
|---|---|
| `StatsX.Attribute.Resource` | `StatsX.Attribute.Resource.Health`, `StatsX.Attribute.Resource.Mana` |
| `StatsX.Attribute.Stat` | `StatsX.Attribute.Stat.Strength`, `StatsX.Attribute.Stat.Armor` |
| `StatsX.DamageType` | `StatsX.DamageType.Fire`, `StatsX.DamageType.Physical` |
| `StatsX.Status` | `StatsX.Status.Burn`, `StatsX.Status.Shield` |
| `StatsX.Event.Gameplay` | `StatsX.Event.Gameplay.OnHit`, `StatsX.Event.Gameplay.OnKill` |
| `StatsX.ModSource` | `StatsX.ModSource.Buff`, `StatsX.ModSource.Equipment` |
| `StatsX.Variable` | `StatsX.Variable.DamageDealt`, `StatsX.Variable.HealAmount` |

Child tags can be added via the Unreal Editor Gameplay Tag manager, `.ini` tag tables, or project-level `UE_DEFINE_GAMEPLAY_TAG` declarations.

---

## Summary

| Category | Count | Parent Tag |
|---|---|---|
| Attribute | 3 | `StatsX.Attribute` |
| Sub-Attribute | 5 | `StatsX.SubAttribute` |
| Damage Type | 1 | `StatsX.DamageType` |
| Status | 1 | `StatsX.Status` |
| Event | 3 | `StatsX.Event` |
| Modifier Source | 1 | `StatsX.ModSource` |
| Variable | 2 | `StatsX.Variable` |
| Container Type | 2 | `StatsX.ContainerType` |
| Mitigation Formula | 4 | `StatsX.MitigationFormula` |
| **Total** | **22** | |
