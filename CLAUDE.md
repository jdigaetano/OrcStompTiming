# CLAUDE.md

Offline UHF RFID race-timing PWA. Built by Gemini as a proof of concept; now being hardened deliberately, one verified fix at a time. Read these before making any change, in this order:

1. [PROJECT_GUIDELINES.md](PROJECT_GUIDELINES.md) — architecture rules *and* process rules (no autonomous edits, Red-Green-Refactor testing discipline). Both are strict requirements, not suggestions.
2. [PROTOCOL_SPEC.md](PROTOCOL_SPEC.md) — the UHF reader's command protocol, transcribed and verified from the manufacturer's PDF (`Reader Control Procotol_v1.1.pdf` — copy/print-locked in viewers, but `pdftotext -layout` extracts it cleanly). Has a clearly separated section for what's empirically observed on this specific clone reader vs. what's actually documented in the manual.
3. [KNOWN_ISSUES.md](KNOWN_ISSUES.md) — running punch-list of confirmed bugs and open questions. Check here before re-investigating something already covered.

These three files are the project's source of truth — not any AI assistant's local memory, which doesn't travel between machines. Keep them current as work happens.

## Quick orientation
- `BleDriver.js` — hardware interface: Web Bluetooth connection lifecycle, protocol frame parsing.
- `MockBleDriver.js` — fake reader for dev/testing (frame shape currently doesn't match the real one — see `KNOWN_ISSUES.md` #4).
- `TimingEngine.js` — IndexedDB persistence, dedup, race state.
- `AppUI.js` / `index.html` — DOM orchestration and UI; script tags load in dependency order, no bundler.
- `tests/` — Vitest (`npm test`). `connection.test.js` covers the BLE connection lifecycle; `regression.test.js` covers protocol parsing; `mission-critical.test.js` covers data integrity/persistence.

## Non-negotiables
- No file is modified without the User's explicit go-ahead first (`PROJECT_GUIDELINES.md` §5).
- No production code change without a failing test first; full suite run and every failure triaged after every change (`PROJECT_GUIDELINES.md` §7).
