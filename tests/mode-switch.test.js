import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

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

    describe('setWorkMode()', () => {
        // Pure CtrlAutoRead approach — no WM flash writes.
        // Writing WM=0x01 to flash means CtrlAutoRead(1) can't restart the scan loop
        // until the next reboot (which requires a BLE drop). Keeping WM=0x02 in flash
        // (factory default, never overwritten) lets CtrlAutoRead(0/1) control the scan
        // loop instantly and safely. See PROTOCOL_SPEC.md §6 and KNOWN_ISSUES #1.

        it("sends CtrlAutoRead(status=0) for 'command' mode to pause the scan loop", async () => {
            // §6.4 CtrlAutoRead: CID1=34 CID2=00 LEN=01 INFO=00 (stop). Response CID1=0x34.
            const cmdSpy = vi.spyOn(driver, 'sendCommand').mockResolvedValue(new Uint8Array());
            await driver.setWorkMode('command');
            expect(cmdSpy).toHaveBeenCalledWith('7CFFFF34000100', 0x34, 3000);
        });

        it("sends CtrlAutoRead(status=1) for 'active' mode to resume the scan loop", async () => {
            // §6.4 CtrlAutoRead: CID1=34 CID2=00 LEN=01 INFO=01 (start). Response CID1=0x34.
            const cmdSpy = vi.spyOn(driver, 'sendCommand').mockResolvedValue(new Uint8Array());
            await driver.setWorkMode('active');
            expect(cmdSpy).toHaveBeenCalledWith('7CFFFF34000101', 0x34, 3000);
        });

        it("throws for an unrecognised mode string to prevent silent scan-mode activation on typos", async () => {
            await expect(driver.setWorkMode('scanning')).rejects.toThrow(/invalid mode/i);
            await expect(driver.setWorkMode('')).rejects.toThrow(/invalid mode/i);
        });
    });
});
