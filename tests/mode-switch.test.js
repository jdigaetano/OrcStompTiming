import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// WM is at byte index 9 in the 28-byte INFO block (PROTOCOL_SPEC.md Section 4.8):
// PW(0) FHE(1) FFV(2) FHV1-FHV6(3-8) WM(9) RI(10) ...
const WM_INDEX = 9;

function makeParamResponse(wmByte, infoLen = 28) {
    const params = new Uint8Array(infoLen);
    params[WM_INDEX] = wmByte;
    const frame = [0xCC, 0xFF, 0xFF, 0x81, 0x00, infoLen, ...params];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return new Uint8Array(frame);
}

function makeSetResponse() {
    const frame = [0xCC, 0xFF, 0xFF, 0x81, 0x00, 0x00];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return new Uint8Array(frame);
}

describe('BleDriver: Reader Parameter mode switching', () => {
    let BleDriver, driver;

    beforeEach(() => {
        global.localStorage.clear();
        BleDriver = loadScript('BleDriver.js');
        driver = new BleDriver();
        driver.writeCharacteristic = {
            writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
        };
    });

    describe('getReaderParameters()', () => {
        it('sends CID1=81H CID2=32H (Get Basic Parameters)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeParamResponse(0x02));
            await driver.getReaderParameters();
            const [hexArg, cid1Arg] = driver.sendCommand.mock.calls[0];
            expect(hexArg.toUpperCase()).toMatch(/^7CFFFF8132/);
            expect(cid1Arg).toBe(0x81);
        });

        it('returns the INFO block whose length matches the LEN field in the response (28 bytes)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeParamResponse(0x02, 28));
            const result = await driver.getReaderParameters();
            expect(result).toHaveLength(28);
            expect(result[WM_INDEX]).toBe(0x02);
        });

        it('returns 27 bytes when reader sends LEN=0x1B (real hardware returns 27, not 28)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeParamResponse(0x02, 27));
            const result = await driver.getReaderParameters();
            expect(result).toHaveLength(27);
            expect(result[WM_INDEX]).toBe(0x02);
        });
    });

    describe('setReaderParameters()', () => {
        it('sends CID1=81H CID2=31H with LENGTH=0x1C (28 bytes, always)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeSetResponse());
            await driver.setReaderParameters(new Uint8Array(28).fill(0x00));
            const [hexArg, cid1Arg] = driver.sendCommand.mock.calls[0];
            expect(hexArg.toUpperCase()).toMatch(/^7CFFFF8131/);
            expect(hexArg.toUpperCase().slice(10, 12)).toBe('1C');
            expect(cid1Arg).toBe(0x81);
        });

        it('always sends LEN=0x1C even when given a 27-byte block (reader silently ignores 27-byte Set)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeSetResponse());
            await driver.setReaderParameters(new Uint8Array(27).fill(0x00));
            const hexArg = driver.sendCommand.mock.calls[0][0].toUpperCase();
            expect(hexArg.slice(10, 12)).toBe('1C');
        });

        it('pads a 27-byte input with MR=0x0A at position 27 (minimum valid MR; 0x00 causes silent flash write rejection)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeSetResponse());
            const params = new Uint8Array(27).fill(0xAB);
            await driver.setReaderParameters(params);
            const hexArg = driver.sendCommand.mock.calls[0][0].toUpperCase();
            const paramsHex = hexArg.slice(12, 12 + 56); // 28 bytes × 2 hex chars
            for (let i = 0; i < 27; i++) {
                expect(paramsHex.slice(i * 2, i * 2 + 2)).toBe('AB');
            }
            expect(paramsHex.slice(54, 56)).toBe('0A'); // MR = 10 (minimum valid, range 10-64 per §4.8)
        });

        it('embeds all 28 param bytes verbatim in the command body', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeSetResponse());
            const params = new Uint8Array(28);
            for (let i = 0; i < 28; i++) params[i] = i + 1;
            await driver.setReaderParameters(params);
            const hexArg = driver.sendCommand.mock.calls[0][0].toUpperCase();
            const paramsHex = hexArg.slice(12, 12 + 56); // 28 bytes × 2 hex chars
            for (let i = 0; i < 28; i++) {
                const expected = (i + 1).toString(16).padStart(2, '0').toUpperCase();
                expect(paramsHex.slice(i * 2, i * 2 + 2)).toBe(expected);
            }
        });
    });

    describe('setWorkMode()', () => {
        // Pure CtrlAutoRead approach — no WM flash writes.
        // Writing WM=0x01 to flash means CtrlAutoRead(1) can't restart the scan loop
        // until the next reboot (which requires a BLE drop). Keeping WM=0x02 in flash
        // (factory default, never overwritten) lets CtrlAutoRead(0/1) control the scan
        // loop instantly and safely. See PROTOCOL_SPEC.md §6 and KNOWN_ISSUES #1.

        it("sends CtrlAutoRead(status=0) for 'command' mode to pause the scan loop", async () => {
            const rawHexSpy = vi.spyOn(driver, 'sendRawHex').mockResolvedValue();
            await driver.setWorkMode('command');
            expect(rawHexSpy).toHaveBeenCalledWith('7CFFFF34000100');
        });

        it("sends CtrlAutoRead(status=1) for 'active' mode to resume the scan loop", async () => {
            const rawHexSpy = vi.spyOn(driver, 'sendRawHex').mockResolvedValue();
            await driver.setWorkMode('active');
            expect(rawHexSpy).toHaveBeenCalledWith('7CFFFF34000101');
        });
    });
});
