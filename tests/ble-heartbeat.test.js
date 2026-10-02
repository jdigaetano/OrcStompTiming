import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const BleDriver = loadScript('BleDriver.js');

function makeCharacteristic(uuid, properties) {
    return {
        uuid,
        properties: { write: false, writeWithoutResponse: false, notify: false, ...properties },
        startNotifications: vi.fn().mockResolvedValue(undefined),
        addEventListener: vi.fn(),
        writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
    };
}

function makeService(uuid, characteristics) {
    return { uuid, getCharacteristics: vi.fn().mockResolvedValue(characteristics) };
}

function makeWorkingDevice(services, opts = {}) {
    const server = { getPrimaryServices: vi.fn().mockResolvedValue(services) };
    return {
        id: opts.id || 'test-id',
        name: opts.name || 'TestReader',
        gatt: { connect: vi.fn().mockResolvedValue(server), disconnect: vi.fn(), connected: false },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

describe('BleDriver GATT ping heartbeat', () => {
    let driver;

    beforeEach(() => {
        vi.useFakeTimers();
        global.localStorage.clear();
        driver = new BleDriver();
        driver.writeCharacteristic = {
            writeValueWithoutResponse: vi.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('initializes _heartbeatTimer to null in constructor', () => {
        expect(driver._heartbeatTimer).toBeNull();
    });

    it('_startHeartbeat() calls writeValueWithoutResponse with a null-byte probe on a 25-second interval', async () => {
        const writeSpy = driver.writeCharacteristic.writeValueWithoutResponse;
        driver._startHeartbeat();

        expect(writeSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(25000);
        expect(writeSpy).toHaveBeenCalledTimes(1);
        expect(writeSpy).toHaveBeenCalledWith(new Uint8Array([0x00]));

        await vi.advanceTimersByTimeAsync(25000);
        expect(writeSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT call handleDisconnect when the probe write succeeds (link alive)', async () => {
        const disconnectSpy = vi.spyOn(driver, 'handleDisconnect');
        driver._startHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);

        expect(disconnectSpy).not.toHaveBeenCalled();
    });

    it('calls handleDisconnect when the probe write throws (dead link detected)', async () => {
        driver.writeCharacteristic.writeValueWithoutResponse = vi.fn().mockRejectedValue(new Error('GATT server is disconnected'));
        const disconnectSpy = vi.spyOn(driver, 'handleDisconnect').mockImplementation(() => {});
        driver.intentionalDisconnect = false;
        driver.isAutoReconnecting = false;
        driver._startHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);

        expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('does NOT call handleDisconnect on probe failure when intentionalDisconnect is true', async () => {
        driver.writeCharacteristic.writeValueWithoutResponse = vi.fn().mockRejectedValue(new Error('GATT disconnected'));
        const disconnectSpy = vi.spyOn(driver, 'handleDisconnect').mockImplementation(() => {});
        driver.intentionalDisconnect = true;
        driver.isAutoReconnecting = false;
        driver._startHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);

        expect(disconnectSpy).not.toHaveBeenCalled();
    });

    it('does NOT call handleDisconnect on probe failure when isAutoReconnecting is already true', async () => {
        driver.writeCharacteristic.writeValueWithoutResponse = vi.fn().mockRejectedValue(new Error('GATT disconnected'));
        const disconnectSpy = vi.spyOn(driver, 'handleDisconnect').mockImplementation(() => {});
        driver.intentionalDisconnect = false;
        driver.isAutoReconnecting = true;
        driver._startHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);

        expect(disconnectSpy).not.toHaveBeenCalled();
    });

    it('_stopHeartbeat() prevents any further probes from firing', async () => {
        const writeSpy = driver.writeCharacteristic.writeValueWithoutResponse;
        driver._startHeartbeat();
        driver._stopHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);
        expect(writeSpy).not.toHaveBeenCalled();
    });

    it('_stopHeartbeat() sets _heartbeatTimer back to null', () => {
        driver._startHeartbeat();
        expect(driver._heartbeatTimer).not.toBeNull();
        driver._stopHeartbeat();
        expect(driver._heartbeatTimer).toBeNull();
    });

    it('_startHeartbeat() cancels a previous interval so reconnects never double up the heartbeat', async () => {
        const writeSpy = driver.writeCharacteristic.writeValueWithoutResponse;
        driver._startHeartbeat();
        driver._startHeartbeat(); // second call — should replace, not stack

        await vi.advanceTimersByTimeAsync(25000);
        expect(writeSpy).toHaveBeenCalledTimes(1); // only one probe, not two
    });

    it('establishConnection() starts the heartbeat after reporting READER ONLINE', async () => {
        const startSpy = vi.spyOn(driver, '_startHeartbeat');
        const service = makeService('0000ffe0-0000-1000-8000-00805f9b34fb', [
            makeCharacteristic('0000ffe1-0000-1000-8000-00805f9b34fb', { write: true, notify: true }),
        ]);
        driver.device = makeWorkingDevice([service]);

        await driver.establishConnection();

        expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('handleDisconnect() stops the heartbeat before scheduling a reconnect', () => {
        const stopSpy = vi.spyOn(driver, '_stopHeartbeat');
        driver.intentionalDisconnect = false;
        vi.spyOn(driver, 'attemptReconnect').mockResolvedValue();

        driver.handleDisconnect();

        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('disconnect() stops the heartbeat', async () => {
        const stopSpy = vi.spyOn(driver, '_stopHeartbeat');
        driver.device = { gatt: { connected: false, disconnect: vi.fn() } };

        await driver.disconnect();

        expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    it('heartbeat logs a ping message when fired and an OK message when probe succeeds', async () => {
        const logs = [];
        driver.onLog = (msg) => logs.push(msg);
        driver._startHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);

        expect(logs.some(m => /ping/i.test(m))).toBe(true);
        expect(logs.some(m => /ok/i.test(m))).toBe(true);
    });

    it('heartbeat does not log an extra message on probe failure — LINK LOST from handleDisconnect is enough', async () => {
        driver.writeCharacteristic.writeValueWithoutResponse = vi.fn().mockRejectedValue(new Error('GATT disconnected'));
        vi.spyOn(driver, 'handleDisconnect').mockImplementation(() => {});
        driver.intentionalDisconnect = false;
        driver.isAutoReconnecting = false;
        const logs = [];
        driver.onLog = (msg) => logs.push(msg);
        driver._startHeartbeat();

        await vi.advanceTimersByTimeAsync(25000);

        expect(logs.every(m => !/ok/i.test(m))).toBe(true);
    });

    it('handleDisconnect() is a no-op when isAutoReconnecting is already true (prevents competing loops)', () => {
        driver.intentionalDisconnect = false;
        driver.isAutoReconnecting = true;
        const statuses = [];
        driver.onStatusChange = (msg, connected) => statuses.push({ msg, connected });
        vi.spyOn(driver, 'attemptReconnect').mockResolvedValue();

        driver.handleDisconnect();

        expect(statuses).toHaveLength(0);
        expect(driver.attemptReconnect).not.toHaveBeenCalled();
    });
});
