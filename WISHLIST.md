# Orc Stomp Timing: Feature Wishlist

## UI Enhancements
- [ ] **Unique Reads Counter**: Add a "Unique" counter next to "Pings" that only increments the first time a chip is seen in the current session.
- [ ] **Live Standings Tab**: A dedicated tab for real-time leaderboards/rankings.
    - *Requirement*: Logic must remain active in the background even when the tab is not visible (ensure Service Worker or main thread doesn't throttle).
- [ ] **Casting/External Display**: Optimization for displaying results on a secondary monitor or TV.

## Advanced Logic
- [ ] **Pro-Level Deduplication**: 
    - Instead of just "First Seen", implement a "Peak RSSI Window".
    - *Algorithm*: When a chip is first seen, open a 10-second window. Track all reads within that window. Use the timestamp of the read with the **strongest RSSI** as the official finish time. Ignore all reads after the 10-second window closes.
- [ ] **Background Resilience**: Ensure the Web Bluetooth and Timing Engine don't get throttled by Chrome's "Power Saving" or "Tab Discarding" features during long races.

## Inventory & Kiosk
- [ ] **Multi-Event Map**: Ability to store different mapping sets for different race days.
- [ ] **Bib Auto-Increment**: Option in Kiosk mode to auto-increment the Bib number after a successful mapping to speed up packet pickup.
