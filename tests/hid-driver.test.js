import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const makeMockDevice = (overrides = {}) => {
    const device = {
        vendorId: 0x04D8,
        opened: false,
        open: vi.fn().mockImplementation(() => { device.opened = true; return Promise.resolve(); }),
        close: vi.fn().mockImplementation(() => { device.opened = false; return Promise.resolve(); }),
        sendReport: vi.fn().mockResolvedValue(undefined),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...overrides,
    };
    return device;
};

describe('HidDriver', () => {
    let HidDriver, driver;

    beforeEach(() => {
        vi.clearAllMocks();
        global.navigator.hid.requestDevice.mockResolvedValue([]);
        global.navigator.hid.getDevices.mockResolvedValue([]);
        HidDriver = loadScript('HidDriver.js');
        driver = new HidDriver();
    });

    describe('connect()', () => {
        it('calls requestDevice with vendorId 0x04D8, opens device, fires onStatusChange online', async () => {
            const device = makeMockDevice();
            global.navigator.hid.requestDevice.mockResolvedValue([device]);

            const statusChanges = [];
            driver.onStatusChange = (msg, connected) => statusChanges.push({ msg, connected });

            await driver.connect();

            expect(global.navigator.hid.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 0x04D8 }] });
            expect(device.open).toHaveBeenCalled();
            expect(statusChanges).toContainEqual({ msg: 'READER ONLINE', connected: true });
        });

        it('throws if requestDevice returns no device (user cancelled)', async () => {
            global.navigator.hid.requestDevice.mockResolvedValue([]);
            await expect(driver.connect()).rejects.toThrow('No device selected');
        });

        it('registers an inputreport listener on the device', async () => {
            const device = makeMockDevice();
            global.navigator.hid.requestDevice.mockResolvedValue([device]);
            await driver.connect();
            expect(device.addEventListener).toHaveBeenCalledWith('inputreport', expect.any(Function));
        });
    });

    describe('tryAutoConnect()', () => {
        it('returns true and fires READER ONLINE when getDevices returns the reader', async () => {
            const device = makeMockDevice();
            global.navigator.hid.getDevices.mockResolvedValue([device]);

            const statusChanges = [];
            driver.onStatusChange = (msg, connected) => statusChanges.push({ msg, connected });

            const ok = await driver.tryAutoConnect();
            expect(ok).toBe(true);
            expect(statusChanges).toContainEqual({ msg: 'READER ONLINE', connected: true });
        });

        it('returns false when getDevices returns an empty array', async () => {
            global.navigator.hid.getDevices.mockResolvedValue([]);
            const ok = await driver.tryAutoConnect();
            expect(ok).toBe(false);
        });

        it('returns false when navigator.hid is unavailable', async () => {
            const saved = global.navigator.hid;
            global.navigator.hid = undefined;
            const ok = await driver.tryAutoConnect();
            expect(ok).toBe(false);
            global.navigator.hid = saved;
        });
    });

    describe('disconnect()', () => {
        it('closes device, nulls this.device, fires onStatusChange offline', async () => {
            const device = makeMockDevice({ opened: true });
            driver.device = device;
            driver.intentionalDisconnect = false;

            const statusChanges = [];
            driver.onStatusChange = (msg, connected) => statusChanges.push({ msg, connected });

            await driver.disconnect();

            expect(device.close).toHaveBeenCalled();
            expect(driver.device).toBeNull();
            expect(statusChanges).toContainEqual({ msg: 'READER OFFLINE', connected: false });
        });

        it('sets intentionalDisconnect so the disconnect event handler stays quiet', async () => {
            const device = makeMockDevice({ opened: true });
            driver.device = device;
            await driver.disconnect();
            expect(driver.intentionalDisconnect).toBe(true);
        });
    });

    describe('isConnected getter', () => {
        it('is true when device exists and is opened', () => {
            driver.device = { opened: true };
            expect(driver.isConnected).toBe(true);
        });

        it('is false when device is null', () => {
            driver.device = null;
            expect(driver.isConnected).toBe(false);
        });

        it('is false when device exists but opened is false', () => {
            driver.device = { opened: false };
            expect(driver.isConnected).toBe(false);
        });
    });

    describe('_handleDisconnect()', () => {
        it('fires READER OFFLINE - USB UNPLUGGED when disconnect was not intentional', () => {
            driver.intentionalDisconnect = false;
            const statusChanges = [];
            driver.onStatusChange = (msg, connected) => statusChanges.push({ msg, connected });

            driver._handleDisconnect();

            expect(statusChanges).toContainEqual({ msg: 'READER OFFLINE - USB UNPLUGGED', connected: false });
        });

        it('does nothing when intentionalDisconnect is true', () => {
            driver.intentionalDisconnect = true;
            const statusChanges = [];
            driver.onStatusChange = (msg, connected) => statusChanges.push({ msg, connected });

            driver._handleDisconnect();

            expect(statusChanges).toHaveLength(0);
        });
    });

    describe('sendRawHex()', () => {
        beforeEach(() => {
            driver.device = makeMockDevice({ opened: true });
        });

        it('calls device.sendReport(0, Uint8Array)', async () => {
            await driver.sendRawHex('7CFFFF34000100');
            expect(driver.device.sendReport).toHaveBeenCalledWith(0, expect.any(Uint8Array));
        });

        it('auto-appends Two\'s Complement checksum for 7C frames missing it, padded to 64 bytes', async () => {
            // '7CFFFF34000100' = 7 bytes. LEN byte (index 5) = 0x01, so 6+1=7 = frame without checksum.
            // Checksum auto-append adds 1 byte (8 frame bytes), then padded to 64 for HID report size.
            await driver.sendRawHex('7CFFFF34000100');
            const sentData = driver.device.sendReport.mock.calls[0][1];
            expect(sentData).toHaveLength(64);
            // Frame bytes sum to 0 (valid checksum); trailing zeros don't change that
            const sum = Array.from(sentData).reduce((a, b) => a + b, 0);
            expect(sum & 0xFF).toBe(0);
            // Trailing bytes beyond the frame must be zero
            expect(Array.from(sentData).slice(8)).toEqual(new Array(56).fill(0));
        });

        it('does not append checksum if frame already has it, still pads to 64 bytes', async () => {
            // '7CFFFF34000100CB' = 8 bytes (LEN=1, so 6+1+1=8 = frame already includes checksum slot)
            await driver.sendRawHex('7CFFFF34000100CB');
            const sentData = driver.device.sendReport.mock.calls[0][1];
            expect(sentData).toHaveLength(64);
            expect(sentData[0]).toBe(0x7C);
            expect(Array.from(sentData).slice(8)).toEqual(new Array(56).fill(0));
        });

        it('throws if device is null', async () => {
            driver.device = null;
            await expect(driver.sendRawHex('7CFFFF34000100')).rejects.toThrow('No write pipe available');
        });
    });

    describe('parseFrame() — HID event shape (event.data, not event.target.value)', () => {
        it('fires onTagRead for a valid tag frame', () => {
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });

            // AN=0x00, PC=0x1000 (4-byte EPC), EPC AA BB CC DD, RSSI 0xCE (-50 dBm)
            const frameBytes = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0xF0];
            const dataView = { byteLength: frameBytes.length, getUint8: i => frameBytes[i] };

            driver.parseFrame({ data: dataView, reportId: 0 });

            expect(results).toHaveLength(1);
            expect(results[0]).toEqual({ tag: 'AABBCCDD', rssi: -50 });
        });

        it('does not fire onTagRead for a frame with a bad checksum', () => {
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            // Valid frame with last byte flipped 0xF0 -> 0x00
            const frameBytes = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0x00];
            const dataView = { byteLength: frameBytes.length, getUint8: i => frameBytes[i] };

            driver.parseFrame({ data: dataView, reportId: 0 });

            expect(results).toHaveLength(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Checksum mismatch'), expect.any(String));
            warnSpy.mockRestore();
        });

        it('fires onRawFrame for every frame regardless of checksum validity', () => {
            const onRawFrame = vi.fn();
            driver.onRawFrame = onRawFrame;
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const frameBytes = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0xF0];
            const dataView = { byteLength: frameBytes.length, getUint8: i => frameBytes[i] };

            driver.parseFrame({ data: dataView, reportId: 0 });

            expect(onRawFrame).toHaveBeenCalledWith(expect.objectContaining({
                checksumValid: true,
                tagDecode: expect.objectContaining({ epcHex: 'AABBCCDD' }),
            }));
            warnSpy.mockRestore();
        });
    });

    describe('setWorkMode()', () => {
        it("sends CtrlAutoRead(0) for 'command' mode", async () => {
            const spy = vi.spyOn(driver, 'sendRawHex').mockResolvedValue();
            await driver.setWorkMode('command');
            expect(spy).toHaveBeenCalledWith('7CFFFF34000100');
        });

        it("sends CtrlAutoRead(1) for 'active' mode", async () => {
            const spy = vi.spyOn(driver, 'sendRawHex').mockResolvedValue();
            await driver.setWorkMode('active');
            expect(spy).toHaveBeenCalledWith('7CFFFF34000101');
        });
    });
});
