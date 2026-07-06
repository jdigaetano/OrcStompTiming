import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// Build a minimal valid response frame for a given CID1 and optional INFO bytes
function makeResponseFrame(cid1, rtn = 0x00, info = []) {
    const frame = [0xCC, 0xFF, 0xFF, cid1, rtn, info.length, ...info];
    let sum = 0;
    for (const b of frame) sum += b;
    const chk = ((~sum) + 1) & 0xFF;
    return new Uint8Array([...frame, chk]);
}

// Build an Active-mode tag push frame (CID1=0x20) — should be ignored by sendCommand
function makeTagPushFrame() {
    // Minimal: AN=1, PC=0x3000 (12-byte EPC), 12 EPC bytes, RSSI=0xB0
    const epc = Array(12).fill(0xAA);
    const info = [0x01, 0x30, 0x00, ...epc, 0xB0];
    return makeResponseFrame(0x20, 0x05, info);
}

function fireNotification(driver, frame) {
    const view = new DataView(frame.buffer);
    driver.parseFrame({ target: { value: view } });
}

describe('BleDriver.sendCommand()', () => {
    let BleDriver, driver;

    beforeEach(() => {
        global.localStorage.clear();
        BleDriver = loadScript('BleDriver.js');
        driver = new BleDriver();
        driver.writeCharacteristic = {
            writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
        };
    });

    it('resolves with the response frame when expected CID1 matches', async () => {
        const response = makeResponseFrame(0x81, 0x00, [0x01, 0x02]);
        const promise = driver.sendCommand('7CFFFF813200', 0x81);
        fireNotification(driver, response);
        const frame = await promise;
        expect(frame[3]).toBe(0x81);
        expect(frame[4]).toBe(0x00); // RTN success
    });

    it('ignores Active-mode tag push frames (CID1=0x20) while waiting', async () => {
        const pushFrame = makeTagPushFrame();
        const response = makeResponseFrame(0x12, 0x00);
        const promise = driver.sendCommand('7CFFFF123100', 0x12);
        // Fire push frame first — should be ignored, not resolve the command
        fireNotification(driver, pushFrame);
        // Then fire the real response
        fireNotification(driver, response);
        const frame = await promise;
        expect(frame[3]).toBe(0x12);
    });

    it('rejects if no matching response arrives within the timeout', async () => {
        vi.useFakeTimers();
        const promise = driver.sendCommand('7CFFFF813200', 0x81, 500);
        vi.advanceTimersByTime(600);
        await expect(promise).rejects.toThrow(/timeout/i);
        vi.useRealTimers();
    });

    it('rejects if RTN indicates failure (0x01)', async () => {
        const response = makeResponseFrame(0x12, 0x01); // RTN=01 fail
        const promise = driver.sendCommand('7CFFFF123100', 0x12);
        fireNotification(driver, response);
        await expect(promise).rejects.toThrow(/fail/i);
    });

    it('still fires onTagRead for push frames received while waiting', async () => {
        const pushFrame = makeTagPushFrame();
        const response = makeResponseFrame(0x12, 0x00);
        driver.onTagRead = vi.fn();
        const promise = driver.sendCommand('7CFFFF123100', 0x12);
        fireNotification(driver, pushFrame);
        fireNotification(driver, response);
        await promise;
        expect(driver.onTagRead).toHaveBeenCalledOnce();
    });

    it('throws immediately if no write pipe is available', async () => {
        driver.writeCharacteristic = null;
        await expect(driver.sendCommand('7CFFFF813200', 0x81)).rejects.toThrow(/write pipe/i);
    });
});
