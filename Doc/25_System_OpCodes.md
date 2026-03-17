# 25 — System OpCodes

> **Stats_X v1.404** — Unreal Engine 5.7

---

## Overview

Every ForgeVM instruction is identified by a `uint16` opcode. The opcode space is partitioned into three ranges:

| Range | Purpose | Namespace |
|---|---|---|
| 0–31 | System opcodes — VM control flow | `ForgeSystemOpCodes` |
| 32–9999 | Built-in node opcodes — shipped with the plugin | `ForgeOpCodes` |
| 10000–65535 | Custom opcodes — auto-generated from `.toon` files | `ForgeOpCodes_Custom` |

System opcodes are handled directly by the VM dispatcher (`ExecuteSystemOp`). Built-in opcodes are dispatched to registered handler functions via `FForgeNodeRegistry_Runtime`. Custom opcodes follow the same handler registration pattern and are regenerated on editor startup.

---

## Execution Results

All opcode handlers return one of the following:

| Result | Meaning |
|---|---|
| `Continue` | Succeeded, advance to next instruction. |
| `Completed` | Execution finished successfully. |
| `Suspended` | Async operation started, will resume later. |
| `Error` | Runtime error occurred. |
| `Aborted` | Execution manually aborted. |

---

## System OpCodes (0–31)

Defined in `ForgeSystemOpCodes.h` under namespace `ForgeSystemOpCodes`.

| Value | Name | Description |
|---|---|---|
| 0 | `OP_Start` | Entry point for VM execution. |
| 1 | `OP_Jump` | Unconditional jump to target instruction. |
| 2 | `OP_JumpIfFalse` | Conditional jump — branches if boolean is false. |
| 3 | `OP_JumpTable` | Switch/jump table for multi-way branching. |
| 4 | `OP_Nop` | No operation (safe placeholder). |
| 5 | `OP_BeginBlock` | Start of a flow control block. |
| 6 | `OP_EndBlock` | End of a flow control block. |
| 7 | `OP_ContinueData` | Continuation data slot (pure data, handler skips). |
| 8 | `OP_BeginEventBlock` | Marker for start of an event/function block. |
| 9 | `OP_EndEventBlock` | End of event/function block — copies return values and pops call frame. |
| 10 | `OP_CallFunction` | Captures arguments, pushes call frame, jumps to function block. |
| 11 | `OP_EndAsyncEvent` | End of async event handler block — returns `Suspended`. |
| 12–31 | *(reserved)* | Reserved for future system opcodes. |

---

## Built-In Node OpCodes (32–9999)

Defined in `ForgeOpCodes_BuiltIn.h` under namespace `ForgeOpCodes`. Organized below by category as annotated in the source.

### Flow

| Value | Name | Description |
|---|---|---|
| 1 | `OP_Start` | Entry point for status execution. |
| 33 | `OP_CallFunction_Node` | Call a function node (compiler-substituted). |
| 34 | `OP_Return` | Return from function (compiler-substituted). |
| 35 | `OP_OnEnd` | Completion marker. |
| 259 | `OP_Casting` | Execute casting behavior with pre-cast checks. |
| 260 | `OP_OneShotBehavior` | Execute a one-time behavior block. |
| 261 | `OP_LoopBehavior` | Execute repeating behavior with tick interval. |
| 264 | `OP_UntilDeprecationBehavior` | Execute until duration expires. |
| 297 | `OP_End` | End execution flow. |
| 298 | `OP_Continue` | Continue to next loop iteration. |
| 299 | `OP_Break` | Break out of current loop. |
| 312 | `OP_DoOnce` | Execute logic once, then gate it. |
| 314 | `OP_Gate` | Gate logic flow open/closed. |
| 321 | `OP_PlayMontage` | Play animation montage with event callbacks. |
| 330 | `OP_WaitForEvent` | Suspend until a single event signal. |
| 331 | `OP_GateOpen` | Open a gate to allow flow. |
| 332 | `OP_GateClose` | Close a gate to block flow. |
| 333 | `OP_GateToggle` | Toggle gate state. |
| 334 | `OP_DoOnceReset` | Reset a DoOnce gate. |
| 371 | `OP_WaitForEvents` | Suspend until multiple event signals. |
| 372 | `OP_OnEventTriggered` | Compile-time marker for event trigger (no runtime handler). |
| 381 | `OP_WhileLoop` | Execute while condition is true. |
| 391 | `OP_ForEachActorInRange` | Loop through actors in spatial range. |

### Check

| Value | Name | Description |
|---|---|---|
| 257 | `OP_CustomCheck` | Execute custom check logic (Blueprint-defined). |
| 258 | `OP_CheckCost` | Check if caster has resources for action. |
| 265 | `OP_CheckAttributeRequirement` | Check attribute meets requirement. |
| 266 | `OP_CheckTags` | Check for gameplay tags. |
| 267 | `OP_CheckChance` | Check random chance (percentage). |
| 268 | `OP_CompareFloats` | Compare two float values. |
| 273 | `OP_CompareIntegers` | Compare two integer values. |
| 311 | `OP_Branch` | Conditional branch (if/else). |

### Flow Control

| Value | Name | Description |
|---|---|---|
| 317 | `OP_IsValid` | Check if object/actor is valid. |

### Action

| Value | Name | Description |
|---|---|---|
| 256 | `OP_CustomAction` | Execute custom action logic (Blueprint-defined). |
| 262 | `OP_CallPropagationPreEvents` | Call pre-propagation event handlers. |
| 263 | `OP_CallPropagationPostEvents` | Call post-propagation event handlers. |
| 269 | `OP_AddModifier` | Add modifier to attribute. |
| 270 | `OP_CastStatus` | Cast a status effect on target. |
| 271 | `OP_CalculateMitigation` | Calculate damage mitigation (see [22 — Damage Mitigation](22_Damage_Mitigation.md)). |
| 272 | `OP_ModifyAttribute` | Modify attribute value (delta apply). |
| 274 | `OP_RemoveModifier` | Remove modifier from attribute. |
| 275 | `OP_RefreshStatusByTag` | Refresh status effects by gameplay tag. |
| 276 | `OP_RegisterLocalInterceptor` | Register local (instance) event interceptor. |
| 277 | `OP_RegisterGlobalInterceptor` | Register global event interceptor. |
| 278 | `OP_RefreshStatusbyID` | Refresh specific status by ID. |
| 322 | `OP_RemoveStatusByID` | Remove status effect by ID. |
| 323 | `OP_RemoveStatusByTag` | Remove status effects by tag. |
| 325 | `OP_SendEvent` | Send event to target. |
| 326 | `OP_SpawnActorFromClass` | Spawn actor from class. |
| 327 | `OP_SpawnVFX` | Spawn visual effects. |
| 328 | `OP_UnregisterGlobalInterceptor` | Unregister global interceptor. |
| 329 | `OP_UnregisterLocalInterceptor` | Unregister local interceptor. |
| 335 | `OP_StopVFX` | Stop visual effects. |
| 336 | `OP_UpdateVFX` | Update visual effects parameters. |
| 337 | `OP_SpawnSFX` | Spawn sound effects. |
| 338 | `OP_StopSFX` | Stop sound effects. |
| 349 | `OP_LineTraceByChannel` | Perform line trace / raycast. |
| 365 | `OP_SetActorLocation` | Set actor world location. |
| 366 | `OP_SetActorRotation` | Set actor world rotation. |
| 367 | `OP_InterpActorLocation` | Interpolate actor location over time. |
| 370 | `OP_DestroyActor` | Destroy actor. |
| 379 | `OP_AddStatusStacksByID` | Add status stacks by ID. |
| 380 | `OP_AddStatusStacksByTag` | Add status stacks by tag. |
| 382 | `OP_SetAttribute` | Set attribute to exact value. |
| 390 | `OP_SpawnVFXAttachedtoActor` | Spawn VFX attached to actor. |

### Pure (Getters & Queries)

| Value | Name | Description |
|---|---|---|
| 279 | `OP_GetAttributeValue` | Get current attribute value. |
| 280 | `OP_GetDistance` | Calculate distance between two actors. |
| 293 | `OP_GetCasterActor` | Get casting actor reference. |
| 294 | `OP_GetTargetActor` | Get target actor reference. |
| 295 | `OP_GetCasterStatsComponent` | Get caster's stats component. |
| 296 | `OP_GetTargetStatsComponent` | Get target's stats component. |
| 315 | `OP_GetStatusRemainingTime` | Get remaining duration of status. |
| 316 | `OP_GetStatusStacksByID` | Get stack count of status by ID. |
| 339 | `OP_ThisID` | Get current status instance ID. |
| 341 | `OP_GetSocket` | Get actor socket location. |
| 342 | `OP_GetActorForwardVector` | Get actor forward vector. |
| 343 | `OP_GetActorRightVector` | Get actor right vector. |
| 344 | `OP_GetActorUpVector` | Get actor up vector. |
| 345 | `OP_GetActorLocation` | Get actor world location. |
| 346 | `OP_GetActorRotation` | Get actor world rotation. |
| 347 | `OP_GetActorScale` | Get actor world scale. |
| 348 | `OP_GetActorTransform` | Get actor world transform. |
| 350 | `OP_BreakHitResult` | Extract data from line trace hit result. |
| 353 | `OP_GetComponentByTag` | Get component by gameplay tag. |
| 354 | `OP_GetComponentByClass` | Get component by class. |
| 355 | `OP_GetComponentForwardVector` | Get component forward vector. |
| 356 | `OP_GetComponentRightVector` | Get component right vector. |
| 357 | `OP_GetComponentUpVector` | Get component up vector. |
| 358 | `OP_GetComponentTransform` | Get component world transform. |
| 359 | `OP_GetComponentLocation` | Get component world location. |
| 360 | `OP_GetComponentRotation` | Get component world rotation. |
| 361 | `OP_GetComponentScale` | Get component world scale. |
| 369 | `OP_DoesImplementInterface` | Check if object implements interface. |
| 378 | `OP_GetStatusStacksByTag` | Get stack count of status by tag. |
| 392 | `OP_GetOtherComponent` | Get other component from reference. |

### Pure (Math)

| Value | Name | Description |
|---|---|---|
| 281 | `OP_LiteralFloat` | Push float literal value. |
| 282 | `OP_Add` | Add two floats. |
| 283 | `OP_Subtract` | Subtract two floats. |
| 284 | `OP_Multiply` | Multiply two floats. |
| 285 | `OP_Divide` | Divide two floats. |
| 286 | `OP_Clamp` | Clamp float to min/max range. |
| 287 | `OP_Power` | Power / exponent function. |
| 288 | `OP_RandomFloatInRange` | Random float within range. |
| 289 | `OP_RandomIntegerInRange` | Random integer within range. |
| 290 | `OP_FloatToInteger` | Convert float to integer. |
| 291 | `OP_IntToFloat` | Convert integer to float. |
| 303 | `OP_Ceil` | Ceiling (round up). |
| 310 | `OP_Abs` | Absolute value. |
| 313 | `OP_Floor` | Floor (round down). |
| 318 | `OP_Lerp` | Linear interpolation between floats. |
| 319 | `OP_Max` | Maximum of two floats. |
| 320 | `OP_Min` | Minimum of two floats. |
| 324 | `OP_Round` | Round to nearest integer. |
| 340 | `OP_MakeTransform` | Create transform from components. |
| 351 | `OP_AddVectors` | Add two vectors. |
| 352 | `OP_MultiplyVF` | Multiply vector by float. |
| 363 | `OP_VLerp` | Vector linear interpolation. |
| 364 | `OP_RLerp` | Rotator linear interpolation. |
| 368 | `OP_NearlyEqualVector` | Check if vectors are nearly equal. |
| 373 | `OP_LiteralBool` | Push boolean literal value. |
| 374 | `OP_AddInt` | Add two integers. |
| 375 | `OP_LiteralInteger` | Push integer literal value. |
| 376 | `OP_LiteralObject` | Push object reference literal. |
| 377 | `OP_LiteralMontage` | Push montage reference literal. |
| 383 | `OP_NormalizeFloat` | Normalize float (divide by max). |
| 384 | `OP_NormalizeVector` | Normalize vector to unit length. |
| 385 | `OP_SubtractInt` | Subtract two integers. |
| 386 | `OP_MultiplyInt` | Multiply two integers. |
| 387 | `OP_SubtractVector` | Subtract two vectors. |
| 388 | `OP_MultiplyVector` | Multiply vector component-wise. |
| 389 | `OP_DivideVector` | Divide vector by scalar. |
| 393 | `OP_CompareObjects` | Compare two objects for equality. |

### Variables

| Value | Name | Description |
|---|---|---|
| 304 | `OP_SetVariable` | Set local variable value. |
| 305 | `OP_GetVariable` | Get local variable value. |

### Variables — Array

| Value | Name | Description |
|---|---|---|
| 306 | `OP_ArrayAdd` | Add element to array. |
| 307 | `OP_ArrayGetAt` | Get array element by index. |
| 308 | `OP_ArrayLength` | Get array length. |

### Event / Function

| Value | Name | Description |
|---|---|---|
| 309 | `OP_Function` | Define / call function block. |

### Debug

| Value | Name | Description |
|---|---|---|
| 292 | `OP_PrintString` | Print debug string to log. |
| 300 | `OP_FloatToString` | Convert float to string. |
| 301 | `OP_IntToString` | Convert integer to string. |
| 302 | `OP_ObjectNameToString` | Convert object name to string. |
| 362 | `OP_VectorToString` | Convert vector to string. |

---

## Custom OpCodes (10000+)

Defined in `ForgeOpCodes_Custom.h` under namespace `ForgeOpCodes_Custom`. This file is **auto-generated** from Custom Node Definition files (`.toon`) and regenerated on editor startup.

| Property | Value |
|---|---|
| Start value | `USER_OPCODE_START = 10000` |
| Maximum value | `65535` (uint16 limit) |
| Source | `.toon` files in the project |
| Generation | Automatic on editor startup |

The base installation ships with an empty custom opcode namespace. Custom node definitions added to the project are assigned sequential opcode values starting at 10000.

---

## Variable Pool Types

Defined in `ForgeSystemOpCodes.h` under namespace `ForgePoolType`. These identifiers specify the data type of ForgeVM variable pool slots.

| Value | Name | Engine Type |
|---|---|---|
| 0 | `Pool_Float` | `float` |
| 1 | `Pool_Int` | `int32` |
| 2 | `Pool_Bool` | `bool` |
| 3 | `Pool_Byte` | `uint8` |
| 4 | `Pool_Name` | `FName` |
| 5 | `Pool_String` | `FString` |
| 6 | `Pool_Vector` | `FVector` |
| 7 | `Pool_Rotator` | `FRotator` |
| 8 | `Pool_Transform` | `FTransform` |
| 9 | `Pool_Tag` | `FGameplayTag` |
| 10 | `Pool_Object` | `UObject*` |
| 11 | `Pool_Class` | `UClass*` |
| 12 | `Pool_SoftObject` | `TSoftObjectPtr` |
| 13 | `Pool_SoftClass` | `TSoftClassPtr` |
| 14 | `Pool_Struct` | `UScriptStruct` instance |

---

## Summary

| Range | Count | Description |
|---|---|---|
| System (0–11) | 12 | VM control flow. |
| Reserved (12–31) | 20 | Reserved for future system opcodes. |
| Built-in (1–393) | 121 | Shipped node handlers. |
| Custom (10000+) | variable | Project-defined via `.toon` files. |

**Source files:**

| File | Content |
|---|---|
| `Public/Data/ForgeSystemOpCodes.h` | System opcodes and pool type identifiers. |
| `Public/Generated/ForgeOpCodes_BuiltIn.h` | Built-in node opcode constants. |
| `Public/Generated/ForgeOpCodes_Custom.h` | Auto-generated custom opcode constants. |
| `Private/VM/ForgeVM.cpp` | System opcode execution (`ExecuteSystemOp`). |
| `Private/Nodes/Nodes_Core.cpp` | Built-in node handler implementations and registry. |
