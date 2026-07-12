import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// CID1=0x20 poll response — RTN=0x05 means tag found in BLE mode
function makePollResponse() {
    const frame = [0xCC, 0xFF, 0xFF, 0x20, 0x05, 0x00];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return new Uint8Array(frame);
}

// CID1=0x22 authenticated write response — RTN=0x00 success, returns old EPC (ignored)
function makeWriteResponse() {
    const frame = [0xCC, 0xFF, 0xFF, 0x22, 0x00, 0x00];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return new Uint8Array(frame);
}

// Full CID1=0x20 tag-read frame with a real OrcStomp-encoded EPC — used for verify step.
// Layout (decodeTagFrame, BleDriver.js:232): CC FF FF 20 05 LENGTH AN PC[2] EPC[12] RSSI CHKSUM
// PC high byte = epcLenWords<<3 = 6<<3 = 0x30 (96-bit EPC = 6 words).
// Returns a plain JS array (not Uint8Array) to match what sendCommand resolves with in production:
// processValidFrame passes frameBytes = bytes.slice(), where bytes is a plain array from parseFrame.
// Uint8Array.prototype.map coerces string returns to uint8, breaking bytesToHex silently.
function makeFullTagFrameWithBib(bibNum) {
    const bh = (bibNum >> 8) & 0xFF;
    const bl = bibNum & 0xFF;
    const epc = [0x4F, 0x53, bh, bl, 0, 0, 0, 0, 0, 0, 0, 0]; // 12 bytes
    const frame = [
        0xCC, 0xFF, 0xFF, 0x20, // SOI ADDR CID1
        0x05,                   // RTN = tag found
        0x10,                   // LENGTH = 16 (AN + PC[2] + EPC[12] + RSSI)
        0x01,                   // AN = antenna 1
        0x30, 0x00,             // PC: epcLenWords=6 -> high=6<<3=0x30, low=0x00
        ...epc,                 // 12 EPC bytes
        0xC0,                   // RSSI raw (192 -> -64 dBm)
    ];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return frame; // plain array, not Uint8Array
}

describe('BleDriver.writeBibToEpc()', () => {
    let BleDriver, driver;

    beforeEach(() => {
        global.localStorage.clear();
        BleDriver = loadScript('BleDriver.js');
        driver = new BleDriver();
        driver.writeCharacteristic = {
            writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
        };
    });

    // Vendor USB trace (2026-07-07) revealed the real write command is CID1=0x22
    // (authenticated write, MM extension) — NOT CID1=0x12 (documented spec write).
    // CID1=0x12 gets no response from this reader. CID1=0x22 prepends a 4-byte
    // access password (all zeros for unprotected tags) and uses word-offset SA.
    //
    // The demo app polls with CID1=0x20 first (to singulate the tag), then immediately
    // sends CID1=0x22 to write to the held-singulated tag. Sending the write without a
    // prior poll causes a false RTN=0x00 (reader accepts the command frame but no tag
    // was singulated, so no write occurs). Confirmed by hardware test 2026-07-08.
    //
    // DL=06 writes all 6 words of the 96-bit EPC (matching the demo app), not just 2.
    // Response returns old EPC; RTN=0x00 is the success indicator.
    //
    // After writing, a verify poll (step 3) reads back the EPC and checks the bib.
    // If the wrong chip was singulated (adjacent chip interference), the verify
    // catches it and returns {success: false} with a WRONG CHIP message.
    // If the verify poll times out, it degrades gracefully to a plain success — no
    // new failure state introduced.

    it('uses CID1=0x22 (authenticated write, not documented CID1=0x12)', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        const writeCid1 = sendCmd.mock.calls[1][1];
        const writeHex = sendCmd.mock.calls[1][0];
        expect(writeHex.toUpperCase()).toMatch(/^7CFFFF22/);
        expect(writeCid1).toBe(0x22);
    });

    it('sends CID1=0x20 poll first (singulates the tag) before sending CID1=0x22 write', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        expect(sendCmd.mock.calls[0][1]).toBe(0x20); // first call = poll
        expect(sendCmd.mock.calls[1][1]).toBe(0x22); // second call = write
    });

    it('sends 4-byte access password (all zeros) before MB/SA/DL/data', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        const hex = sendCmd.mock.calls[1][0].toUpperCase();
        // bytes 6-13 (after 7C FF FF 22 00 13) = 4-byte password
        expect(hex.slice(12, 20)).toBe('00000000'); // password = 0x00000000
    });

    it('sends MB=01 (EPC bank), SA=02 (word offset 2 = first EPC word), DL=06 (6 words = full 96-bit EPC)', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        const hex = sendCmd.mock.calls[1][0].toUpperCase();
        expect(hex.slice(20, 26)).toBe('010206'); // MB SA DL
    });

    it('pads the remaining 8 EPC bytes with 00 (not FF — zeros read as intentionally empty, FFs look like unwritten factory data)', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        const hex = sendCmd.mock.calls[1][0].toUpperCase();
        expect(hex.slice(34, 50)).toBe('0000000000000000'); // 8 padding bytes after 4F53BHBL
    });

    it('encodes the magic prefix 0x4F53 followed by the bib as 2-byte big-endian in the first 4 data bytes', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        const hex = sendCmd.mock.calls[1][0].toUpperCase();
        expect(hex.slice(26, 34)).toBe('4F530068'); // 104 = 0x0068
    });

    it('encodes different bib numbers correctly', async () => {
        const cases = [
            { bib: 1,     hex: '4F530001' },
            { bib: 982,   hex: '4F5303D6' },
            { bib: 5251,  hex: '4F531483' },
            { bib: 9999,  hex: '4F53270F' },
            { bib: 65535, hex: '4F53FFFF' },
        ];
        for (const { bib, hex } of cases) {
            const sendCmd = vi.spyOn(driver, 'sendCommand')
                .mockResolvedValueOnce(makePollResponse())
                .mockResolvedValueOnce(makeWriteResponse())
                .mockResolvedValueOnce(makeFullTagFrameWithBib(bib));
            await driver.writeBibToEpc(bib);
            const writeHex = sendCmd.mock.calls[1][0].toUpperCase();
            expect(writeHex.slice(26, 34)).toBe(hex);
            sendCmd.mockRestore();
        }
    });

    it('issues exactly 3 sendCommand calls — CID1=0x20 poll, CID1=0x22 write, CID1=0x20 verify poll', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        await driver.writeBibToEpc(104);
        expect(sendCmd).toHaveBeenCalledTimes(3);
    });

    it('returns {success: true, message containing "verified"} when verify poll reads back the correct bib', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/verified/i);
    });

    it('returns {success: false} with WRONG CHIP message when verify poll reads a different bib', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockResolvedValueOnce(makeFullTagFrameWithBib(999)); // wrong chip
        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/WRONG CHIP/i);
        expect(result.message).toContain('999');
        expect(result.message).toContain('104');
    });

    it('returns {success: true} when verify poll times out — degrades gracefully, no new failure state', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockResolvedValueOnce(makeWriteResponse())
            .mockRejectedValue(new Error('timeout')); // all verify attempts fail
        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(true);
        expect(result.message).toContain('104');
    });

    it('returns {success: false} when no chip is detected within poll timeout', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockRejectedValue(new Error('sendCommand timeout waiting for CID1=0x20'));
        // totalWaitMs=300, pollIntervalMs=300 -> 1 attempt -> immediate failure
        const result = await driver.writeBibToEpc(104, 300, 300);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/No chip detected/i);
    });

    it('returns {success: false} when the write command fails after a chip is detected', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makePollResponse())
            .mockRejectedValue(new Error('sendCommand timeout waiting for CID1=0x22'));
        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(false);
        expect(result.message).toBeTruthy();
    });
});

describe('BleDriver.scanForTag()', () => {
    let BleDriver, driver;

    beforeEach(() => {
        global.localStorage.clear();
        BleDriver = loadScript('BleDriver.js');
        driver = new BleDriver();
        driver.writeCharacteristic = {
            writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('returns {epcHex, rssiDbm} when a chip is found', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makeFullTagFrameWithBib(104));
        const result = await driver.scanForTag(300, 300);
        expect(result).not.toBeNull();
        expect(result.epcHex.toUpperCase()).toBe('4F5300680000000000000000');
        expect(typeof result.rssiDbm).toBe('number');
    });

    it('returns null when no chip is found within timeout', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockRejectedValue(new Error('timeout'));
        const result = await driver.scanForTag(300, 300);
        expect(result).toBeNull();
    });
});
