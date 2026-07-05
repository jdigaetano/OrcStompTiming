# Orc Stomp Timing: Feature Wishlist

## UI Enhancements
- [x] **Unique Reads Counter**: Add a "Unique" counter next to "Pings" that only increments the first time a chip is seen in the current session.
- [ ] **Live Standings Tab**: A dedicated tab for real-time leaderboards/rankings.
    - *Requirement*: Logic must remain active in the background even when the tab is not visible.
- [ ] **Casting/External Display**: Optimization for displaying results on a secondary monitor or TV.

## Advanced Logic
- [ ] **Pro-Level Deduplication**: 
    - Instead of just "First Seen", implement a "Peak RSSI Window". (✅ Logic implemented in Export v1.3)
    - *Algorithm*: When a chip is first seen, open a 10-second window. Track all reads within that window. Use the timestamp of the read with the **strongest RSSI** as the official finish time. Ignore all reads after the 10-second window closes.
- [x] **Background Resilience**: Ensure the Web Bluetooth and Timing Engine don't get throttled by Chrome's "Power Saving" features. Web Bluetooth `characteristicvaluechanged` events fire regardless of tab visibility, so no tag reads are lost. The write daemon's 250ms `setInterval` throttles to ~1s when hidden, but all queued reads flush on next fire — no data loss. `AppUI` now listens for `visibilitychange`: stops the visual clock when hidden (avoids a frozen display), restarts it on return if the race is active, and logs both transitions.

## Hardware & Connectivity
- [x] **Persistent Device Pairing**: Save the Bluetooth device ID/info to `localStorage` — shows the device name on reload so the user knows which device to pick.
- [ ] **Auto-Connect**: `navigator.bluetooth.getDevices()` (Chrome 85+) is the only Web Bluetooth path to connect without a user gesture, but confirmed non-functional on Windows Chrome for this hardware — `getDevices()` consistently returns an empty list even after a fresh `requestDevice()` grant. No JS workaround exists. The code is in place and will activate if Chrome ever fixes this on Windows.

## Data & Synchronization
- [x] **Dual Timestamps**: The database should store both:
    1. **Elapsed Race Time** (for results).
    2. **Wall Clock Time** (ISO/Local) for synchronization with external cameras/video.
- [x] **Standings Enrichment**: The Export CSV should include the Wall Clock Time of the selected "Peak" read.
- [x] **Race-Day Backup System (2026-07-05)**: All timing data lived only in one browser's IndexedDB, with the only export happening once, manually, at the end — a single point of failure. Now: (1) a one-time `showSaveFilePicker()` picker lets the operator choose a backup file; the handle persists in a new `app_settings` IndexedDB store and is silently reused on every later page load (`AppUI.restoreBackupHandle()`), shown in the header as "Backing up to: `<filename>`". (2) While the clock runs, `TimingEngine.getRawSnapshot()` (zero computation, just two `getAll()`s) is written to that file every 60s via `AppUI.performLiveBackup()` — deliberately lightweight so it can't add load to live ingestion. (3) When the clock stops, or before Reset Race/Nuke Database, `AppUI.performHeavyBackup()` does the same raw snapshot *plus* triggers the full computed standings CSV download — heavier processing is fine once the race isn't live. (4) Reset/Nuke confirm dialogs now show actual counts via `AppUI.buildWipeConfirmMessage()` instead of generic text, and a backup runs before the destructive clear either way. Chromium-only (`showSaveFilePicker` has no Firefox/Safari support), consistent with the existing Web-Bluetooth-driven Chrome-only assumption. Covered by `tests/backup.test.js` (21 tests) and verified in a real headless-Chromium browser (label update, live/heavy snapshot content, CSV download, confirm wording, cancel-preserves-data) — the one thing that can't be verified outside a real user session is the native file picker itself and cross-session permission re-prompting, which needed the handle mocked at the `engine` level for automated testing.

## Inventory & Kiosk
- [ ] **Multi-Event Map**: Ability to store different mapping sets for different race days.
- [ ] **Bib Auto-Increment**: Option in Kiosk mode to auto-increment the Bib number after a successful mapping.
