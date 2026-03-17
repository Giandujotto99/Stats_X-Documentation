# 20 — Replication

> **Stats_X v1.404 — Unreal Engine 5.7**
> Layer: **Component / Network** — server-authoritative gameplay state replication via `FFastArraySerializer`.

---

## 1. Split Replication Model

Stats_X separates network replication into two independent channels:

| Channel | Transport | Owner | Purpose |
|---|---|---|---|
| **Gameplay state** | 6 `FFastArraySerializer` arrays on `UStatsX_StatsComponentBase` | Component (this document) | Attributes, modifiers, status tags, lifecycle seeds, delta updates |
| **Cosmetic state** | `AStatsX_NetCueRelay` actors | World Subsystem | VFX, SFX, montage cues (see [18 — Cosmetic Cue Routing](18_Cosmetic_Cue_Routing.md)) |

This split ensures gameplay correctness (reliable, delta-compressed) is
decoupled from presentation bandwidth (unreliable bursts + state streams).

---

## 2. Replication Architecture

```
 SERVER (Authority)
 ──────────────────
 UStatsX_StatsComponentBase
   ├── ReplicatedAttributes      ──► FFastArraySerializer (delta)
   ├── ReplicatedModifiers       ──► FFastArraySerializer (delta)
   ├── ReplicatedCastedTags      ──► FFastArraySerializer (delta)
   ├── ReplicatedReceivedTags    ──► FFastArraySerializer (delta)
   ├── ReplicatedStatusSeeds     ──► FFastArraySerializer (delta)
   └── ReplicatedStatusUpdates   ──► FFastArraySerializer (delta)
                                      │
                                      ▼
 CLIENT (Simulated/Autonomous)
 ─────────────────────────────
   PostReplicatedAdd / PostReplicatedChange / PreReplicatedRemove
     ├── Sync local data structures (maps, containers)
     ├── Mark dirty for recalculation (modifiers)
     └── Broadcast Blueprint delegates
```

All six arrays use `DOREPLIFETIME` without conditions — unconditional
replication to all connected clients.  No `OnRep_` callbacks; all client-side
logic flows through the `FFastArraySerializer` item callbacks instead.

---

## 3. Replicated Properties

```
Source  Public/Core/StatsX_StatsComponentBase.h:118-216
        Private/Core/StatsX_StatsComponentBase.cpp:318-328
```

```cpp
void UStatsX_StatsComponentBase::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    Super::GetLifetimeReplicatedProps(OutLifetimeProps);

    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedAttributes);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedModifiers);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedCastedTags);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedReceivedTags);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedStatusSeeds);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedStatusUpdates);
}
```

---

## 4. Fast Array Serializer Overview

Each replicated array follows the same pattern:

```
Source  Public/Data/StatsXReplication.h (entire file, 444 lines)
```

| Component | Role |
|---|---|
| `FFastArraySerializerItem` subclass | One replicated record (attribute, modifier, tag, seed, or update) |
| `FFastArraySerializer` subclass | Container with `TArray<Item>`, `OwnerComponent` back-pointer, `NetDeltaSerialize` |
| `TStructOpsTypeTraits` specialization | Enables `WithNetDeltaSerializer` for the outer struct |
| `Initialize(OwnerComponent)` | Called during component init to bind the back-pointer |
| `MarkItemDirty(Item)` | Server-side: flags an item for next delta replication pass |
| `MarkArrayDirty()` | Server-side: flags the entire array for full resync |

The `OwnerComponent` field is marked `NotReplicated` — it is set locally on
both server and client during component initialization.

---

## 5. Attribute Replication

### 5.1 FReplicatedAttributeItem

```
Source  Public/Data/StatsXReplication.h:24-49
```

| Field | Type | Purpose |
|---|---|---|
| `AttributeTag` | `FGameplayTag` | Identifies the attribute (e.g. `StatsX.Attribute.Health`) |
| `AttributeValue` | `FStatAttribute` | Full attribute snapshot |

### 5.2 FStatAttribute (Replicated Payload)

```
Source  Public/Data/StatsXTypes.h:442-489
```

| Field | Type | Purpose |
|---|---|---|
| `Current` | `float` | Actual usable value (e.g. current HP) |
| `Max` | `float` | Calculated maximum: `(Base + TotalAdditive) * TotalMultiplicative` |
| `Base` | `float` | Unmodified foundation value |
| `bOverflows` | `bool` | If true, disables all clamping |
| `bReplicated` | `bool` | If false, attribute is server-only — not added to Fast Array |

The `bReplicated` flag is a **per-attribute opt-out**.  Attributes marked
`bReplicated = false` are never added to `ReplicatedAttributes`, saving
bandwidth for server-only data (e.g. internal timers, scratch values).

### 5.3 Client-Side Callbacks

```
Source  Private/Core/StatsX_StatsComponentBase.cpp:935-1024
```

| Callback | Action |
|---|---|
| `PostReplicatedAdd` | Add to local `StatsAttributes` map, broadcast `OnAttributeChanged` |
| `PostReplicatedChange` | Update local map, broadcast `OnAttributeChanged` (client-only) |
| `PreReplicatedRemove` | Remove from local map, broadcast change event (client-only) |

### 5.4 Server-Side Dirty Path

When the server modifies an attribute:

1. Update `StatsAttributes` map.
2. Find or create the corresponding `FReplicatedAttributeItem` in the Fast Array.
3. Call `MarkItemDirty(Item)` — queues for next `NetDeltaSerialize` pass.
4. Uses `AttributeIndexCache` (`TMap<FGameplayTag, int32>`) for O(1) lookup.

---

## 6. Modifier Replication

### 6.1 FReplicatedModifierItem

```
Source  Public/Data/StatsXReplication.h:111-128
```

| Field | Type | Purpose |
|---|---|---|
| `Modifier` | `FStatModifier` | Complete modifier data |

### 6.2 FStatModifier (Replicated Payload)

```
Source  Public/Data/StatsXTypes.h:732-775
```

| Field | Type | Purpose |
|---|---|---|
| `InstanceID` | `int32` | Unique modifier identifier |
| `OwnerID` | `int64` | Status instance that created this modifier |
| `AttributeTag` | `FGameplayTag` | Target attribute |
| `SourceTag` | `FGameplayTag` | Origin of the modifier (buff, equipment, etc.) |
| `AdditiveValue` | `float` | Flat additive bonus: `Max += AdditiveValue` |
| `MultiplicativeValue` | `float` | Multiplicative factor: `Max *= MultiplicativeValue` |

### 6.3 Client-Side Callbacks

```
Source  Private/Core/StatsX_StatsComponentBase.cpp:1543-1604
```

| Callback | Action |
|---|---|
| `PostReplicatedAdd` | Client-only: `MarkAttributeDirty(AttributeTag)` for recalculation |
| `PostReplicatedChange` | `MarkAttributeDirty(AttributeTag)` for recalculation |
| `PreReplicatedRemove` | `MarkAttributeDirty(AttributeTag)` for recalculation |

All three callbacks trigger attribute recalculation rather than applying the
modifier value directly — the client recomputes `Max` from the full modifier
set for consistency.

---

## 7. Status Tag Replication

Stats_X tracks two independent tag containers per component — **casted**
(statuses this actor applied) and **received** (statuses applied to this actor).

### 7.1 FReplicatedTagItem

```
Source  Public/Data/StatsXReplication.h:178-209
```

Single `FGameplayTag Tag` field.  The struct provides **overloaded callbacks**
for both `FReplicatedCastedTagArray` and `FReplicatedReceivedTagArray`.

### 7.2 Casted Tags

```
Source  Public/Data/StatsXReplication.h:218-248
        Private/Core/StatsX_StatsComponentBase.cpp:1993-2052
```

| Callback | Action |
|---|---|
| `PostReplicatedAdd` | Client-only: `CastedStatusesContainer.AddTag(Tag)`, broadcast `OnCastedStatusTagChanged(Tag, true)` |
| `PostReplicatedChange` | No-op (tags are immutable — add/remove only) |
| `PreReplicatedRemove` | Client-only: `CastedStatusesContainer.RemoveTag(Tag)`, broadcast `OnCastedStatusTagChanged(Tag, false)` |

### 7.3 Received Tags

```
Source  Public/Data/StatsXReplication.h:257-287
        Private/Core/StatsX_StatsComponentBase.cpp:2060-2109
```

Identical pattern with `ReceivedStatusesContainer` and
`OnReceivedStatusTagChanged`.

### 7.4 Local Containers

The component maintains two `FGameplayTagContainer` fields for fast client-side
queries:

```cpp
FGameplayTagContainer CastedStatusesContainer;    // synced from ReplicatedCastedTags
FGameplayTagContainer ReceivedStatusesContainer;   // synced from ReplicatedReceivedTags
```

Plus per-tag index caches (`CastedTagIndexCache`, `ReceivedTagIndexCache`)
for O(1) Fast Array item lookup.

---

## 8. Status Seed Replication

Seeds provide **lifecycle boundary notifications** — when a status is added
or removed from the component.

### 8.1 FReplicatedStatusSeedItem

```
Source  Public/Data/StatsXReplication.h:300-328
```

| Field | Type | Purpose |
|---|---|---|
| `StatusID` | `int64` | Unique status instance identifier |
| `bCasted` | `bool` | True for caster-side, false for receiver-side |
| `Seed` | `FStatusSeedData` | Minimal snapshot |

### 8.2 FStatusSeedData (Replicated Payload)

```
Source  Public/Data/StatsXTypes.h:344-376
```

| Field | Type | Purpose |
|---|---|---|
| `StatusID` | `int64` | Identity |
| `StatusTag` | `FGameplayTag` | Status definition tag |
| `ServerStartTimeSeconds` | `float` | Server world time when lifecycle started |
| `MaxDurationSeconds` | `float` | ≤ 0 means infinite |
| `TickIntervalSeconds` | `float` | 0 means non-periodic |
| `MaxIterations` | `int32` | -1 means infinite |
| `StackCount` | `int32` | Current stack count |
| `Revision` | `int32` | Monotonic per-status revision for stale protection |

The seed carries enough data for clients to compute remaining time locally
(`ServerStartTimeSeconds + MaxDurationSeconds - CurrentServerTime`),
eliminating the need for continuous timer replication.

### 8.3 Client-Side Callbacks

```
Source  Private/Data/StatsXReplication.cpp:75-104
```

| Callback | Action |
|---|---|
| `PostReplicatedAdd` | Client-only: broadcast `OnCastedStatusSet` / `OnReceivedStatusSet` with `EStatusSetAction::Added` |
| `PostReplicatedChange` | No-op (lifecycle-oriented; field changes don't emit lifecycle events) |
| `PreReplicatedRemove` | Client-only: broadcast with `EStatusSetAction::Removed` |

### 8.4 EStatusSetAction

```
Source  Public/Data/StatsXTypes.h:289-293
```

| Value | Meaning |
|---|---|
| `Added` | Status just became active |
| `Removed` | Status just expired/was removed |

---

## 9. Status Update Replication

Updates provide **delta event notifications** for non-deducible mutations
(stack changes, refreshes, runtime tuning).

### 9.1 FReplicatedStatusUpdateItem

```
Source  Public/Data/StatsXReplication.h:378-406
```

| Field | Type | Purpose |
|---|---|---|
| `EventID` | `int64` | Monotonic unique identifier per component stream |
| `bCasted` | `bool` | Caster-side or receiver-side |
| `UpdateData` | `FStatusUpdateData` | Delta payload |

### 9.2 FStatusUpdateData (Replicated Payload)

```
Source  Public/Data/StatsXTypes.h:393-423
```

| Field | Type | Purpose |
|---|---|---|
| `StatusID` | `int64` | Target status instance |
| `Revision` | `int32` | Monotonic per-status revision |
| `Reason` | `EStatusUpdateReason` | What triggered this update |
| `ChangedFields` | `int32` (bitmask) | Which fields carry valid data |
| `StackCount` | `int32` | New stack count (if bit set) |
| `ServerStartTimeSeconds` | `float` | New start time (if bit set) |
| `MaxDurationSeconds` | `float` | New duration (if bit set) |
| `TickIntervalSeconds` | `float` | New tick interval (if bit set) |
| `MaxIterations` | `int32` | New max iterations (if bit set) |

### 9.3 EStatusUpdateReason

```
Source  Public/Data/StatsXTypes.h:297-303
```

| Value | Meaning |
|---|---|
| `StackChanged` | Stack count modified |
| `Refreshed` | Duration/timer reset |
| `StackChangedAndRefreshed` | Both |
| `RuntimeTuning` | Programmatic parameter change |

### 9.4 EStatusUpdateField (Bitmask)

```
Source  Public/Data/StatsXTypes.h:307-315
```

| Flag | Value | Field |
|---|---|---|
| `None` | 0 | No fields |
| `StackCount` | 1 | `StackCount` is valid |
| `StartTime` | 2 | `ServerStartTimeSeconds` is valid |
| `MaxDuration` | 4 | `MaxDurationSeconds` is valid |
| `TickInterval` | 8 | `TickIntervalSeconds` is valid |
| `MaxIterations` | 16 | `MaxIterations` is valid |

This bitmask avoids sending full payloads when only one or two fields change.

### 9.5 Event Ordering

```
Source  Private/Data/StatsXReplication.cpp:54-72
        Public/Core/StatsX_StatsComponentBase.h:224-231
```

The status update stream uses **monotonic EventIDs** to prevent
duplicate/out-of-order processing:

```cpp
int64 NextStatusUpdateEventID = 1;                     // server allocator
int64 LastAcceptedCastedStatusUpdateEventID = 0;        // client watermark
int64 LastAcceptedReceivedStatusUpdateEventID = 0;      // client watermark
```

`ShouldAcceptStatusUpdateEvent` rejects events with `EventID ≤ LastAccepted`,
then advances the watermark.  Separate watermarks for casted vs received
streams prevent cross-contamination.

### 9.6 Client-Side Callbacks

```
Source  Private/Data/StatsXReplication.cpp:106-145
```

| Callback | Action |
|---|---|
| `PostReplicatedAdd` | Client-only: check event ordering, broadcast `OnCastedStatusUpdate` / `OnReceivedStatusUpdate` |
| `PostReplicatedChange` | Client-only: same as PostAdd (with ordering check) |
| `PreReplicatedRemove` | No-op (delta stream; remove doesn't carry semantic meaning) |

---

## 10. Client-Side Delegate Summary

```
Source  Public/Core/StatsX_StatsComponentBase.h
```

All delegates are `BlueprintAssignable`:

| Delegate | Parameters | Trigger |
|---|---|---|
| `OnAttributeChanged` | `FGameplayTag AttributeTag, FStatAttribute NewValue` | Attribute value changed |
| `OnCastedStatusTagChanged` | `FGameplayTag StatusTag, bool bAdded` | Casted tag added/removed |
| `OnReceivedStatusTagChanged` | `FGameplayTag StatusTag, bool bAdded` | Received tag added/removed |
| `OnCastedStatusSet` | `FStatusSetData Data` | Casted status lifecycle (Added/Removed) |
| `OnReceivedStatusSet` | `FStatusSetData Data` | Received status lifecycle (Added/Removed) |
| `OnCastedStatusUpdate` | `FStatusUpdateData Data` | Casted status delta event |
| `OnReceivedStatusUpdate` | `FStatusUpdateData Data` | Received status delta event |

---

## 11. Authority Gate Pattern

All Fast Array callbacks share a common guard:

```cpp
static bool ShouldHandleClientReplication(const UStatsX_StatsComponentBase* OwnerComponent)
{
    return OwnerComponent && OwnerComponent->GetOwnerRole() != ROLE_Authority;
}
```

This ensures:
- **Server** → callbacks are no-ops (server already has authoritative state).
- **Client** → callbacks sync local structures and broadcast delegates.

Attribute callbacks additionally guard broadcasts with a role check to handle
edge cases like replication rollbacks where `PostReplicatedChange` may fire
on authority.

---

## 12. Status Instances and Replication

`FStatusInstance` is **not directly replicated**.  Instances exist only on the
server in the `FStatusInstancePool`.  Clients receive:

| What clients see | Source array | What it provides |
|---|---|---|
| Which statuses are active | `ReplicatedStatusSeeds` | StatusID, tag, timing data, stack count |
| Status tags for queries | `ReplicatedCastedTags` / `ReplicatedReceivedTags` | `FGameplayTagContainer` membership |
| Runtime mutations | `ReplicatedStatusUpdates` | Stack changes, refreshes, tuning |
| Attribute effects | `ReplicatedAttributes` / `ReplicatedModifiers` | Final computed values |

This design avoids replicating the full `FStatusInstance` (variable blobs,
PC counters, timers, object pools) — only the minimal data needed for
client-side UI, queries, and cosmetic logic.

---

## 13. Client Sync Retry

```
Source  Public/Core/StatsX_StatsComponentBase.h:260-265
        Private/Core/StatsX_StatsComponentBase.cpp:270-274
```

On `BeginPlay`, non-authority components schedule a `SyncRetryTimerHandle`
to call `SynchronizeLocalAttributes`.  This handles the race condition where
the Fast Array may not be initialized when the component begins play on a
late-joining client.  Once all items are synchronized, the timer is cleared.

---

## 14. Per-Attribute Replication Opt-Out

```
Source  Public/Data/StatsXTypes.h:464-465
        Public/Core/StatsX_StatsComponentBase.h:391-392
```

Each `FStatAttribute` carries a `bReplicated` flag (default `true`).
Attributes with `bReplicated = false` are never inserted into the
`ReplicatedAttributes` Fast Array.  The runtime API
`SetEnableReplicated(AttributeTag, bReplicated)` allows toggling this at
runtime.

Use cases: internal timers, server-only scratch values, debug counters.

---

## 15. Performance Instrumentation

Every callback is wrapped with `STATSX_REPLICATION_SCOPE`:

| Scope | Where |
|---|---|
| `StatsX.Replication.Attribute.PostAdd` | Attribute add |
| `StatsX.Replication.Attribute.PostChange` | Attribute change |
| `StatsX.Replication.Attribute.PreRemove` | Attribute remove |
| `StatsX.Replication.Modifier.PostAdd` | Modifier add |
| `StatsX.Replication.Modifier.PostChange` | Modifier change |
| `StatsX.Replication.Modifier.PreRemove` | Modifier remove |
| `StatsX.Replication.CastedTag.PostAdd` | Casted tag add |
| `StatsX.Replication.CastedTag.PreRemove` | Casted tag remove |
| `StatsX.Replication.ReceivedTag.PostAdd` | Received tag add |
| `StatsX.Replication.ReceivedTag.PreRemove` | Received tag remove |
| `StatsX.Replication.StatusSeed.PostAdd` | Seed add |
| `StatsX.Replication.StatusSeed.PreRemove` | Seed remove |
| `StatsX.Replication.StatusUpdate.PostAdd` | Update add |
| `StatsX.Replication.StatusUpdate.PostChange` | Update change |

---

## 16. Design Decisions

| Decision | Rationale |
|---|---|
| **6 independent Fast Arrays** | Each domain (attributes, modifiers, tags, seeds, updates) has different change frequency and payload size — separate arrays allow UE5's delta serializer to optimize each independently |
| **No conditional replication** | All gameplay state is relevant to all connected clients (UI, queries, predictions) |
| **No OnRep_ callbacks** | Fast Array item callbacks provide finer granularity (per-item add/change/remove) vs monolithic OnRep |
| **Separate casted/received tag arrays** | Different gameplay meaning, independent lifecycle, separate delegate bindings |
| **Seed + Update split** | Seeds (lifecycle) are few and long-lived; updates (deltas) are frequent and transient — different replication profiles |
| **Monotonic EventID ordering** | Prevents duplicate/out-of-order update processing on clients without needing sequence ACKs |
| **bReplicated per-attribute opt-out** | Saves bandwidth for server-only scratch values without requiring separate non-replicated storage |
| **MarkAttributeDirty (modifiers)** | Clients recompute attribute Max from full modifier set rather than applying individual modifier deltas — guarantees consistency |
| **Status instances not replicated** | Variable blobs, PC counters, object pools are server-only execution state — clients only need observable results |

---

## 17. See Also

| Document | Relationship |
|---|---|
| [02 — Attribute System](02_Attribute_System.md) | Attributes being replicated |
| [03 — Modifier System](03_Modifier_System.md) | Modifiers being replicated |
| [05 — Status Instance](05_Status_Instance.md) | Server-side instances (not replicated directly) |
| [10 — Component System](10_Component_System.md) | Component that owns the replicated arrays |
| [18 — Cosmetic Cue Routing](18_Cosmetic_Cue_Routing.md) | Separate cosmetic replication channel |
| [21 — Network Cue Relay](21_Network_Cue_Relay.md) | NetCueRelay actor replication |
