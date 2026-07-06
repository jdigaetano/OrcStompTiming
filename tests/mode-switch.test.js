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

function makeParamResponse(wmByte) {
    const params = new Uint8Array(28);
    params[WM_INDEX] = wmByte;
    const frame = [0xCC, 0xFF, 0xFF, 0x81, 0x00, 0x1C, ...params];
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

        it('returns the 28-byte INFO block from the response', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeParamResponse(0x02));
            const result = await driver.getReaderParameters();
            expect(result).toHaveLength(28);
            expect(result[WM_INDEX]).toBe(0x02);
        });
    });

    describe('setReaderParameters()', () => {
        it('sends CID1=81H CID2=31H with LENGTH=0x1C (Set Basic Parameters)', async () => {
            vi.spyOn(driver, 'sendCommand').mockResolvedValue(makeSetResponse());
            await driver.setReaderParameters(new Uint8Array(28).fill(0x00));
            const [hexArg, cid1Arg] = driver.sendCommand.mock.calls[0];
            expect(hexArg.toUpperCase()).toMatch(/^7CFFFF8131/);
            expect(hexArg.toUpperCase().slice(10, 12)).toBe('1C');
            expect(cid1Arg).toBe(0x81);
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
        it("sets WM byte to 0x01 for 'command' mode", async () => {
            vi.spyOn(driver, 'getReaderParameters').mockResolvedValue(makeParamResponse(0x02).slice(6, 34));
            vi.spyOn(driver, 'setReaderParameters').mockResolvedValue();
            await driver.setWorkMode('command');
            expect(driver.setReaderParameters.mock.calls[0][0][WM_INDEX]).toBe(0x01);
        });

        it("sets WM byte to 0x02 for 'active' mode", async () => {
            vi.spyOn(driver, 'getReaderParameters').mockResolvedValue(makeParamResponse(0x01).slice(6, 34));
            vi.spyOn(driver, 'setReaderParameters').mockResolvedValue();
            await driver.setWorkMode('active');
            expect(driver.setReaderParameters.mock.calls[0][0][WM_INDEX]).toBe(0x02);
        });

        it('does not modify any byte other than WM (index 9)', async () => {
            const params = new Uint8Array(28);
            for (let i = 0; i < 28; i++) params[i] = i + 1;
            vi.spyOn(driver, 'getReaderParameters').mockResolvedValue(params);
            vi.spyOn(driver, 'setReaderParameters').mockResolvedValue();
            await driver.setWorkMode('command');
            const written = driver.setReaderParameters.mock.calls[0][0];
            for (let i = 0; i < 28; i++) {
                if (i === WM_INDEX) continue;
                expect(written[i]).toBe(params[i]);
            }
        });
    });
});
