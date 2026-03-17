# 10 — Component System

> **Stats_X v1.404** — UStatsX_StatsComponentBase
> Per-actor component that owns attributes, modifiers, thresholds, status
> tracking, interceptors, and damage mitigation — the primary gameplay-facing
> interface of the plugin.

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Class Hierarchy](#2-class-hierarchy)
3. [Lifecycle](#3-lifecycle)
4. [Subsystem Pointers](#4-subsystem-pointers)
5. [Attributes Section](#5-attributes-section)
6. [Modifier Section](#6-modifier-section)
7. [Threshold Section](#7-threshold-section)
8. [Status Tracking](#8-status-tracking)
9. [Status Casting](#9-status-casting)
10. [Status Instance Notifications](#10-status-instance-notifications)
11. [Interceptor Section](#11-interceptor-section)
12. [Forge Event Sending](#12-forge-event-sending)
13. [Damage Mitigation](#13-damage-mitigation)
14. [Replication Model](#14-replication-model)
15. [Debug Facilities](#15-debug-facilities)
16. [IStatsXComponentProvider Interface](#16-istatsxcomponentprovider-interface)
17. [API Reference](#17-api-reference)

---

## 1. Design Philosophy

`UStatsX_StatsComponentBase` is the **single point of contact** between the Stats_X runtime and the gameplay actor.  Every actor that participates in the stat/status system attaches one instance of this component (or a Blueprint subclass).

Key design decisions:

| Decision | Rationale |
|----------|-----------|
| **Does not tick** | `PrimaryComponentTick.bCanEverTick = false`.  All status ticking is driven by `UStatsX_WorldSubsystem` |
| **Replicated by default** | `SetIsReplicatedByDefault(true)`.  Six `FastArraySerializer` properties replicate gameplay state |
| **Blueprintable** | `UCLASS(Blueprintable)`.  Game teams subclass to override `Mitigation_CustomFormula` and add project-specific logic |
| **Server-authoritative** | Modifiers, attributes, and status execution are server-only.  Clients receive replicated state |
| **Tag-driven** | All APIs use `FGameplayTag` for attribute, modifier, status, and event identification |

---

## 2. Class Hierarchy

```
UActorComponent
  └── UStatsX_StatsComponentBase  (also implements IStatsXComponentProvider)
        │
        ├── Attributes       (TMap<FGameplayTag, FStatAttribute>)
        ├── Modifiers         (FReplicatedModifierArray — FastArraySerializer)
        ├── Thresholds        (TMap<int32, FAttributeThreshold>)
        ├── Status Tracking   (Casted/Received handles, tags, seeds, updates)
        ├── Interceptors      (Caster-scope + Target-scope registries)
        └── Damage Mitigation (Flat, Percentage, Diminishing, ExpDecay, Custom)
```

The component implements `IStatsXComponentProvider`, returning `this` directly.  This interface allows objects in status object pools to resolve their associated component without expensive `Cast<>` operations.

---

## 3. Lifecycle

### Construction

```cpp
UStatsX_StatsComponentBase()
{
    SetIsReplicatedByDefault(true);
    PrimaryComponentTick.bCanEverTick = false;
    PrimaryComponentTick.bStartWithTickEnabled = false;
}
```

### OnComponentCreated

Guarantees FastArraySerializer initialisation for components created at runtime (e.g., dynamically added via `AddComponentByClass`):

- `ReplicatedAttributes.Initialize(this)`
- `ReplicatedStatusSeeds.Initialize(this)`
- `ReplicatedStatusUpdates.Initialize(this)`
- Resets stream-order dedup watermarks

### BeginPlay

1. Cache subsystem pointers:
   - `StatsXGameInstanceSubsystem` — for ID generation
   - `StatsXWorldSubsystem` — for status execution and pool access
2. Initialise all six FastArraySerializer properties
3. Schedule client-side sync retry (for late joiners)

### EndPlay

1. Reset all interceptor registries (Caster + Target)
2. Unregister global interceptors via `WorldSubsystem`
3. Clear sync retry timer
4. Reset stream-order watermarks

### GC Integration

```cpp
static void AddReferencedObjects(UObject* InThis, FReferenceCollector& Collector);
```

Manually adds interceptor `UObject` references to the GC collector, since `FInterceptorRegistration` stores `TObjectPtr<UForgeInterceptorBase>` in non-UPROPERTY maps.

---

## 4. Subsystem Pointers

```cpp
UStatsX_GameInstanceSubsystem* StatsXGameInstanceSubsystem;
UStatsX_WorldSubsystem*        StatsXWorldSubsystem;
```

Cached at `BeginPlay` — **do not access before BeginPlay**.  The GameInstanceSubsystem provides `GenerateStatusID()`, the WorldSubsystem provides `ExecuteStatus()`, pool access, and the event system.

---

## 5. Attributes Section

### Storage

```cpp
TMap<FGameplayTag, FStatAttribute> StatsAttributes;
```

Each attribute is a tag-driven triplet: `Current`, `Max`, `Base` + flags (`bOverflows`, `bReplicated`).

### Initialisation API

| Method | Description |
|--------|-------------|
| `InitializeAttribute()` | Full control: Current, Max, Base, bOverflows, bReplicated |
| `InitializeResourceAttribute()` | Resource preset: Current and Max are independent (Health, Mana) |
| `InitializeStatAttribute()` | Stat preset: Current = Max = Value (Speed, Armor) |

All three validate that the tag is a child of `StatsX.Attribute`.  `InitializeResourceAttribute` enforces `StatsX.Attribute.Resource`, `InitializeStatAttribute` enforces `StatsX.Attribute.Stat`.

### Modification API

| Method | Behaviour |
|--------|-----------|
| `ModifyAttribute(Tag, SubTag, Delta, Causer)` | Adds delta to existing value.  Returns actual change after clamping |
| `SetAttribute(Tag, SubTag, NewValue, Causer)` | Overwrites value directly |
| `SetEnableOverflows(Tag, bool)` | Toggles overflow mode at runtime |
| `SetEnableReplicated(Tag, bool)` | Toggles per-attribute replication |

Both `ModifyAttribute` and `SetAttribute` trigger:
1. Clamping (unless `bOverflows` is true)
2. Threshold checks (`CheckAttributeThresholds`)
3. Replication update (`UpdateReplicatedAttribute`)
4. Event broadcast (`OnAttributeChanged`)

### Query API

| Method | Returns |
|--------|---------|
| `GetAttributeValue(Tag)` | Full `FStatAttribute` struct |
| `GetSubAttributeValue(Tag, SubTag)` | Single `float` (Current, Max, or Base) |
| `HasAttribute(Tag)` | `bool` |
| `RemoveAttribute(Tag)` | Removes from map + replication |

### Replication Support

```cpp
FReplicatedAttributeArray ReplicatedAttributes;   // FastArraySerializer
mutable TMap<FGameplayTag, int32> AttributeIndexCache;  // O(1) index lookup
```

- `UpdateReplicatedAttribute()` — upserts the fast array entry for the changed attribute
- `FindReplicatedAttributeIndex()` — O(1) via `AttributeIndexCache`
- `SynchronizeLocalAttributes()` — client-side: applies replicated state to local `StatsAttributes` map
- `ScheduleSyncRetry()` — handles late-joiner sync with up to 10 retry attempts

---

## 6. Modifier Section

### Application API

```cpp
int32 AddModifier(
    FGameplayTag AttributeTag,
    FGameplayTag SourceTag,
    int64 OwnerID,
    float AdditiveValue,
    float MultiplicativeValue = 1.0f);
```

Returns a unique `InstanceID` for the created modifier.  The modifier is added to `ReplicatedModifiers` (FastArraySerializer) and the affected attribute is marked dirty.

### Removal API

| Method | Filter | Returns |
|--------|--------|---------|
| `RemoveModifierByID(InstanceID)` | Exact match | `bool` |
| `RemoveModifiersByOwner(OwnerID)` | All matching OwnerID | Count removed |
| `RemoveModifiersBySource(SourceTag)` | All matching SourceTag | Count removed |
| `RemoveModifiersByAttribute(AttributeTag)` | All on attribute | Count removed |
| `RemoveModifiersWithFilters(Count, ID, Owner, Source, Attr)` | Combined filter | Count removed |

### Query API

| Method | Returns |
|--------|---------|
| `GetModifiersForAttribute(Tag)` | `TArray<FStatModifier>` |
| `GetModifiersByOwner(OwnerID)` | `TArray<FStatModifier>` |
| `GetModifiersBySource(SourceTag)` | `TArray<FStatModifier>` |
| `GetModifierCount()` | `int32` |

### Recalculation Pipeline

```
AddModifier / RemoveModifier
  └─ MarkAttributeDirty(AttributeTag)
       └─ DirtyAttributes.Add(AttributeTag)

RecalculateAllDirtyAttributes()  (called automatically)
  └─ for each dirty tag:
       RecalculateAttribute(Tag)
         └─ Max = (Base + ΣAdditive) × ΠMultiplicative
            Clamp Current to [0, Max] (unless bOverflows)
```

### Index Caches

| Cache | Type | Purpose |
|-------|------|---------|
| `ModifierIDToIndex` | `TMap<int32, int32>` | InstanceID → array index |
| `ModifiersByAttribute` | `TMap<FGameplayTag, TArray<int32>>` | AttributeTag → array indices |

Both are rebuilt via `RebuildModifierIndexCache()` after structural array modifications.

### ID Generation

```cpp
int32 NextModifierID = INT32_MIN + 1;

int32 GenerateModifierID()
{
    int32 ID = NextModifierID++;
    if (NextModifierID == INT32_MAX) NextModifierID = INT32_MIN + 1;
    return ID;
}
```

Wrapping counter using the full `int32` range — billions of unique IDs per component lifetime.

---

## 7. Threshold Section

### Registration API

```cpp
int32 AddAttributeThreshold(const FAttributeThreshold& Threshold);
bool  RemoveAttributeThreshold(int32 Handle);
void  ClearAllThresholds();
void  ClearThresholdsForAttribute(FGameplayTag AttributeTag);
bool  HasActiveThresholds() const;
```

`AddAttributeThreshold` returns a unique handle.  The threshold fires `OnAttributeThresholdReached` when the monitored sub-attribute crosses the configured value.

### Storage

```cpp
TMap<FGameplayTag, TArray<int32>> AttributeToThresholdHandles;  // Tag → handles
TMap<int32, FAttributeThreshold>  ActiveThresholds;              // Handle → data
```

### Check Flow

```
ModifyAttribute / SetAttribute
  └─ CheckAttributeThresholds(AttributeTag, SubAttributeTag, OldValue, NewValue, Causer)
       └─ for each handle on this attribute:
            if threshold crossed → OnAttributeThresholdReached.Broadcast(...)
```

### Event Signature

```cpp
FOnAttributeThresholdReached(
    FGameplayTag AttributeTag,
    FGameplayTag SubAttributeTag,
    float OldValue,
    float NewValue,
    int32 ThresholdHandle,
    AActor* Causer);
```

---

## 8. Status Tracking

The component maintains **dual-sided tracking** — statuses this actor has **casted** and statuses it has **received**.

### Handle Arrays

```cpp
TArray<int32> CastedStatusHandles;    // Pool indices of casted instances
TArray<int32> ReceivedStatusHandles;  // Pool indices of received instances
```

### Tag Containers

```cpp
FGameplayTagContainer CastedStatusesContainer;    // Fast tag queries
FGameplayTagContainer ReceivedStatusesContainer;
```

### Query API

| Method | Match Type |
|--------|------------|
| `HasCastedStatus(Tag)` | Hierarchical |
| `HasReceivedStatus(Tag)` | Hierarchical |
| `HasExactCastedStatus(Tag)` | Exact |
| `HasExactReceivedStatus(Tag)` | Exact |
| `HasAnyCastedStatus(Tags)` | Any match |
| `HasAnyReceivedStatus(Tags)` | Any match |
| `HasAllCastedStatus(Tags)` | All match |
| `HasAllReceivedStatus(Tags)` | All match |

### Replicated Tag Arrays

```cpp
FReplicatedCastedTagArray   ReplicatedCastedTags;     // FastArraySerializer
FReplicatedReceivedTagArray ReplicatedReceivedTags;    // FastArraySerializer
```

Index caches (`CastedTagIndexCache`, `ReceivedTagIndexCache`) provide O(1) lookup for add/remove operations.

### Replicated Status Seeds & Updates

```cpp
FReplicatedStatusSeedArray   ReplicatedStatusSeeds;    // Lifecycle snapshots
FReplicatedStatusUpdateArray ReplicatedStatusUpdates;   // Delta stream
```

- **Seeds** — full snapshot on status add/remove (StackCount, StartTime, MaxDuration, TickInterval, MaxIterations)
- **Updates** — incremental delta stream for stack/refresh/runtime tuning changes
- **Dedup watermarks** — `LastAcceptedCastedStatusUpdateEventID` / `LastAcceptedReceivedStatusUpdateEventID` prevent duplicate processing

### Status Update Field Helpers

```cpp
// C++ fast path (inline bitmask)
static bool HasStatusUpdateFieldFast(int32 ChangedFields, EStatusUpdateField Field);

// Blueprint helpers
bool StatusUpdateHasField(UpdateData, Field);
bool StatusUpdateHasStackCount(UpdateData);
bool StatusUpdateHasStartTime(UpdateData);
bool StatusUpdateHasMaxDuration(UpdateData);
bool StatusUpdateHasTickInterval(UpdateData);
bool StatusUpdateHasMaxIterations(UpdateData);
```

---

## 9. Status Casting

### CastStatusAsync

```cpp
int64 CastStatusAsync(
    FGameplayTag StatusTag,
    AActor* CasterActor,
    AActor* TargetActor,
    const TArray<FForgeVariableOverride>& Overrides);
```

**Flow:**

```
1. Resolve StatusDefinition via soft reference
2. Pre-generate StatusID from GameInstanceSubsystem
3. If asset already loaded:
     ExecuteStatus() immediately → return actual ID
4. If not loaded:
     RequestAsyncLoad() → lambda captures StatusID + weak refs
     On load: ExecuteStatus() in callback
5. Return pre-generated StatusID
```

The async path captures `TWeakObjectPtr` for both actors and the subsystem.  If overrides are present, they are copied into the lambda capture.  If no overrides, a lightweight lambda without extra capture is used.

### CastStatusSync

```cpp
EForgeExecutionResult CastStatusSync(
    FGameplayTag StatusTag,
    AActor* CasterActor,
    AActor* TargetActor,
    const TArray<FForgeVariableOverride>& Overrides);
```

**Flow:**

```
1. Resolve StatusDefinition via soft reference
2. LoadSynchronous() — may cause hitch if not cached
3. GenerateStatusID()
4. ExecuteStatus() immediately
5. Return EForgeExecutionResult
```

**Warning:** Synchronous loading may stall the game thread.  Prefer `CastStatusAsync` for non-critical paths.

### Status Removal

| Method | Scope |
|--------|-------|
| `RemoveAllCastedStatuses(bOnEnd)` | All casted by this component |
| `RemoveAllReceivedStatuses(bOnEnd)` | All received by this component |
| `RemoveCastedStatusesByTag(Tag, bOnEnd)` | Exact tag match, casted |
| `RemoveReceivedStatusesByTag(Tag, bOnEnd)` | Exact tag match, received |

All removal methods delegate to `WorldSubsystem->RemoveStatus()`.  The `bExecuteOnEndEvent` flag controls whether the `OnEnd` event block is dispatched before termination.

---

## 10. Status Instance Notifications

The `WorldSubsystem` calls these methods on the component when instance lifecycle events occur:

### Lifecycle Events

| Method | Trigger |
|--------|---------|
| `NotifyCastedStatus(StatusID, PoolIndex)` | This component casted a status that became an instance |
| `NotifyReceivedStatus(StatusID, PoolIndex)` | This component received a status that became an instance |
| `NotifyStatusRemoved(StatusID, bWasCaster)` | An instance involving this component was removed |
| `NotifyStatusUpdated(UpdateData, bWasCaster)` | Non-deducible runtime update (stack/refresh/tuning) |

### Blueprint Events

```cpp
FOnComponentStatusSet    OnCastedStatusSet;       // Lifecycle boundary (add/remove)
FOnComponentStatusSet    OnReceivedStatusSet;      // Lifecycle boundary (add/remove)
FOnComponentStatusUpdate OnCastedStatusUpdate;     // Delta updates
FOnComponentStatusUpdate OnReceivedStatusUpdate;   // Delta updates
FOnStatusTagChanged      OnCastedStatusTagChanged; // Tag add/remove
FOnStatusTagChanged      OnReceivedStatusTagChanged;
```

### Replication Helpers

| Method | Purpose |
|--------|---------|
| `UpsertReplicatedStatusSeed()` | Add/update seed snapshot for clients |
| `RemoveReplicatedStatusSeed()` | Remove seed snapshot on status end |
| `PushReplicatedStatusUpdate()` | Append delta update to stream |
| `FindReplicatedStatusSeedIndex()` | O(1) lookup via cache |
| `RebuildReplicatedStatusSeedIndexCaches()` | Rebuild after removals |

---

## 11. Interceptor Section

Each component manages **two independent interceptor registries** — one for Caster-scope events, one for Target-scope events.

### Registry Structure (per scope)

```
TMultiMap<FGameplayTag, int32>        EventToHandlesMap;
TMap<int32, FInterceptorRegistration> ActiveRegistrations;
FGameplayTagContainer                 EventsWithInterceptors;  // fast early-exit cache
int32                                 DispatchDepth;           // reentrancy guard
TSet<int32>                           PendingRemovalHandles;   // deferred removal
```

### Registration API

```cpp
int32 RegisterInterceptor(
    const FGameplayTag& EventTag,
    TSubclassOf<UForgeInterceptorBase> InterceptorClass,
    EInterceptorScope Scope,
    int32 Priority,
    AActor* SourceActor,
    UStatsX_StatsComponentBase* SourceComponent,
    int64 SourceStatusID = 0);
```

Returns a handle for later unregistration.  The `SourceStatusID` parameter allows automatic cleanup when the registering status instance terminates.

### Unregistration API

| Method | Scope |
|--------|-------|
| `UnregisterInterceptor(Handle)` | Single interceptor |
| `UnregisterInterceptorsForEvent(Tag, Scope)` | All for event+scope |
| `UnregisterAllInterceptorsFromSource(Component)` | All from source component |
| `UnregisterAllInterceptorsFromStatus(StatusID)` | All from source status |

### Reentrancy Safety

When interceptors are being dispatched (`DispatchDepth > 0`), removal requests are **deferred**:

```
UnregisterInterceptor(Handle)
  └─ if DispatchDepth > 0:
       MarkInterceptorHandlePending(Handle)    // Flag, don't remove
     else:
       RemoveInterceptorHandleImmediate(Handle) // Remove now
```

After dispatch completes, `FlushPendingInterceptorRemovals()` processes all deferred handles.

### Dispatch API

```cpp
bool BroadcastToScope(
    const FGameplayTag& EventTag,
    FForgeVMContext& Context,
    EInterceptorScope Scope,
    EInterceptorEventPhase Phase);
```

Returns `false` if any interceptor halted execution (Cancelled).

### Event Cache

```cpp
FGameplayTagContainer CasterEventsWithInterceptors;
FGameplayTagContainer TargetEventsWithInterceptors;

bool HasInterceptorsForEvents(const FGameplayTagContainer& Events, EInterceptorScope Scope) const;
```

The tag container cache enables **O(1) early exit** — if no interceptors are registered for the requested events, the broadcast is skipped entirely.

---

## 12. Forge Event Sending

```cpp
int32 SendForgeEvent(
    FGameplayTag EventTag,
    const TArray<FForgeVariableOverride>& Payload);
```

Sends a Forge event using the component's owner actor as scope.  Only status instances waiting on the same event tag + scope actor are resumed.  The optional `Payload` is auto-applied as variable overrides on `WaitForEvent` resume.

Returns the number of listeners that were resumed.

---

## 13. Damage Mitigation

The component provides four built-in mitigation formulas plus a Blueprint-overridable custom formula.

### Resistance Mapping

```cpp
TMap<FGameplayTag, FGameplayTagContainer> DamageToResistancesMap;
```

Maps damage types to resistance attribute tags.  Used by all built-in formulas to resolve which attributes reduce incoming damage.

### Built-In Formulas

| Method | Formula | Description |
|--------|---------|-------------|
| `Mitigation_XFlat()` | `Delta - ΣResistanceValues` | Flat reduction |
| `Mitigation_XPercentage()` | `Delta × (1 - ΣResistance/100)` | Percentage reduction |
| `Mitigation_XDiminishing()` | `Delta × ScaleFactor / (ScaleFactor + ΣResistance)` | Diminishing returns |
| `Mitigation_XExponentialDecay()` | `Delta × e^(-ΣResistance/ScaleFactor)` | Exponential decay |

### Scale Factors

```cpp
float DiminishingMitigationScaleFactor = 100.f;
float ExponentialDecayMitigationScaleFactor = 100.f;
```

Both are `EditAnywhere` / `BlueprintReadWrite` — tunable per-actor.

### Custom Formula (Blueprint Override)

```cpp
UFUNCTION(BlueprintImplementableEvent)
float Mitigation_CustomFormula(
    FGameplayTag MitigationFormula,
    float Delta,
    FGameplayTagContainer DamageTypes,
    FGameplayTag AttributeTag,
    FGameplayTag SubAttributeTag,
    UStatsX_StatsComponentBase* CasterComponent,
    FGameplayTag StatusTag,
    int64 StatusID);
```

Full context is provided — the Blueprint implementation has access to the exact status, caster, damage types, and target attribute being modified.

---

## 14. Replication Model

### Replicated Properties

| Property | Type | Content |
|----------|------|---------|
| `ReplicatedAttributes` | `FReplicatedAttributeArray` | Attribute values (per-attribute replication flag) |
| `ReplicatedModifiers` | `FReplicatedModifierArray` | Active modifiers |
| `ReplicatedCastedTags` | `FReplicatedCastedTagArray` | Casted status tags |
| `ReplicatedReceivedTags` | `FReplicatedReceivedTagArray` | Received status tags |
| `ReplicatedStatusSeeds` | `FReplicatedStatusSeedArray` | Status lifecycle snapshots |
| `ReplicatedStatusUpdates` | `FReplicatedStatusUpdateArray` | Status delta stream |

All six use `FastArraySerializer` for delta-compressed replication.

### Registration

```cpp
void GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedAttributes);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedModifiers);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedCastedTags);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedReceivedTags);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedStatusSeeds);
    DOREPLIFETIME(UStatsX_StatsComponentBase, ReplicatedStatusUpdates);
}
```

### Client Sync Retry

Non-authority clients schedule periodic sync retries (up to `MaxSyncRetries = 10`) to handle late-joiner scenarios where the initial replication burst may be incomplete.

---

## 15. Debug Facilities

Available only in `WITH_EDITORONLY_DATA` builds:

```cpp
bool bDebugMode = false;
bool bDebugReplication = false;
bool DebugAttributeChanges = false;
bool DebugModifiers = false;
```

All are `EditAnywhere` / `BlueprintReadWrite` — toggleable per-component instance in the editor Details panel.

---

## 16. IStatsXComponentProvider Interface

```cpp
UINTERFACE(MinimalAPI, BlueprintType)
class UStatsXComponentProvider : public UInterface { ... };

class IStatsXComponentProvider
{
public:
    virtual UStatsX_StatsComponentBase* GetStatsComponent() = 0;
    virtual UStatsX_StatsComponentBase* GetStatsComponentChecked(bool& bOutIsValid);
};
```

**Purpose:** Objects stored in `FStatusInstance::InstanceObjectPool` that need to provide access to their associated component can implement this interface.  This avoids `Cast<>` runtime cost — a simple interface call resolves the component reference.

`UStatsX_StatsComponentBase` itself implements this interface, returning `this`.

---

## 17. API Reference

### Events (Dynamic Multicast Delegates)

| Delegate | Parameters | Fired When |
|----------|-----------|------------|
| `OnAttributeChanged` | `(AttributeTag, NewValue)` | Any attribute modification |
| `OnAttributeThresholdReached` | `(AttributeTag, SubAttributeTag, OldValue, NewValue, Handle, Causer)` | Threshold crossed |
| `OnCastedStatusTagChanged` | `(StatusTag, bAdded)` | Casted tag added/removed |
| `OnReceivedStatusTagChanged` | `(StatusTag, bAdded)` | Received tag added/removed |
| `OnCastedStatusSet` | `(FStatusSetData)` | Casted status lifecycle boundary |
| `OnReceivedStatusSet` | `(FStatusSetData)` | Received status lifecycle boundary |
| `OnCastedStatusUpdate` | `(FStatusUpdateData)` | Casted status delta update |
| `OnReceivedStatusUpdate` | `(FStatusUpdateData)` | Received status delta update |

### Attribute Methods (BlueprintCallable)

| Method | Category |
|--------|----------|
| `InitializeAttribute()` | Initialization |
| `InitializeResourceAttribute()` | Initialization |
| `InitializeStatAttribute()` | Initialization |
| `RemoveAttribute()` | Management |
| `ModifyAttribute()` | Setter |
| `SetAttribute()` | Setter |
| `SetEnableOverflows()` | Setter |
| `SetEnableReplicated()` | Setter |
| `GetAttributeValue()` | Getter |
| `GetSubAttributeValue()` | Getter |
| `HasAttribute()` | Query |

### Modifier Methods (BlueprintCallable)

| Method | Category |
|--------|----------|
| `AddModifier()` | Application |
| `RemoveModifierByID()` | Removal |
| `RemoveModifiersByOwner()` | Removal |
| `RemoveModifiersBySource()` | Removal |
| `RemoveModifiersByAttribute()` | Removal |
| `RemoveModifiersWithFilters()` | Removal |
| `GetModifiersForAttribute()` | Getter |
| `GetModifiersByOwner()` | Getter |
| `GetModifiersBySource()` | Getter |
| `GetModifierCount()` | Getter |

### Threshold Methods (BlueprintCallable)

| Method | Category |
|--------|----------|
| `AddAttributeThreshold()` | Registration |
| `RemoveAttributeThreshold()` | Removal |
| `ClearAllThresholds()` | Bulk removal |
| `ClearThresholdsForAttribute()` | Filtered removal |

### Status Methods (BlueprintCallable)

| Method | Category |
|--------|----------|
| `CastStatusAsync()` | Execution |
| `CastStatusSync()` | Execution |
| `RemoveAllCastedStatuses()` | Removal |
| `RemoveAllReceivedStatuses()` | Removal |
| `RemoveCastedStatusesByTag()` | Removal |
| `RemoveReceivedStatusesByTag()` | Removal |
| `GetStatusData()` | Getter |
| `GetStatusTagFromHandle()` | Getter |
| `GetStatusInstanceRemainingTime()` | Client utility |

### Status Query Methods (BlueprintCallable)

| Method | Match |
|--------|-------|
| `HasCastedStatus()` | Hierarchical |
| `HasReceivedStatus()` | Hierarchical |
| `HasExactCastedStatus()` | Exact |
| `HasExactReceivedStatus()` | Exact |
| `HasAnyCastedStatus()` | Any |
| `HasAnyReceivedStatus()` | Any |
| `HasAllCastedStatus()` | All |
| `HasAllReceivedStatus()` | All |

### Interceptor Methods

| Method | Access |
|--------|--------|
| `RegisterInterceptor()` | C++ |
| `UnregisterInterceptor()` | BlueprintCallable |
| `UnregisterInterceptorsForEvent()` | BlueprintCallable |
| `UnregisterAllInterceptorsFromSource()` | BlueprintCallable |
| `UnregisterAllInterceptorsFromStatus()` | C++ |
| `HasInterceptorsForEvents()` | C++ |
| `GetInterceptorCountForEvent()` | BlueprintCallable |
| `BroadcastToScope()` | C++ |
| `SendForgeEvent()` | BlueprintCallable |

---

*Stats_X v1.404 — Component System*
