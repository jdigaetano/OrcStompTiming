import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// Build a read-back response frame: CC FF FF 12 00 05 [AN] [4 data bytes] [CHKSUM]
function makeReadbackResponse(dataBytes) {
    const frame = [0xCC, 0xFF, 0xFF, 0x12, 0x00, 0x05, 0x01, ...dataBytes];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return new Uint8Array(frame);
}

function makeWriteResponse(rtn = 0x00) {
    const frame = [0xCC, 0xFF, 0xFF, 0x12, rtn, 0x00];
    let sum = 0;
    for (const b of frame) sum += b;
    frame.push(((~sum) + 1) & 0xFF);
    return new Uint8Array(frame);
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

    it('sends a write command targeting EPC bank (MB=01) at byte offset 2 (SA=02)', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand');
        // First call (write) returns success; second call (read-back) returns matching data
        sendCmd
            .mockResolvedValueOnce(makeWriteResponse(0x00))
            .mockResolvedValueOnce(makeReadbackResponse([0x4F, 0x53, 0x00, 0x68])); // bib 104

        await driver.writeBibToEpc(104);

        const [writeHex] = sendCmd.mock.calls[0];
        // Header: 7C FF FF 12 31 07 (CID1=12H CID2=31H LENGTH=07)
        expect(writeHex.toUpperCase()).toMatch(/^7CFFFF123107/);
        // Payload starts at char 12: MB=01 SA=02 DL=02
        expect(writeHex.toUpperCase().slice(12, 18)).toBe('010202');
    });

    it('encodes the magic prefix 0x4F53 followed by the bib as 2-byte big-endian', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand');
        sendCmd
            .mockResolvedValueOnce(makeWriteResponse(0x00))
            .mockResolvedValueOnce(makeReadbackResponse([0x4F, 0x53, 0x00, 0x68]));

        await driver.writeBibToEpc(104);

        const writeHex = sendCmd.mock.calls[0][0].toUpperCase();
        // After header (12 chars) + MB/SA/DL (6 chars): data bytes 4F 53 00 68
        expect(writeHex.slice(18, 26)).toBe('4F530068');
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
            const sendCmd = vi.spyOn(driver, 'sendCommand');
            const bibBytes = [bib >> 8, bib & 0xFF];
            sendCmd
                .mockResolvedValueOnce(makeWriteResponse(0x00))
                .mockResolvedValueOnce(makeReadbackResponse([0x4F, 0x53, ...bibBytes]));

            await driver.writeBibToEpc(bib);

            const writeHex = sendCmd.mock.calls[0][0].toUpperCase();
            expect(writeHex.slice(18, 26)).toBe(hex);
            sendCmd.mockRestore();
        }
    });

    it('sends a read-back command (MB=01, SA=01 word offset, DL=02) after a successful write', async () => {
        const sendCmd = vi.spyOn(driver, 'sendCommand');
        sendCmd
            .mockResolvedValueOnce(makeWriteResponse(0x00))
            .mockResolvedValueOnce(makeReadbackResponse([0x4F, 0x53, 0x00, 0x68]));

        await driver.writeBibToEpc(104);

        expect(sendCmd).toHaveBeenCalledTimes(2);
        const [readHex] = sendCmd.mock.calls[1];
        // CID1=12H, CID2=32H, LENGTH=03, MB=01, SA=01, DL=02
        expect(readHex.toUpperCase()).toMatch(/^7CFFFF123203010102/);
    });

    it('returns {success: true} when read-back bytes match what was written', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makeWriteResponse(0x00))
            .mockResolvedValueOnce(makeReadbackResponse([0x4F, 0x53, 0x00, 0x68]));

        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(true);
    });

    it('returns {success: false} when read-back bytes do not match', async () => {
        vi.spyOn(driver, 'sendCommand')
            .mockResolvedValueOnce(makeWriteResponse(0x00))
            .mockResolvedValueOnce(makeReadbackResponse([0x00, 0x00, 0x00, 0x00])); // wrong

        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(false);
        expect(result.message).toMatch(/verify/i);
    });

    it('returns {success: false} when the write command itself fails (RTN=01)', async () => {
        vi.spyOn(driver, 'sendCommand').mockRejectedValueOnce(new Error('Command failed: reader returned RTN=01'));

        const result = await driver.writeBibToEpc(104);
        expect(result.success).toBe(false);
        expect(result.message).toBeTruthy();
    });
});
