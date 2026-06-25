# Reader Control Protocol v1.1 — Source of Truth

Source: `Reader Control Procotol_v1.1.pdf` ("New 900MHz Reader Control Protocol User Manual", rev 2015/01/28). Manufacturer site string burned into reader firmware: `www.aosid.com`. This document is the copy/print-locked PDF in this repo — text was extracted directly with `pdftotext -layout` (the lock is a viewer permission flag, not encryption, so extraction is clean and reliable).

Confirmed against real hardware: a "Get Basic Information" reply was decoded byte-for-byte on 2026-06-24 (reader type `ABQ`, firmware `V1.22`, address `65535`/broadcast), and the frame checksum matched the algorithm below exactly. Section 4.11 below is empirically verified, not just transcribed.

Every section below is transcribed from the manual unless explicitly called out in [Section 6](#6-set-aside--not-in-this-manual) as field-observed/unverified.

---

## 1. Transport Basics (Section 1)

- Protocol supports RS232 / RS485 / TCPIP. Async, 1 start bit, 8 data bits, 1 stop bit, no parity. 9.6kb/s baud (RS232/485 context — this app talks to the reader over Web Bluetooth, which tunnels these same framed bytes over a BLE characteristic, so the serial baud rate doesn't directly apply, but the frame/checksum format is identical regardless of transport).
- SU (Supervision Unit) = the PC/controller (this app). SM (Supervisory Module) = the reader.
- Master-slave: SU sends a command, SM responds. If SU doesn't get a response (or gets a bad one) within 1s, treat the exchange as failed.

## 2. Frame Format (Section 2)

All communication uses this byte structure:

`[SOI] [ADR_LSB] [ADR_MSB] [CID1] [CID2/RTN] [LENGTH] [INFO...] [CHKSUM]`

| Field | Size | Meaning |
|---|---|---|
| **SOI** | 1B | Start of Information. `0x7C` = Command (SU→SM), `0xCC` = Response (SM→SU) |
| **ADR** | 2B | Equipment address, **little-endian** (LSB byte first, then MSB byte). `0x0001`–`0xFFFE` = device-specific address, `0xFFFF` = public broadcast, `0x0000` = reserved |
| **CID1** | 1B | Command: data-type identification code. Response: echoes the command's CID1 |
| **CID2 / RTN** | 1B | Command: action-type code. Response: **Return code** — see Table 2-3 below |
| **LENGTH** | 1B | Byte count of the `INFO` section only (does not include itself, CHKSUM, or the header) |
| **INFO** | `LENGTH` bytes | Command parameters / response payload |
| **CHKSUM** | 1B | See checksum algorithm below |

**Table 2-3 — RTN return codes (response only):**

| Value | Meaning |
|---|---|
| `0x00` | Succeed |
| `0x01` | Fail |
| `0x32` | Auto send to SU — the reader is pushing data unsolicited (this is what Work Mode = Active produces; see Section 4.8) |

These three are the **only** RTN codes defined anywhere in this manual. (Compare [Section 6](#6-set-aside--not-in-this-manual).)

### Checksum (Section 2.3)

Sum every byte in the frame **except the checksum byte itself** (i.e. SOI through the last INFO byte), take mod 256, then two's-complement it:

```c
unsigned char Checksum(unsigned char *uBuff, unsigned char uBuffLen) {
    unsigned char i, uSum = 0;
    for (i = 0; i < uBuffLen; i++) {
        uSum = uSum + uBuff[i];
    }
    uSum = (~uSum) + 1;
    return uSum;
}
```

Equivalently: a complete, valid frame (including its own CHKSUM byte) always sums to `0x00 mod 256`. This is exactly what `BleDriver.js` implements for both signing outgoing commands and validating incoming frames — confirmed correct against the manual's worked example (`CC 02 01 B1 22 04 BB 12 02 03` → checksum `88`) and against the user's real Get-Version reply (header+info sum `0xFC`, checksum `0x04`, total `0x00`).

## 3. Code Tables (Section 3)

**Table 3-1 — CID1 values (which subsystem a command targets):**

| CID1 | Subsystem |
|---|---|
| `01H` | ISO18000-6B Identify |
| `02H` | ISO18000-6B memory bank action |
| `10H` | EPC (Gen2) Identify Single Tag |
| `11H` | EPC (Gen2) Identify Multiple Tag |
| `12H` | EPC (Gen2) memory bank action |
| `30H` | Encrypted tag |
| `81H` | Basic parameters of reader |
| `82H` | Basic information of reader |
| `8FH` | Software reset |
| `B9H` | TCPIP parameters of reader |
| `BBH` | Remote IO output |

**There is no CID1 value defined for `0x20` anywhere in this table or the manual.** (Compare [Section 6](#6-set-aside--not-in-this-manual) — this matters a lot for this codebase.)

**Table 3-2 — CID2 action codes:**

| CID2 | Action |
|---|---|
| `31H` | Set |
| `32H` | Get |
| `21H` | Set (senior/extended — used by TCPIP and Remote IO) |
| `22H` | Get (senior/extended — used by TCPIP) |

## 4. Full Command Reference (Section 4)

### 4.1 ISO18000-6B Identify
- **Cmd**: CID1=`01H`, CID2=`32H`, INFO: none.
- **Resp**: CID1=`01H`, RTN, INFO: `AN`(1B antenna, default 1) + `UID`(variable, tag's unique ID).

### 4.2 ISO18000-6B Write Memory Bank
- **Cmd**: CID1=`02H`, CID2=`31H`, INFO: `SA`(1B, start address **word** pointer) + `DL`(1B, word count to write) + `DT`(variable, data).
- **Resp**: CID1=`02H`, RTN, INFO: none.

### 4.3 ISO18000-6B Read Memory Bank
- **Cmd**: CID1=`02H`, CID2=`32H`, INFO: `SA`(1B word pointer) + `DL`(1B word count to read).
- **Resp**: CID1=`02H`, RTN, INFO: `AN`(1B) + `DT`(variable, data read).

### 4.4 EPC (Gen2) Identify Single Tag
- **Cmd**: CID1=`10H`, CID2=`32H`, INFO: none.
- **Resp**: CID1=`10H`, RTN, INFO: `AN`(1B) + `EPC`(variable).

### 4.5 EPC (Gen2) Identify Multiple Tag
- **Cmd**: CID1=`11H`, CID2=`32H`, INFO: none.
- **Resp**: CID1=`11H`* (the manual's prose mislabels this response `CID1: 10H`, but its own worked hex example uses `11H`, matching the command sent — this is a typo in the manual itself, not an extraction error), RTN, INFO: `TC`(1B, tag count) then, repeated `TC` times: `S_AN`(1B antenna) + `S_EPC`(variable) + `S_CHK`(1B per-tag checksum). `DL`(1B) = the fixed length of one tag entry (`S_AN`+`S_EPC`+`S_CHK`), `0x0E` in the worked example (1 + 12 + 1 = 14 bytes for a 12-byte EPC).

### 4.6 EPC (Gen2) Write Memory Bank
- **Cmd**: CID1=`12H`, CID2=`31H`, INFO: `MB`(1B bank: `00`=Reserved, `01`=EPC, `02`=TID, `03`=User) + `SA`(1B, start address **byte** pointer — see [Section 5](#5-known-inconsistencies-inside-the-manual-itself), this differs from Read below) + `DL`(1B, word count to write) + `DT`(variable, data).
- **Resp**: CID1=`12H`, RTN, INFO: none.

### 4.7 EPC (Gen2) Read Memory Bank
- **Cmd**: CID1=`12H`, CID2=`32H`, INFO: `MB`(1B, same bank codes as 4.6) + `SA`(1B, start address **word** pointer) + `DL`(1B, word count to read).
- **Resp**: CID1=`12H`, RTN, INFO: `AN`(1B) + `DT`(variable, data read).
- Example: read 4 words from User bank starting at word 6 → `7C FF FF 12 32 03 03 06 04 [CHKSUM]`.

### 4.8 Set Basic Parameter of Reader
- **Cmd**: CID1=`81H`, CID2=`31H`, INFO (28 bytes total, `LENGTH`=`0x1C`):

  | Field | Size | Meaning |
  |---|---|---|
  | PW | 1B | RF power, 0–30 |
  | FHE | 1B | Frequency hopping enabled (0/1) |
  | FFV | 1B | Fixed frequency value (0–200 → 860–960MHz, step 0.5MHz) |
  | FHV1–FHV6 | 6×1B | Frequency hopping table (same 0–200 scale) |
  | **WM** | 1B | **Work Mode** — `0x01`=Command (idle, only responds when polled), `0x02`=Active (auto-broadcasts every read, RTN comes back `0x32`), `0x03`=Passive (holds last read, sends only on request) |
  | RI | 1B | Read interval, ×1ms |
  | TGR | 1B | Trigger enabled (0=Close, 2=Low level effective) |
  | OM | 1B | Output mode: `01`=RS232, `02`=RS485, `03`=TCPIP, `04`=CANBUS, `05`=Syris, `06`=Wiegand26, `07`=Wiegand34 |
  | WG (Offset, Interval, Width, Period) | 4×1B | Wiegand timing, auto-read-mode only |
  | AN | 1B | Antenna select, low 4 bits (bitmask: ant1=`01`, ant3=`04`, ant1+3=`05`, etc.) |
  | RT | 1B | Read type: `01`=ISO18000-6B single, `10`=EPC single, `11`=EPC+ISO18000-6B, `20`=EPC multiple, `40`=EPC+memory bank data |
  | SI | 1B | Same-card resend interval, ×1s |
  | BZ | 1B | Buzzer enabled (0/1) |
  | UD (MB, SA, DL) | 3×1B | Auto-read-mode extra data to send: target bank (`00` RFU/`01` EPC/`02` TID/`03` User), start byte, length — only meaningful when RT=`40` |
  | PE | 1B | Encryption enabled (0/1) |
  | PW (encryption) | 2B | Encryption password, decimal 0000–9999 (e.g. 0123 → `007BH`) |
  | MR | 1B | Max tags per read cycle, 10–64 |

- **Resp**: CID1=`81H`, RTN, INFO: none.
- **This is the real command for switching Active/Command/Passive mode.** The existing mode-switch buttons in `AppUI.js` send a fabricated command instead (`CID1=01H/CID2=02H`, which doesn't exist in Table 3-2) — fixing that is tracked as an action item in the `project-known-issues` memory, not here. Because this Set command overwrites the *entire* 28-byte block, the safe sequence is: **Get** current parameters (4.9) first, flip only the WM byte, then **Set** the full block back — otherwise you'd reset RF power/frequency/etc. to whatever you happened to hardcode.

### 4.9 Get Basic Parameters of Reader
- **Cmd**: CID1=`81H`, CID2=`32H`, INFO: none.
- **Resp**: CID1=`81H`, RTN, INFO: identical 28-byte layout to 4.8's command.

### 4.10 Set Address of Reader
- **Cmd**: CID1=`82H`, CID2=`31H`, INFO: `ADDRESS`(2B, little-endian — e.g. `0xFFFE` sent as bytes `FE FF`).
- **Resp**: CID1=`82H`, RTN, INFO: none.

### 4.11 Get Basic Information of Reader — ✅ verified against real hardware
- **Cmd**: CID1=`82H`, CID2=`32H`, INFO: none. (`7C FF FF 82 32 00 [CHKSUM]`)
- **Resp**: CID1=`82H`, RTN, INFO (34 bytes, `LENGTH`=`0x22`), all ASCII:
  - `Rev` — 16 bytes, reserved/banner field. On this reader: `\nwww.aosid.com 0`.
  - `TP` — 3 bytes, reader type code. On this reader: `ABQ`.
  - `VER` — 5 bytes, firmware version string. On this reader: `V1.22`.
  - `ADDR` — 10 bytes, literal address label text. On this reader: `No.:\n65535` (i.e. still the factory default broadcast address).

### 4.12 Software Reset
- **Cmd**: CID1=`8FH`, CID2=`31H`, INFO: none.
- **Resp**: CID1=`8FH`, RTN, INFO: none.

### 4.13 Encrypted Tag
- **Cmd**: CID1=`30H`, CID2=`31H`, INFO: none.
- **Resp**: CID1=`30H`, RTN, INFO: none.
- The manual's only description: "When the reader is encrypted then you can use this command to encrypt tag." No target/key parameters at all — encryption itself is configured separately via the `PE`/`PW` (encryption-enabled / encryption-password) fields in the Basic Parameters block (Section 4.8 above); this command just triggers the action once that's set up.

### 4.14 Set TCPIP Parameters of Reader
- **Cmd**: CID1=`B9H`, CID2=`21H`, INFO (28 bytes): `IP`(4B) + `MSK`(4B) + `GW`(4B) + `PT`(2B local port) + `MAC`(6B) + `RIP`(4B remote IP) + `RPT`(2B remote port) + `ST`(1B, `00`=Server/`01`=Client) + `PCL`(1B protocol, `00`=TCP/`01`=UDP/`02`=HTTP, TCP-only field).
- **Resp**: CID1=`B9H`, RTN, INFO: none.
- Not relevant to this app (we talk over BLE), kept here for completeness.

### 4.15 Get TCPIP Parameters of Reader
- **Cmd**: CID1=`B9H`, CID2=`22H`, INFO: none.
- **Resp**: CID1=`B9H`, RTN, INFO: identical layout to 4.14's command.

### 4.16 Remote IO Output
- **Cmd**: CID1=`BBH`, CID2=`21H`, INFO: `POINT`(1B, `01`=Relay1/`02`=Relay2) + `ACTION`(1B, `01`=Open/`00`=Close).
- **Resp**: CID1=`BBH`, RTN, INFO: none.

## 5. Known Inconsistencies Inside the Manual Itself

- **Read vs. Write `SA` pointer units differ.** Section 4.6 (EPC Write Memory Bank) explicitly says `SA` is a **byte** pointer; Section 4.7 (EPC Read Memory Bank) explicitly says `SA` is a **word** pointer. Both sections use the identical example value `SA=0x06` against "User bank." If taken literally, a write to `SA=0x06` (byte offset 6 = word 3) and a read from `SA=0x06` (word offset 6 = byte 12) target *different* memory — meaning a naive "write here, read it back from the same SA" check could appear to fail even with a correct implementation. **This directly bears on the open question about `writeBibToTag()`'s encoding assumption** (tracked in memory) — worth testing read-after-write on a real chip with known SA values before trusting either interpretation.
- **Section 4.5.2's response header is mislabeled.** Prose says "CID1: 10H" but the worked hex example for the exact same response uses `11H` (matching the `11H` command that was sent). Trust the hex example; the prose line is a typo in the source manual.

## 6. Set Aside — NOT in This Manual

These are things the existing codebase relies on that this manual does **not** document anywhere. The reader is a cheap clone and may genuinely deviate from or extend this spec, so "not in the manual" isn't the same as "wrong" — these stay open until verified empirically, one way or the other.

(A third item — a fabricated `CID1=01H/CID2=02H` "mode switch" command — used to be tracked here. It's been removed: Table 3-2 is a *closed* list of exactly four CID2 action codes [`31H`/`32H`/`21H`/`22H`], so `02H` is provably not a real command, not just undocumented. Its replacement is fully written up in Section 4.8/4.9 above. The action item to actually fix the code is tracked in the `project-known-issues` memory, not here.)

1. **The unsolicited "Active Mode" tag-read push frame (`CID1=0x20`, INFO starting with an `EPC_LEN` byte) is not documented anywhere in this manual.** No CID1 value `0x20` exists in Table 3-1. The closest match is `RT=0x20` in the Basic Parameters block, which only means "EPC (Gen2) multiple tag" as a *read-type configuration value* — it has no documented relationship to framing an unsolicited push notification. The manual's only statement about Active-mode pushes is that RTN comes back as `0x32` ("Auto send to SU"); it never shows what such a frame's CID1/INFO actually look like. **Status: unverified — this is empirically reverse-engineered from real device traffic, and the entire tag-read pipeline (`BleDriver.parseFrame`/`processValidFrame`) depends on it being right.** Worth sniffing a few more real Active-mode frames against known tags to confirm the EPC_LEN-prefixed layout, especially since the suspected EPC slicing off-by-one (tracked in memory) lives right next to this assumption.

2. **Error code `0x1F`, documented in earlier versions of this file as "Occupied / Active Conflict," does not appear anywhere in this manual.** Table 2-3 defines exactly three RTN values: `00` (Succeed), `01` (Fail), `32` (Auto send to SU). **Status: unverified** — likely an empirical observation from real traffic during the mode-switch/TID-read collision (see memory), not a documented error code. Worth re-confirming once the mode-switch fix lands, since that collision may stop happening.
