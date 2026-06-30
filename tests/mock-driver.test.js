import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const BleDriver = loadScript('BleDriver.js');
const MockBleDriver = loadScript('MockBleDriver.js');

// ─── buildTagFrame ──────────────────────────────────────────────────────────

describe('MockBleDriver.buildTagFrame()', () => {
    let mock;
    beforeEach(() => { mock = new MockBleDriver(); });

    it('produces a frame with the correct protocol header (CC FF FF 20 05)', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF001122334455', -70);
        expect(frame[0]).toBe(0xCC);
        expect(frame[1]).toBe(0xFF);
        expect(frame[2]).toBe(0xFF);
        expect(frame[3]).toBe(0x20);
        expect(frame[4]).toBe(0x05);
    });

    it('produces a frame with a valid checksum (all bytes sum to 0 mod 256)', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF001122334455', -70);
        const sum = frame.reduce((a, b) => a + b, 0);
        expect(sum & 0xFF).toBe(0);
    });

    it('encodes LENGTH correctly for a 12-byte EPC (INFO = 1+2+12+1 = 16 bytes)', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF001122334455', -70);
        expect(frame[5]).toBe(16);
    });

    it('encodes LENGTH correctly for a 16-byte EPC (INFO = 1+2+16+1 = 20 bytes)', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF00112233445566778899', -60);
        expect(frame[5]).toBe(20);
    });

    it('sets PC high byte so BleDriver.decodeTagFrame derives the correct EPC word length (12-byte EPC → 6 words → PC high = 0x30)', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF001122334455', -70);
        expect(frame[7]).toBe(0x30);  // PC high byte: 6 words << 3
        expect(frame[8]).toBe(0x00);  // PC low byte
    });

    it('sets PC high byte correctly for a 16-byte EPC (8 words → PC high = 0x40)', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF00112233445566778899', -60);
        expect(frame[7]).toBe(0x40);
        expect(frame[8]).toBe(0x00);
    });

    it('can be decoded by BleDriver.decodeTagFrame() and round-trips epcHex correctly', () => {
        const epcHex = 'AABBCCDDEEFF001122334455';
        const frame = mock.buildTagFrame(epcHex, -70);
        const driver = new BleDriver();
        const decoded = driver.decodeTagFrame(frame);
        expect(decoded).not.toBeNull();
        expect(decoded.epcHex).toBe(epcHex);
    });

    it('can be decoded by BleDriver.decodeTagFrame() and round-trips rssiDbm correctly', () => {
        const frame = mock.buildTagFrame('AABBCCDDEEFF001122334455', -73);
        const driver = new BleDriver();
        const decoded = driver.decodeTagFrame(frame);
        expect(decoded.rssiDbm).toBe(-73);
    });

    it('round-trips a 16-byte EPC correctly through BleDriver.decodeTagFrame()', () => {
        const epcHex = 'AABBCCDDEEFF00112233445566778899';
        const frame = mock.buildTagFrame(epcHex, -55);
        const driver = new BleDriver();
        const decoded = driver.decodeTagFrame(frame);
        expect(decoded.epcHex).toBe(epcHex);
        expect(decoded.rssiDbm).toBe(-55);
        expect(decoded.epcLenBytes).toBe(16);
    });
});

// ─── playSequence ──────────────────────────────────────────────────────────

describe('MockBleDriver.playSequence()', () => {
    let mock;
    beforeEach(() => { mock = new MockBleDriver(); });

    it('calls onRawFrame with a non-null tagDecode', async () => {
        const frames = [];
        mock.onRawFrame = (f) => frames.push(f);
        await mock.playSequence([{ epcHex: 'AABBCCDDEEFF001122334455', rssi: -70, delay: 0 }]);
        expect(frames.length).toBe(1);
        expect(frames[0].tagDecode).not.toBeNull();
    });

    it('tagDecode.epcHex in onRawFrame matches the input epcHex', async () => {
        const epcHex = 'AABBCCDDEEFF001122334455';
        let captured = null;
        mock.onRawFrame = (f) => { captured = f; };
        await mock.playSequence([{ epcHex, rssi: -70, delay: 0 }]);
        expect(captured.tagDecode.epcHex).toBe(epcHex);
    });

    it('tagDecode.rssiDbm in onRawFrame matches the input rssi', async () => {
        let captured = null;
        mock.onRawFrame = (f) => { captured = f; };
        await mock.playSequence([{ epcHex: 'AABBCCDDEEFF001122334455', rssi: -42, delay: 0 }]);
        expect(captured.tagDecode.rssiDbm).toBe(-42);
    });

    it('onRawFrame carries a frame that BleDriver.decodeTagFrame() independently validates', async () => {
        const epcHex = 'AABBCCDDEEFF001122334455';
        let captured = null;
        mock.onRawFrame = (f) => { captured = f; };
        await mock.playSequence([{ epcHex, rssi: -70, delay: 0 }]);

        const driver = new BleDriver();
        const independent = driver.decodeTagFrame(captured.frame);
        expect(independent).not.toBeNull();
        expect(independent.epcHex).toBe(epcHex);
        expect(independent.rssiDbm).toBe(-70);
    });

    it('calls onTagRead with the correct epcHex and rssiDbm', async () => {
        const epcHex = 'AABBCCDDEEFF001122334455';
        let tagArg = null, rssiArg = null;
        mock.onTagRead = (hex, rssi) => { tagArg = hex; rssiArg = rssi; };
        await mock.playSequence([{ epcHex, rssi: -70, delay: 0 }]);
        expect(tagArg).toBe(epcHex);
        expect(rssiArg).toBe(-70);
    });

    it('fires all items in the sequence', async () => {
        const reads = [];
        mock.onTagRead = (hex, rssi) => reads.push({ hex, rssi });
        await mock.playSequence([
            { epcHex: 'AABBCCDDEEFF001122334455', rssi: -70, delay: 0 },
            { epcHex: 'AABBCCDDEEFF001122334455', rssi: -50, delay: 0 },
            { epcHex: 'AABBCCDDEEFF001122334455', rssi: -30, delay: 0 },
        ]);
        expect(reads.length).toBe(3);
        expect(reads[1].rssi).toBe(-50);
    });

    it('checksumValid is true for every emitted frame', async () => {
        const frames = [];
        mock.onRawFrame = (f) => frames.push(f);
        await mock.playSequence([
            { epcHex: 'AABBCCDDEEFF001122334455', rssi: -70, delay: 0 },
            { epcHex: 'DDEEFF001122334455AABBCC', rssi: -55, delay: 0 },
        ]);
        for (const f of frames) expect(f.checksumValid).toBe(true);
    });
});

// ─── startSimulation ───────────────────────────────────────────────────────

describe('MockBleDriver.startSimulation()', () => {
    let mock;
    beforeEach(() => {
        mock = new MockBleDriver();
        mock.isConnected = true;
        vi.useFakeTimers();
    });
    afterEach(() => { mock.stopSimulation(); vi.useRealTimers(); });

    it('calls onTagRead with a non-empty epcHex string', () => {
        let tagArg = null;
        mock.onTagRead = (hex) => { tagArg = hex; };
        mock.startSimulation();
        vi.advanceTimersByTime(1500);
        expect(tagArg).not.toBeNull();
        expect(tagArg.length).toBeGreaterThan(0);
    });

    it('calls onRawFrame with a non-null tagDecode', () => {
        let captured = null;
        mock.onRawFrame = (f) => { captured = f; };
        mock.startSimulation();
        vi.advanceTimersByTime(1500);
        expect(captured).not.toBeNull();
        expect(captured.tagDecode).not.toBeNull();
    });

    it('emitted frames pass BleDriver.decodeTagFrame() validation', () => {
        let captured = null;
        mock.onRawFrame = (f) => { captured = f; };
        mock.startSimulation();
        vi.advanceTimersByTime(1500);
        const driver = new BleDriver();
        const decoded = driver.decodeTagFrame(captured.frame);
        expect(decoded).not.toBeNull();
        expect(decoded.epcHex).toBe(captured.tagDecode.epcHex);
    });
});
