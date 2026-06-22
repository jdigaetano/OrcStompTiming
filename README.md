# OrcStompTiming

Offline UHF RFID Race Timing System built as a PWA.

## Features
- **Web Bluetooth API**: Connects directly to UHF RFID readers.
- **IndexedDB**: Persistent local storage for race data.
- **PWA**: Installable on mobile/desktop for offline use.
- **Bib Mapping**: Kiosk mode for associating RFID tags with Bib numbers.

## Architecture
- `index.html`: Core UI and Logic (Refactoring in progress).
- `service-worker.js`: Offline support.
- `manifest.json`: PWA configuration.
