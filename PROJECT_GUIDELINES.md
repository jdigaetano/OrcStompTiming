# Orc Stomp Timing: Architectural Guidelines

## 1. High-Speed Ingestion (Producer-Consumer)
- **Producer (BleDriver)**: Must remain lightweight. Its only job is to capture raw Bluetooth frames, parse the protocol (Tag ID + RSSI), and push to a high-speed memory queue. Zero blocking logic.
- **Consumer (TimingEngine)**: Processes the queue in batches. 
    - Dedupes reads to prevent DB bloat.
    - Persists unique reads to `IndexedDB`.
    - Updates UI through a thin event/callback layer.

## 2. Data Persistence & Lifecycle
- **Race Data**: Store in `race_reads`. Target for the "Reset Race" function.
- **Kiosk Registry**: Store in `chip_map`. Must **NOT** be cleared by race resets. This is the source of truth for Bib assignments.
- **Session Recovery**: UI state (Clock, Tracking Status) must sync to `localStorage` to survive accidental page refreshes.

## 3. Hardware Management
- **BleDriver**: Must implement an auto-reconnect loop. If the GATT server drops, it should attempt to reconnect silently without user intervention if the race is active.
- **Mocking**: The interface must be abstract enough to allow a `MockBleDriver` to inject fake reads for testing/regression.

## 4. Processing
- **Deduplication**: Initial "Ingestion Dedup" (don't save the same chip 100 times in 1 second).
- **Export Logic**: Final "Result Dedup" (take the first seen time for the official standing). 
- **Time Sync**: All timestamps must be high-precision ISO or MS from the epoch.

## 5. AI Constraint: No Autonomous Edits
- **STRICT RULE**: The AI assistant must **NEVER** write or modify files without first presenting the proposed change and receiving explicit verbal approval from the user. 
- All changes must be verified against the regression suite after approval.

## 6. Team Hierarchy & Discipline
- **Architect/Senior Engineer**: The User. Owns the vision, direction, and engineering principles.
- **Implementation/Junior Assistant**: The AI. Provides technical suggestions and handles code execution but must remain strictly disciplined.
- **Operational Rule**: No "freestyling." The AI must not assume it knows better or change working code for the sake of "improvement" without a direct order. The Junior executes what the Senior approves.
