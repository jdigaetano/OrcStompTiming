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

## 7. Testing Discipline (Red-Green-Refactor)
- **Before any code change**: there must be a test exercising the affected behavior that currently fails (Red) for the reason the change is meant to fix. Write it first if one doesn't already exist.
- **After any code change**: run the full test suite (`npm test`) and read the complete output — not just the test that motivated the change. Every newly-failing test must be triaged immediately into one of:
    1. **Stale test** — it modeled outdated/incorrect behavior; confirm against the real source of truth (`PROTOCOL_SPEC.md`, hardware behavior) before rewriting it, don't just patch it to pass.
    2. **Real regression** — the code change broke something; fix the code, not the test.
    3. **Explicitly deferred** — flag it and get a decision from the User; never leave a new failure unexplained or silently ignored.
- A test suite that exists but isn't run compulsively after every change provides zero protection — the discipline is in the *checking*, not just the tests' existence.
- Exception: fixing a test that's wrong/stale isn't gated by the "before" half the same way, since the test itself isn't production code — but its staleness must still be justified (against the spec or real behavior), not just edited until green.

## 8. Race-Day Redundancy Plan (2026-07-05, per Tony)
This chip/reader system is the **primary** timing method, but is not yet trusted enough to run without a human safety net. Until that confidence is earned, races also run with:
- **A camera recording the finish line with a real-time timestamp overlay** — lets a human reconstruct order/time from video if chip data is missing or wrong for a bib. This is also why `race_reads` stores both elapsed race time *and* wall-clock ISO time (see WISHLIST.md "Dual Timestamps") — the wall clock is what lines up against the camera's overlay.
- **A dedicated track timing device**, run independently as a second electronic backup.
- **A barcode scanner at the finish chute**, scanning each bib as runners pass, as a final manual order-of-finish backup.

This is deliberately transitional — a belt-and-suspenders setup for early races while confidence in the chip/camera system is built, not a permanent four-system requirement. Backup layers should be dropped incrementally as trust in the primary system grows, not all at once.

**Not yet addressed, worth deciding before relying on this in a real dispute:**
- **Clock sync across all four systems.** If the reader, camera overlay, track timing device, and barcode scanner aren't correlated to a common time reference, reconciling a discrepancy after the race is guesswork. Worth syncing all clocks to the same source before the race, and/or using a clear shared sync event (e.g. the starting gun, audible/visible on camera, correlated with the moment "Start Race" is pressed in the app).
- **Barcode scanner throughput during a bunched finish.** A single operator scanning bibs one at a time may not keep up when many runners cross within seconds of each other (common at the front of a pack or a sprint finish) — a real limitation of that layer, not fixable in software, worth knowing about since it's the last fallback in the chain.
