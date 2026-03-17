# 09 — Instruction Format

> **Stats_X v1.404** — FStatusInstruction
> 128-bit fixed-width bytecode instruction: 4 per cache line, zero-parse
> decode, bit-packed payload with continuation overflow.

---

## Table of Contents

1. [Design Goals](#1-design-goals)
2. [Binary Layout](#2-binary-layout)
3. [OpCode Field](#3-opcode-field)
4. [Flags Field](#4-flags-field)
5. [Payload Region](#5-payload-region)
6. [Bit Manipulation API](#6-bit-manipulation-api)
7. [Data Type Helpers](#7-data-type-helpers)
8. [Data Operand Encoding](#8-data-operand-encoding)
9. [Inline Literal Packing Variants](#9-inline-literal-packing-variants)
10. [Output Operand Encoding](#10-output-operand-encoding)
11. [Continuation Instructions](#11-continuation-instructions)
12. [Packing Examples — Real Handlers](#12-packing-examples--real-handlers)
13. [System OpCode Layouts](#13-system-opcode-layouts)
14. [Cache Line Alignment](#14-cache-line-alignment)
15. [Serialisation & Hashing](#15-serialisation--hashing)
16. [Debug Utilities](#16-debug-utilities)
17. [Compile-Time Guarantees](#17-compile-time-guarantees)
18. [Struct Reference](#18-struct-reference)

---

## 1. Design Goals

| Goal | Implementation |
|------|----------------|
| **Cache efficiency** | 16 bytes → exactly 4 instructions per 64-byte L1 cache line |
| **Zero-parse decode** | Bit extraction via shift+mask — no string parsing, no deserialization |
| **Fixed width** | Every instruction is exactly 128 bits — no variable-length encoding |
| **Compile-time verification** | `static_assert(sizeof(FStatusInstruction) == 16)` |
| **Overflow handling** | Continuation slots for nodes needing > 104 bits of payload |
| **Endian-safe packing** | All operations work on native `uint64` — no byte swapping needed |

---

## 2. Binary Layout

```
                            128 bits (16 bytes)
┌──────────────────────────────────────────────────────────────────┐
│                          FStatusInstruction                      │
├──────────────────────────────────────────────────────────────────┤
│  Data0 (uint64)                          │  Data1 (uint64)      │
│                                          │                      │
│  ┌────────┬────────┬─────────────────┐   │  ┌────────────────┐  │
│  │ OpCode │ Flags  │  Payload Part 1 │   │  │ Payload Part 2 │  │
│  │ [0:15] │[16:23] │   [24:63]       │   │  │   [0:63]       │  │
│  │ 16 bit │ 8 bit  │   40 bits       │   │  │   64 bits      │  │
│  └────────┴────────┴─────────────────┘   │  └────────────────┘  │
│                                          │                      │
│  Total payload: 40 + 64 = 104 bits       │                      │
└──────────────────────────────────────────────────────────────────┘
```

### Field Summary

| Field | Data Slot | Bits | Width | Range |
|-------|-----------|------|-------|-------|
| **OpCode** | `Data0` | 0–15 | 16 bits | 0–65 535 |
| **Flags** | `Data0` | 16–23 | 8 bits | 0–255 |
| **Payload 1** | `Data0` | 24–63 | 40 bits | Node-specific |
| **Payload 2** | `Data1` | 0–63 | 64 bits | Node-specific |

---

## 3. OpCode Field

```
Data0[0:15] — 16 bits
```

```cpp
uint16 GetOpCode() const
{
    return static_cast<uint16>(Data0 & 0xFFFF);
}

void SetOpCode(uint16 OpCode)
{
    Data0 = (Data0 & ~0xFFFF) | static_cast<uint64>(OpCode);
}
```

### OpCode Ranges

| Range | Purpose | Dispatch |
|-------|---------|----------|
| 0–31 | System OpCodes (VM control flow) | Inline `switch` in `ExecuteSystemOp()` |
| 32–9 999 | Built-in node handlers | `Handlers[OpCode]` function pointer |
| 10 000–65 535 | User / custom handlers | `Handlers[OpCode]` function pointer |

The 16-bit width supports 65 536 unique operations — more than sufficient for the full built-in library plus extensive user extensions.

---

## 4. Flags Field

```
Data0[16:23] — 8 bits
```

```cpp
uint8 GetFlags() const;
void SetFlags(uint8 Flags);
bool HasFlag(uint8 FlagBit) const;
void SetFlag(uint8 FlagBit, bool bValue);
```

### Defined Flags

| Bit | Constant | Value | Description |
|-----|----------|-------|-------------|
| 0 | `HasContinuation` | `0x01` | Next instruction(s) are pure data — not to be executed |
| 1 | `DebugBreak` | `0x02` | Trigger editor breakpoint before execution |
| 2–4 | *(reserved)* | — | Continuation slot count (0–7) |
| 5 | `NestedAsync` | `0x20` | Async node inside another async flow block |
| 6–7 | *(reserved)* | — | Available for future use |

### Continuation Slot Count

Bits 2–4 of the Flags field encode the number of `OP_ContinueData` instructions that follow this instruction (0–7 slots).  Combined with the `HasContinuation` flag, this tells the handler exactly how many additional instruction-slots to read.

### NestedAsync Flag

Set when an async node (Delay, WaitForEvent, etc.) is nested inside another async flow block.  The VM uses this to correctly handle suspension state when multiple async operations are composed.

---

## 5. Payload Region

The 104-bit payload region (`Data0[24:63]` + `Data1[0:63]`) is entirely **node-specific**.  There is no universal layout — each node type defines its own bit packing scheme.

### Typical Payload Patterns

| Pattern | Bits Used | Description |
|---------|-----------|-------------|
| **Single operand** | 18 bits | `[Source:2][Payload:16]` — one data input |
| **Dual operand** | 36 bits | Two `[Source:2][Payload:16]` pairs |
| **Inline float + operand** | 52 bits | `[Source:2][Float32:32]` + `[Source:2][Payload:16]` |
| **Jump target** | 16 bits | Instruction index for control flow |
| **Dual inline float** | 68 bits | Two `[Source:2][Float32:32]` pairs |
| **Inline float + enum + output** | ~52 bits | Float operand + comparison method + output offset |

The compiler is free to pack fields in any arrangement that fits the 104-bit budget.  The handler and compiler must agree on the bit layout — there is no self-describing metadata in the instruction itself.

---

## 6. Bit Manipulation API

### ExtractBits — Read

```cpp
FORCEINLINE uint64 ExtractBits(uint8 DataSlot, uint8 StartBit, uint8 BitCount) const
{
    const uint64 Data = (DataSlot == 0) ? Data0 : Data1;
    const uint64 Mask = (BitCount >= 64) ? ~0ULL : ((1ULL << BitCount) - 1);
    return (Data >> StartBit) & Mask;
}
```

| Parameter | Description |
|-----------|-------------|
| `DataSlot` | 0 = `Data0`, 1 = `Data1` |
| `StartBit` | Bit position within the 64-bit slot (0–63) |
| `BitCount` | Number of bits to extract (1–64) |
| **Returns** | Extracted value, zero-extended to `uint64` |

### InsertBits — Write

```cpp
FORCEINLINE void InsertBits(uint8 DataSlot, uint8 StartBit, uint8 BitCount, uint64 Value)
{
    uint64& Data = (DataSlot == 0) ? Data0 : Data1;
    const uint64 Mask = (BitCount >= 64) ? ~0ULL : ((1ULL << BitCount) - 1);
    const uint64 ClearMask = ~(Mask << StartBit);
    Data = (Data & ClearMask) | ((Value & Mask) << StartBit);
}
```

The clear-then-set pattern ensures previously packed bits are not corrupted when inserting new values.

### Signed Extraction

```cpp
FORCEINLINE int64 ExtractSignedBits(uint8 DataSlot, uint8 StartBit, uint8 BitCount) const;
```

Performs sign extension: if the highest extracted bit is set, the upper bits are filled with 1s.  Used for signed jump offsets and signed integer operands.

---

## 7. Data Type Helpers

Built on top of `ExtractBits` / `InsertBits` for common value types:

### Float32

```cpp
float ExtractFloat(uint8 DataSlot, uint8 StartBit) const;
void InsertFloat(uint8 DataSlot, uint8 StartBit, float Value);
```

Extracts/inserts IEEE 754 single-precision float from 32 contiguous bits via `reinterpret_cast` between `uint32` and `float`.

### Half-Precision Float (Float16)

```cpp
float ExtractHalfFloat(uint8 DataSlot, uint8 StartBit) const;
void InsertHalfFloat(uint8 DataSlot, uint8 StartBit, float Value);
```

Uses UE5's `FFloat16` for 16-bit IEEE 754 half-precision.  Useful for compact constants where full precision is not needed (multipliers, durations, thresholds).

### Tag Index (uint16)

```cpp
uint16 ExtractTagIndex(uint8 DataSlot, uint8 StartBit) const;
void InsertTagIndex(uint8 DataSlot, uint8 StartBit, uint16 Index);
```

Convenience wrappers for 16-bit pool indices.  `0xFFFF` (`INVALID_TAG_INDEX`) is the sentinel for "no tag".

### Sentinel Constants

```cpp
static constexpr uint16 INVALID_TAG_INDEX    = 0xFFFF;
static constexpr uint16 INVALID_OBJECT_INDEX = 0xFFFF;
```

---

## 8. Data Operand Encoding

Every data operand in a ForgeVM instruction follows a standard encoding:

### Pool-Index Packing (18 bits)

```
┌───────────┬──────────────────┐
│ Source (2) │  Payload (16)    │ = 18 bits total
└───────────┴──────────────────┘
```

| Source | Payload Meaning |
|--------|-----------------|
| `00` (Literal) | Index into definition literal pool |
| `01` (Context) | Byte offset into ContextStack |
| `10` (Instance) | Byte offset into Instance->InstanceBlob |
| `11` (CallFrame) | Argument index into current function frame |

Read via `Context.ReadValue<T>(Instr, DataSlot, StartBit)`:

```cpp
// Decode
EForgeDataSource Source = (EForgeDataSource)Instr.ExtractBits(DataSlot, StartBit, 2);
uint16 Payload = (uint16)Instr.ExtractBits(DataSlot, StartBit + 2, 16);

// Route
switch (Source)
{
    case Literal:   return ReadLiteral<T>(Payload);
    case Context:   return ReadFromMemory<T>(ContextStack, Payload);
    case Instance:  return ReadFromInstanceBlob<T>(Payload);
    case CallFrame: return ReadCallFrameValue<T>(Payload);
}
```

---

## 9. Inline Literal Packing Variants

For high-frequency numeric types, the compiler can embed the literal value **directly in the instruction bits**, eliminating pool lookups.

### Float32 Packing (34 bits)

```
┌───────────┬──────────────────────────────────┐
│ Source (2) │  Payload (32) — IEEE 754 float   │ = 34 bits
└───────────┴──────────────────────────────────┘
```

When `Source == Literal`: payload is the raw float bits.
When `Source != Literal`: next 16 bits are a byte offset (remaining 16 bits unused).

Read via `Context.ReadInlineFloat(Instr, DataSlot, StartBit)`.

### Int32 Packing (34 bits)

```
┌───────────┬──────────────────────────────────┐
│ Source (2) │  Payload (32) — raw int32        │ = 34 bits
└───────────┴──────────────────────────────────┘
```

Same pattern.  Read via `Context.ReadInlineInt32(Instr, DataSlot, StartBit)`.

### Half-Float Packing (18 bits)

```
┌───────────┬──────────────────┐
│ Source (2) │  Payload (16)    │ = 18 bits
└───────────┴──────────────────┘
```

When `Source == Literal`: payload is IEEE 754 half-precision encoded in `FFloat16`.
When `Source != Literal`: payload is a byte offset.

Read via `Context.ReadInlineHalfFloat(Instr, DataSlot, StartBit)`.

### Packing Trade-Offs

| Packing | Literal Size | Pool Lookup | Best For |
|---------|-------------|-------------|----------|
| Pool-Index (18b) | 16-bit index | Yes (array access) | Repeated constants, complex types |
| Float32 Inline (34b) | 32-bit full | No | Unique float constants |
| Int32 Inline (34b) | 32-bit full | No | Unique integer constants |
| HalfFloat Inline (18b) | 16-bit half | No | Compact constants (±65504 range) |

The compiler chooses the packing strategy based on the value and available bit budget in the instruction.

---

## 10. Output Operand Encoding

Output operands are simpler than inputs — they store only a **16-bit byte offset** with no source flag:

```
┌──────────────────┐
│  Offset (16)     │ = 16 bits
└──────────────────┘
```

The destination (ContextStack vs InstanceBlob) is determined by the node's execution mode:
- **Synchronous nodes** → `WriteOutput<T>(Offset, Value)` → ContextStack
- **Async nodes** → `WriteOutputToInstance<T>(Offset, Value)` → InstanceBlob

Read via `Context.ReadOutputOffset(Instr, DataSlot, StartBit)`.

---

## 11. Continuation Instructions

When a node requires more than 104 bits of payload, the compiler emits **continuation instructions** immediately after the primary instruction.

### Continuation Slot Layout

```
Address   Instruction
───────   ─────────────────────────────────────
PC        Primary instruction (OpCode + Flags + Payload)
PC+1      OP_ContinueData  [128 bits of pure data]
PC+2      OP_ContinueData  [128 bits of pure data]  (if needed)
...       ...
```

### Flag Encoding

| Flag/Bits | Purpose |
|-----------|---------|
| `HasContinuation` (bit 0) | Signals that continuation slots follow |
| Flags bits 2–4 | Continuation slot count (0–7) |

Maximum overflow: 7 × 128 = **896 additional bits**, for a total of 104 + 896 = **1 000 bits** per node.

### Handler Protocol

1. The VM pre-increments `PC` before calling the handler
2. The handler reads continuations via `Context.GetContinuationInstruction(Offset)`:
   - Offset 1 → `Instructions[PC]` (first continuation)
   - Offset 2 → `Instructions[PC + 1]` (second continuation)
3. The handler advances `PC` past the continuation slots after reading

```cpp
// Handler example with 1 continuation slot
const FStatusInstruction* Cont1 = Context.GetContinuationInstruction(1);
float ExtraParam = Cont1->ExtractFloat(0, 0);
uint16 ExtraIndex = (uint16)Cont1->ExtractBits(0, 32, 16);
Context.PC += 1;  // Skip past the continuation slot
```

### OP_ContinueData (OpCode 7)

The `OP_ContinueData` instruction is **never executed** by the VM's dispatch loop.  If the PC ever lands on one (which should not happen in valid bytecode), the system op handler simply increments PC and continues.  Its entire 128 bits are available as pure data for the preceding handler.

---

## 12. Packing Examples — Real Handlers

### Example 1: CompareFloats — Dual Inline Float + Enum

```
CompareFloats(Context, Instr)

Data0 [0:15]   OpCode = CompareFloats
Data0 [16:23]  Flags
Data0 [24:25]  Source A (2 bits)
Data0 [26:57]  Float A  (32 bits — inline IEEE 754)

Data1 [0:1]    Source B (2 bits)
Data1 [2:33]   Float B  (32 bits — inline IEEE 754)
Data1 [34:35]  Source Method (2 bits)
Data1 [36:51]  Comparison Method payload (16 bits)
```

```cpp
float A = Context.ReadInlineFloat(Instr, 0, 24);           // Data0[24:57]
float B = Context.ReadInlineFloat(Instr, 1, 0);            // Data1[0:33]
auto Method = Context.ReadValue<uint8>(Instr, 1, 34);      // Data1[34:51]
```

Total payload used: 34 + 34 + 18 = **86 bits** out of 104 available.

### Example 2: UntilDeprecationBehavior — Single Inline Float

```
Data0 [0:15]   OpCode
Data0 [16:23]  Flags
Data0 [24:63]  (node-specific control data)

Data1 [0:1]    Source Duration (2 bits)
Data1 [2:33]   Duration float (32 bits — inline IEEE 754)
```

```cpp
const float Duration = Context.ReadInlineFloat(Instr, 1, 0);  // Data1[0:33]
```

### Example 3: Generic Input Operand — Pool-Index Packing

```
Data0 [StartBit]     Source (2 bits)
Data0 [StartBit+2]   Pool index or byte offset (16 bits)
```

```cpp
const EForgeDataSource Source = (EForgeDataSource)Instr.ExtractBits(0, StartBit, 2);
const uint16 Payload = (uint16)Instr.ExtractBits(0, StartBit + 2, 16);
```

18 bits per operand — up to 5 pool-index operands fit in a single 104-bit payload.

---

## 13. System OpCode Layouts

System OpCodes (0–31) have standardised payload layouts defined by the VM:

### OP_Jump (1)

```
Data0 [24:39]  TargetPC (16 bits)
```

### OP_JumpIfFalse (2)

```
Data0 [24:39]  TargetPC (16 bits)
Data0 [40:55]  Condition payload (16 bits)
Data0 [56:63]  Condition source (8 bits — full EForgeDataSource byte)
```

### OP_JumpTable (3)

```
Data0 [24:39]  Case count (16 bits)
Data0 [40:55]  Switch value payload (16 bits)
Data0 [56:63]  Switch value source (8 bits)

Data1 [0:15]   Default jump target (16 bits)

// Followed by N OP_ContinueData instructions:
ContinueData[i]:
  Data0 [24:39]  Case value (16 bits, signed)
  Data0 [40:55]  Jump target (16 bits)
```

### OP_BeginBlock (5)

```
Data0 [24:39]  FlowNodeIdx (16 bits)
Data0 [40:55]  OnCompletedPC (16 bits)

Data1 [0:15]   LoopCount (16 bits, 0 for non-loop blocks)
```

### OP_EndBlock (6)

```
Data0 [24:39]  FlowNodeIdx (16 bits)
```

### OP_EndEventBlock (9)

```
Data0 [24:39]  ReturnDescIdx (16 bits)
```

### OP_CallFunction (10)

```
Data0 [24:39]  TargetIndex (16 bits — must point to OP_BeginEventBlock)
Data0 [40:55]  ArgDescIdx (16 bits, 0xFFFF = no args)

Data1 [0:15]   OutTargetDescIdx (16 bits, 0xFFFF = no outputs)
```

---

## 14. Cache Line Alignment

```
64-byte L1 Cache Line
┌──────────────┬──────────────┬──────────────┬──────────────┐
│  Instr [0]   │  Instr [1]   │  Instr [2]   │  Instr [3]   │
│  16 bytes    │  16 bytes    │  16 bytes    │  16 bytes    │
└──────────────┴──────────────┴──────────────┴──────────────┘
```

- **4 instructions per cache line** — sequential execution benefits from hardware prefetching
- Small status definitions (< 16 instructions) fit entirely in 4 cache lines
- Jump targets within the same cache line have zero cache-miss penalty
- The `TArray<FStatusInstruction>` storage in `UPDA_StatusDefinition` is contiguous — no pointer chasing

### Memory Density

| Metric | Value |
|--------|-------|
| Instruction size | 16 bytes |
| Instructions per cache line | 4 |
| Typical status size | 10–50 instructions |
| Typical status memory | 160–800 bytes |
| 1000 active definitions loaded | ~0.5–4 MB instruction memory |

---

## 15. Serialisation & Hashing

### Serialisation

`FStatusInstruction` is a `USTRUCT(BlueprintType)` with two `UPROPERTY` `uint64` fields.  UE5's default serialisation handles persistence to `UPDA_StatusDefinition` assets automatically — no custom serialiser needed.

### Equality

```cpp
bool operator==(const FStatusInstruction& Other) const
{
    return Data0 == Other.Data0 && Data1 == Other.Data1;
}
```

Two 64-bit comparisons — branch-free on modern CPUs.

### Hashing

```cpp
friend uint32 GetTypeHash(const FStatusInstruction& Instr)
{
    return HashCombine(GetTypeHash(Instr.Data0), GetTypeHash(Instr.Data1));
}
```

Standard UE5 hash combining for use in `TMap`/`TSet` if needed.

---

## 16. Debug Utilities

### ToString()

```
"Op:42 Flags:0x01 Data0:0x00000A2B00010012 Data1:0x0000000000003FFF"
```

### ToBinaryString()

Renders both 64-bit slots as binary with separator marks at OpCode/Flags boundaries:

```
Data0: 0000000010100010|10110000|0000000000010000000000010010
Data1: 0000000000000000000000000000000000000011111111111111
```

Separators are placed at bit 16 (OpCode/Flags boundary) and bit 24 (Flags/Payload boundary) for readability.

---

## 17. Compile-Time Guarantees

```cpp
static_assert(sizeof(FStatusInstruction) == 16,
    "FStatusInstruction must be exactly 16 bytes!");
```

This assertion prevents:
- Compiler padding from inflating the struct beyond 16 bytes
- UPROPERTY metadata from affecting the in-memory layout
- Platform differences from breaking the cache-line alignment assumption

---

## 18. Struct Reference

### FStatusInstruction — Fields

| Field | Type | Bits | Description |
|-------|------|------|-------------|
| `Data0` | `uint64` | 64 | OpCode (0–15) + Flags (16–23) + Payload Part 1 (24–63) |
| `Data1` | `uint64` | 64 | Payload Part 2 (0–63) |

### FStatusInstruction — Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `GetOpCode()` | `→ uint16` | Extract OpCode from Data0[0:15] |
| `SetOpCode()` | `(uint16)` | Set OpCode in Data0[0:15] |
| `GetFlags()` | `→ uint8` | Extract Flags from Data0[16:23] |
| `SetFlags()` | `(uint8)` | Set all 8 flag bits |
| `HasFlag()` | `(uint8) → bool` | Test a specific flag bit |
| `SetFlag()` | `(uint8, bool)` | Set/clear a specific flag bit |
| `ExtractBits()` | `(DataSlot, StartBit, BitCount) → uint64` | Generic bit extraction |
| `InsertBits()` | `(DataSlot, StartBit, BitCount, Value)` | Generic bit insertion |
| `ExtractFloat()` | `(DataSlot, StartBit) → float` | Extract IEEE 754 float32 |
| `InsertFloat()` | `(DataSlot, StartBit, float)` | Insert IEEE 754 float32 |
| `ExtractHalfFloat()` | `(DataSlot, StartBit) → float` | Extract IEEE 754 float16 → float |
| `InsertHalfFloat()` | `(DataSlot, StartBit, float)` | Insert float → IEEE 754 float16 |
| `ExtractSignedBits()` | `(DataSlot, StartBit, BitCount) → int64` | Signed extraction with sign extension |
| `ExtractTagIndex()` | `(DataSlot, StartBit) → uint16` | Extract 16-bit pool index |
| `InsertTagIndex()` | `(DataSlot, StartBit, uint16)` | Insert 16-bit pool index |
| `ToString()` | `→ FString` | Human-readable hex dump |
| `ToBinaryString()` | `→ FString` | Binary representation with field separators |

### EStatusInstructionFlags

| Constant | Value | Description |
|----------|-------|-------------|
| `None` | `0x00` | No flags set |
| `HasContinuation` | `0x01` | Next instruction(s) are continuation data |
| `DebugBreak` | `0x02` | Trigger editor breakpoint |
| *(bits 2–4)* | — | Continuation slot count (0–7) |
| `NestedAsync` | `0x20` | Async node nested in async flow block |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `INVALID_TAG_INDEX` | `0xFFFF` | Sentinel: no tag |
| `INVALID_OBJECT_INDEX` | `0xFFFF` | Sentinel: no object |

---

*Stats_X v1.404 — Instruction Format*
