import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// Mock WebSocket — installed fresh each test so capturedWs is always the latest instance.
let capturedWs = null;
function installMockWebSocket() {
    capturedWs = null;
    class MockWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.onopen = null;
            this.onmessage = null;
            this.onclose = null;
            this.onerror = null;
            this.close = vi.fn(() => { this.readyState = 3; if (this.onclose) this.onclose(); });
            this.send = vi.fn();
            capturedWs = this;
        }
    }
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    global.WebSocket = MockWebSocket;
}

describe('EthernetDriver', () => {
    let EthernetDriver;

    beforeEach(() => {
        global.localStorage.clear();
        installMockWebSocket();
        EthernetDriver = loadScript('EthernetDriver.js');
    });

    // ─── parseZiotcEvent ────────────────────────────────────────────────────────

    describe('EthernetDriver.parseZiotcEvent()', () => {
        it('extracts epcHex and rssiDbm from a ZIoTC JSON tag event', () => {
            const json = JSON.stringify({ data: [{ idHex: '4F530068000000000000000', rssi: -54 }] });
            const events = EthernetDriver.parseZiotcEvent(json);
            expect(events).toHaveLength(1);
            expect(events[0].epcHex).toBe('4F530068000000000000000');
            expect(events[0].rssiDbm).toBe(-54);
        });

        it('returns empty array for malformed JSON or empty input', () => {
            expect(EthernetDriver.parseZiotcEvent('not json')).toEqual([]);
            expect(EthernetDriver.parseZiotcEvent('')).toEqual([]);
            expect(EthernetDriver.parseZiotcEvent(null)).toEqual([]);
        });

        it('handles data as a single event object (not wrapped in an array)', () => {
            // ZIoTC may send data as a plain object rather than an array for single-tag events
            const json = JSON.stringify({ data: { idHex: '4F530068000000000000000', rssi: -60 } });
            const events = EthernetDriver.parseZiotcEvent(json);
            expect(events).toHaveLength(1);
            expect(events[0].epcHex).toBe('4F530068000000000000000');
        });

        it('prefers peakRssi over rssi when both present — Inventory mode field takes precedence', () => {
            // Zebra Inventory mode sends peakRssi (confirmed). rssi may also be present; peakRssi wins.
            const json = JSON.stringify({ data: [{ idHex: '4F530068000000000000000', rssi: -54, peakRssi: -48 }] });
            const events = EthernetDriver.parseZiotcEvent(json);
            expect(events[0].rssiDbm).toBe(-48);
        });
    });

    // ─── connect ────────────────────────────────────────────────────────────────

    describe('connect()', () => {
        it('saves IP to localStorage, sets device, and fires onStatusChange connected', async () => {
            const driver = new EthernetDriver();
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            const p = driver.connect('192.168.1.100');
            capturedWs.onopen();
            await p;

            expect(localStorage.getItem('ethernetReaderIp')).toBe('192.168.1.100');
            expect(driver.device).toBe('192.168.1.100');
            expect(statuses.some(s => s.connected === true)).toBe(true);
        });
    });

    // ─── disconnect ─────────────────────────────────────────────────────────────

    describe('disconnect()', () => {
        it('clears device and fires onStatusChange offline', async () => {
            const driver = new EthernetDriver();

            const p = driver.connect('192.168.1.100');
            capturedWs.onopen();
            await p;

            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            await driver.disconnect();

            expect(driver.device).toBeNull();
            expect(statuses.some(s => s.connected === false)).toBe(true);
        });
    });

    // ─── writeBibToEpc ──────────────────────────────────────────────────────────

    describe('writeBibToEpc()', () => {
        it('throws with a message referencing BLE handheld', async () => {
            const driver = new EthernetDriver();
            await expect(driver.writeBibToEpc(104)).rejects.toThrow(/BLE/i);
        });
    });

    // ─── onTagRead wiring ───────────────────────────────────────────────────────

    describe('tag read event wiring', () => {
        it('fires onTagRead with correct epcHex and rssiDbm when a ZIoTC WebSocket message arrives', async () => {
            const driver = new EthernetDriver();
            const reads = [];
            driver.onTagRead = (epcHex, rssiDbm) => reads.push({ epcHex, rssiDbm });

            const p = driver.connect('192.168.1.100');
            capturedWs.onopen();
            await p;

            const json = JSON.stringify({ data: [{ idHex: '4F530068000000000000000', rssi: -65 }] });
            capturedWs.onmessage({ data: json });

            expect(reads).toHaveLength(1);
            expect(reads[0].epcHex).toBe('4F530068000000000000000');
            expect(reads[0].rssiDbm).toBe(-65);
        });
    });
});
