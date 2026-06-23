# Orc Stomp Timing: Feature Wishlist

## UI Enhancements
- [ ] **Unique Reads Counter**: Add a "Unique" counter next to "Pings" that only increments the first time a chip is seen in the current session. (✅ Partially Implemented in v1.3)
- [ ] **Live Standings Tab**: A dedicated tab for real-time leaderboards/rankings.
    - *Requirement*: Logic must remain active in the background even when the tab is not visible.
- [ ] **Casting/External Display**: Optimization for displaying results on a secondary monitor or TV.

## Advanced Logic
- [ ] **Pro-Level Deduplication**: 
    - Instead of just "First Seen", implement a "Peak RSSI Window". (✅ Logic implemented in Export v1.3)
    - *Algorithm*: When a chip is first seen, open a 10-second window. Track all reads within that window. Use the timestamp of the read with the **strongest RSSI** as the official finish time. Ignore all reads after the 10-second window closes.
- [ ] **Background Resilience**: Ensure the Web Bluetooth and Timing Engine don't get throttled by Chrome's "Power Saving" features.

## Hardware & Connectivity
- [ ] **Persistent Device Pairing**: Save the Bluetooth device ID/info to `localStorage` to attempt auto-connection on app launch. 
- [ ] **Auto-Connect**: App should look for the last used reader and connect immediately without clicking "Connect Reader" if possible.

## Data & Synchronization
- [ ] **Dual Timestamps**: The database should store both:
    1. **Elapsed Race Time** (for results).
    2. **Wall Clock Time** (ISO/Local) for synchronization with external cameras/video.
- [ ] **Standings Enrichment**: The Export CSV should include the Wall Clock Time of the selected "Peak" read.

## Inventory & Kiosk
- [ ] **Multi-Event Map**: Ability to store different mapping sets for different race days.
- [ ] **Bib Auto-Increment**: Option in Kiosk mode to auto-increment the Bib number after a successful mapping.
