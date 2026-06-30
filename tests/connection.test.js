import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Helper to load and evaluate our browser scripts in the test environment
const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const BleDriver = loadScript('BleDriver.js');

function makeCharacteristic(uuid, properties, overrides = {}) {
    return {
        uuid,
        properties: { write: false, writeWithoutResponse: false, notify: false, ...properties },
        startNotifications: vi.fn().mockResolvedValue(undefined),
        addEventListener: vi.fn(),
        writeValue: vi.fn().mockResolvedValue(undefined),
        writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeService(uuid, characteristics) {
    return {
        uuid,
        getCharacteristics: vi.fn().mockResolvedValue(characteristics),
    };
}

function makeWorkingDevice(services, { id = 'test-device-id', name = 'OrcStompReader' } = {}) {
    const server = { getPrimaryServices: vi.fn().mockResolvedValue(services) };
    return {
        id,
        name,
        gatt: {
            connect: vi.fn().mockResolvedValue(server),
            disconnect: vi.fn(),
            connected: false,
        },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

describe('BleDriver Connection Lifecycle', () => {
    let driver;

    beforeEach(() => {
        global.localStorage.clear();
        driver = new BleDriver();
        global.navigator.bluetooth.requestDevice = vi.fn();
        global.navigator.bluetooth.getDevices = vi.fn().mockResolvedValue([]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('connect()', () => {
        it('requests a device, establishes the GATT connection, and reports READER ONLINE on success', async () => {
            const notifyChar = makeCharacteristic('0000ffe2-0000-1000-8000-00805f9b34fb', { notify: true });
            const writeChar = makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true });
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [notifyChar, writeChar]);
            const device = makeWorkingDevice([service]);
            global.navigator.bluetooth.requestDevice.mockResolvedValue(device);

            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            const result = await driver.connect();

            expect(result).toBe(true);
            expect(device.addEventListener).toHaveBeenCalledWith('gattserverdisconnected', expect.any(Function));
            expect(notifyChar.startNotifications).toHaveBeenCalled();
            expect(statuses.at(-1)).toEqual({ msg: 'READER ONLINE', connected: true });
        });

        it('resets intentionalDisconnect to false at the start of a new attempt', async () => {
            driver.intentionalDisconnect = true;
            const service = makeService('ffe0', [makeCharacteristic('ffe1', { write: true, notify: true })]);
            global.navigator.bluetooth.requestDevice.mockResolvedValue(makeWorkingDevice([service]));

            await driver.connect();

            expect(driver.intentionalDisconnect).toBe(false);
        });

        it('uses an ffe0 service filter (not acceptAllDevices) to narrow the device picker', async () => {
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [
                makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true }),
            ]);
            global.navigator.bluetooth.requestDevice.mockResolvedValue(makeWorkingDevice([service]));
            await driver.connect();
            const callArgs = global.navigator.bluetooth.requestDevice.mock.calls[0][0];
            expect(callArgs.filters).toBeDefined();
            expect(callArgs.acceptAllDevices).toBeUndefined();
            expect(callArgs.filters[0].services).toContain('0000ffe0-0000-1000-8000-00805f9b34fb');
        });

        it('saves the device id to localStorage after a successful connection', async () => {
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [
                makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true }),
            ]);
            global.navigator.bluetooth.requestDevice.mockResolvedValue(
                makeWorkingDevice([service], { id: 'abc-123', name: 'MyReader' })
            );
            await driver.connect();
            expect(global.localStorage.getItem('bleDeviceId')).toBe('abc-123');
        });

        it('saves the device name to localStorage after a successful connection', async () => {
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [
                makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true }),
            ]);
            global.navigator.bluetooth.requestDevice.mockResolvedValue(
                makeWorkingDevice([service], { id: 'abc-123', name: 'MyReader' })
            );
            await driver.connect();
            expect(global.localStorage.getItem('bleDeviceName')).toBe('MyReader');
        });

        it('surfaces a Discovery Error and never attempts a GATT connection if requestDevice rejects', async () => {
            global.navigator.bluetooth.requestDevice.mockRejectedValue(new Error('User cancelled the requestDevice() chooser.'));
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            await expect(driver.connect()).rejects.toThrow('User cancelled the requestDevice() chooser.');

            expect(statuses.at(-1)).toEqual({ msg: 'Discovery Error: User cancelled the requestDevice() chooser.', connected: false });
            expect(driver.server).toBeNull();
        });
    });

    describe('connectGatt() retry/backoff', () => {
        it('succeeds on the first attempt without retrying or disconnecting', async () => {
            const server = { getPrimaryServices: vi.fn().mockResolvedValue([]) };
            driver.device = { gatt: { connect: vi.fn().mockResolvedValue(server), disconnect: vi.fn() } };

            const result = await driver.connectGatt(4);

            expect(result).toBe(server);
            expect(driver.device.gatt.connect).toHaveBeenCalledTimes(1);
            expect(driver.device.gatt.disconnect).not.toHaveBeenCalled();
        });

        it('retries with a disconnect between attempts and recovers if a later attempt succeeds', async () => {
            const server = { getPrimaryServices: vi.fn().mockResolvedValue([]) };
            const connectMock = vi.fn()
                .mockRejectedValueOnce(new Error('Connection attempt failed.'))
                .mockRejectedValueOnce(new Error('Connection attempt failed.'))
                .mockResolvedValueOnce(server);
            driver.device = { gatt: { connect: connectMock, disconnect: vi.fn() } };

            const result = await driver.connectGatt(3);

            expect(result).toBe(server);
            expect(connectMock).toHaveBeenCalledTimes(3);
            expect(driver.device.gatt.disconnect).toHaveBeenCalledTimes(2);
        }, 10000);

        it('gives up after maxAttempts with an actionable error message, disconnecting between failures but not after the last one', async () => {
            const connectMock = vi.fn().mockRejectedValue(new Error('Connection attempt failed.'));
            driver.device = { gatt: { connect: connectMock, disconnect: vi.fn() } };

            await expect(driver.connectGatt(2)).rejects.toThrow(
                /Still failing after 2 attempts \(Connection attempt failed\.\) Try power-cycling the reader, or toggling Bluetooth off\/on in Windows Settings\./
            );

            expect(connectMock).toHaveBeenCalledTimes(2);
            expect(driver.device.gatt.disconnect).toHaveBeenCalledTimes(1);
        }, 10000);
    });

    describe('establishConnection() characteristic mapping', () => {
        it('throws "No device selected" if no device has been chosen yet', async () => {
            driver.device = null;
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            await expect(driver.establishConnection()).rejects.toThrow('No device selected');
            expect(statuses.at(-1)).toEqual({ msg: 'Connection Error: No device selected', connected: false });
        });

        it('maps a dedicated ffe2 notify characteristic and ffe1 write characteristic when both exist separately', async () => {
            const notifyChar = makeCharacteristic('0000ffe2-0000-1000-8000-00805f9b34fb', { notify: true });
            const writeChar = makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true });
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [notifyChar, writeChar]);
            driver.device = makeWorkingDevice([service]);

            await driver.establishConnection();

            expect(driver.notifyCharacteristic).toBe(notifyChar);
            expect(driver.writeCharacteristic).toBe(writeChar);
            expect(notifyChar.startNotifications).toHaveBeenCalled();
        });

        it('falls back to a single ffe1 characteristic for both notify and write when no separate ffe2/ffe3 exists', async () => {
            const onlyChar = makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true });
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [onlyChar]);
            driver.device = makeWorkingDevice([service]);

            await driver.establishConnection();

            expect(driver.notifyCharacteristic).toBe(onlyChar);
            expect(driver.writeCharacteristic).toBe(onlyChar);
            expect(onlyChar.startNotifications).toHaveBeenCalled();
        });

        it('rejects with a clear error when no service matches the ffe filter', async () => {
            const unrelatedService = makeService('0000180a-0000-1000-8000-00805f9b34fb', []);
            driver.device = makeWorkingDevice([unrelatedService]);
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            await expect(driver.establishConnection()).rejects.toThrow(
                /No usable characteristics found/
            );
            expect(statuses.at(-1).connected).toBe(false);
        });
    });

    describe('handleDisconnect() / attemptReconnect() auto-reconnect loop', () => {
        it('flags an unintentional drop, clears the stale pipes, and schedules a reconnect attempt', () => {
            vi.useFakeTimers();
            driver.intentionalDisconnect = false;
            driver.server = {};
            driver.writeCharacteristic = {};
            driver.notifyCharacteristic = {};
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });
            const reconnectSpy = vi.spyOn(driver, 'attemptReconnect').mockResolvedValue();

            driver.handleDisconnect();

            expect(driver.isAutoReconnecting).toBe(true);
            expect(driver.server).toBeNull();
            expect(driver.writeCharacteristic).toBeNull();
            expect(driver.notifyCharacteristic).toBeNull();
            expect(statuses.at(-1)).toEqual({ msg: 'LINK LOST - RECONNECTING...', connected: false });

            vi.advanceTimersByTime(2000);
            expect(reconnectSpy).toHaveBeenCalledTimes(1);
        });

        it('does nothing on an intentional disconnect', () => {
            driver.intentionalDisconnect = true;
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            driver.handleDisconnect();

            expect(driver.isAutoReconnecting).toBe(false);
            expect(statuses).toHaveLength(0);
        });

        it('keeps rescheduling itself on repeated failure while isAutoReconnecting stays true', async () => {
            vi.useFakeTimers();
            driver.isAutoReconnecting = true;
            driver.intentionalDisconnect = false;
            vi.spyOn(driver, 'establishConnection').mockRejectedValue(new Error('No device selected'));

            await driver.attemptReconnect();
            expect(driver.establishConnection).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(4000);
            expect(driver.establishConnection).toHaveBeenCalledTimes(2);
        });

        it('stops rescheduling once isAutoReconnecting is turned off', async () => {
            vi.useFakeTimers();
            driver.isAutoReconnecting = true;
            driver.intentionalDisconnect = false;
            vi.spyOn(driver, 'establishConnection').mockRejectedValue(new Error('No device selected'));

            await driver.attemptReconnect();
            expect(driver.establishConnection).toHaveBeenCalledTimes(1);

            driver.isAutoReconnecting = false;
            await vi.advanceTimersByTimeAsync(4000);
            expect(driver.establishConnection).toHaveBeenCalledTimes(1);
        });
    });

    describe('disconnect()', () => {
        it('marks the disconnect intentional and tears down an active GATT link', async () => {
            driver.device = { gatt: { connected: true, disconnect: vi.fn().mockResolvedValue(undefined) } };
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            await driver.disconnect();

            expect(driver.intentionalDisconnect).toBe(true);
            expect(driver.isAutoReconnecting).toBe(false);
            expect(driver.device.gatt.disconnect).toHaveBeenCalled();
            expect(statuses.at(-1)).toEqual({ msg: 'READER OFFLINE', connected: false });
        });

        it('does not call gatt.disconnect when not currently connected', async () => {
            driver.device = { gatt: { connected: false, disconnect: vi.fn() } };

            await driver.disconnect();

            expect(driver.device.gatt.disconnect).not.toHaveBeenCalled();
        });

        it('is safe to call with no device at all', async () => {
            driver.device = null;
            const statuses = [];
            driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });

            await expect(driver.disconnect()).resolves.toBeUndefined();
            expect(statuses.at(-1)).toEqual({ msg: 'READER OFFLINE', connected: false });
        });

        it('clears bleDeviceId from localStorage (disconnect = forget device)', async () => {
            global.localStorage.setItem('bleDeviceId', 'abc-123');
            driver.device = { gatt: { connected: false, disconnect: vi.fn() } };
            await driver.disconnect();
            expect(global.localStorage.getItem('bleDeviceId')).toBeNull();
        });

        it('clears bleDeviceName from localStorage', async () => {
            global.localStorage.setItem('bleDeviceName', 'MyReader');
            driver.device = { gatt: { connected: false, disconnect: vi.fn() } };
            await driver.disconnect();
            expect(global.localStorage.getItem('bleDeviceName')).toBeNull();
        });
    });

    describe('tryAutoConnect()', () => {
        it('returns false when no device id is saved in localStorage', async () => {
            expect(await driver.tryAutoConnect()).toBe(false);
        });

        it('returns false when navigator.bluetooth.getDevices is not available', async () => {
            global.localStorage.setItem('bleDeviceId', 'abc-123');
            const origGetDevices = global.navigator.bluetooth.getDevices;
            delete global.navigator.bluetooth.getDevices;

            expect(await driver.tryAutoConnect()).toBe(false);

            global.navigator.bluetooth.getDevices = origGetDevices;
        });

        it('returns false when the saved device id is not found in getDevices() results', async () => {
            global.localStorage.setItem('bleDeviceId', 'abc-123');
            global.navigator.bluetooth.getDevices.mockResolvedValue([
                makeWorkingDevice([], { id: 'different-id' }),
            ]);
            expect(await driver.tryAutoConnect()).toBe(false);
        });

        it('calls establishConnection() directly on the saved device when found', async () => {
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [
                makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true }),
            ]);
            const savedDevice = makeWorkingDevice([service], { id: 'abc-123' });
            global.localStorage.setItem('bleDeviceId', 'abc-123');
            global.navigator.bluetooth.getDevices.mockResolvedValue([savedDevice]);

            const establishSpy = vi.spyOn(driver, 'establishConnection').mockResolvedValue(true);
            await driver.tryAutoConnect();

            expect(driver.device).toBe(savedDevice);
            expect(establishSpy).toHaveBeenCalledTimes(1);
            expect(global.navigator.bluetooth.requestDevice).not.toHaveBeenCalled();
        });

        it('returns true on a successful auto-connect', async () => {
            const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [
                makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true }),
            ]);
            global.localStorage.setItem('bleDeviceId', 'abc-123');
            global.navigator.bluetooth.getDevices.mockResolvedValue([
                makeWorkingDevice([service], { id: 'abc-123' }),
            ]);
            expect(await driver.tryAutoConnect()).toBe(true);
        });

        it('returns false and does not throw when establishConnection() rejects', async () => {
            global.localStorage.setItem('bleDeviceId', 'abc-123');
            global.navigator.bluetooth.getDevices.mockResolvedValue([
                makeWorkingDevice([], { id: 'abc-123' }),
            ]);
            vi.spyOn(driver, 'establishConnection').mockRejectedValue(new Error('No usable characteristics found'));
            expect(await driver.tryAutoConnect()).toBe(false);
        });
    });
});
