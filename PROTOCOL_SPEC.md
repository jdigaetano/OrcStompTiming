# Reader Control Protocol v1.1 (Yanzeo/M100)

## 1. Basic Frame Format (Section 2.2)
All communication follows this byte structure:
`[SOI] [ADR_L] [ADR_M] [CID1] [CID2/RTN] [LENGTH] [INFO...] [CHKSUM]`

- **SOI (Start of Information)**: `0x7C` (Command), `0xCC` (Response)
- **ADR (Address)**: `0xFFFF` (Public Broadcast)
- **CID1**: Data Type Description
- **CID2**: Action Type (Command)
- **RTN**: Return Code (Response)
    - `0x00`: Succeed
    - `0x01`: Fail
    - `0x32`: Auto send to SU (Active Mode)
- **LENGTH**: Number of bytes in the `INFO` section.
- **INFO**: Data payload.
- **CHKSUM**: Two's complement of the cumulative sum of ALL bytes in the frame (including SOI).
    - *Calculation*: `Sum = (SOI + ADR + CID1 + CID2 + LENGTH + INFO)`
    - *Final Byte*: `(~(Sum & 0xFF) + 1) & 0xFF`
    - *Note*: The sum of all bytes in a valid frame (including the CHKSUM byte) equals `0x00` (mod 256).

---

## 2. Common Commands

### 2.1 Get Reader Information (Section 4.11)
- **Command**: `CID1: 82H`, `CID2: 32H`, `LEN: 00H`
- **Example Hex**: `7C FF FF 82 32 00 52`
- **Response Info**: Includes ASCII string for Type (TP), Version (VER), and Address (ADDR).

### 2.2 Read Memory Bank (Section 4.7)
- **Command**: `CID1: 12H`, `CID2: 32H`
- **Payload (INFO)**:
    - `MB` (Bank): `00`:Reserved, `01`:EPC, `02`:TID, `03`:User
    - `SA` (Start Address): Word pointer
    - `DL` (Data Length): Word count (1 word = 2 bytes)
- **Example (Read 4 words from User Bank index 6)**:
    `7C FF FF 12 32 03 03 06 04 [CHKSUM]`

### 2.3 Write Memory Bank (Section 4.6)
- **Command**: `CID1: 12H`, `CID2: 31H`
- **Payload (INFO)**:
    - `MB` (Bank): `01`:EPC, `03`:User
    - `SA` (Start Address): Byte/Word pointer
    - `DL` (Data Length): Word count
    - `DT` (Data): The hex data to write
- **Example**: `7C FF FF 12 31 0B 03 06 04 [DATA...] [CHKSUM]`

### 2.4 Reader Mode Control (Inferred from Logic)
- **Switch to Answer Mode**: `7C FF FF 01 02 01 01` (CID1:01, CID2:02, LEN:01, INFO:01)
- **Switch to Active Mode**: `7C FF FF 01 02 01 00` (CID1:01, CID2:02, LEN:01, INFO:00)

---

## 3. Observations & Known Errors
- **Error 0x1F**: Occupied / Active Conflict. Occurs when sending commands while the reader is in high-speed Active scanning mode.
- **Checksum Calculation**: `(Byte[1] + Byte[2] + ... + Byte[N-1]) & 0xFF`
- **Active Mode Frame (0x20)**: Reader pushes tag data using `CID1: 20H`. The `INFO` section begins with `EPC_LEN`.
