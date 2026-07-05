import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const loadIndexBody = () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    document.body.innerHTML = body;
};

const TimingEngine = loadScript('TimingEngine.js');

function makeMockHandle(name = 'orcstomp-backup.json') {
    const writable = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    return {
        name,
        createWritable: vi.fn().mockResolvedValue(writable),
        queryPermission: vi.fn().mockResolvedValue('granted'),
        requestPermission: vi.fn().mockResolvedValue('granted'),
        _writable: writable,
    };
}

// ─── TimingEngine: backup handle storage + raw snapshot ────────────────────

describe('TimingEngine: backup storage', () => {
    let engine;

    beforeEach(async () => {
        global.localStorage.clear();
        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
    });

    it('getBackupHandle() returns null when nothing has been saved', async () => {
        expect(await engine.getBackupHandle()).toBeNull();
    });

    it('saveBackupHandle()/getBackupHandle() round-trip a plain serializable object', async () => {
        const fakeHandle = { name: 'orcstomp-backup.json', mock: true };
        await engine.saveBackupHandle(fakeHandle);
        const result = await engine.getBackupHandle();
        expect(result).toEqual(fakeHandle);
    });

    it('saveBackupHandle() overwrites a previously saved handle', async () => {
        await engine.saveBackupHandle({ name: 'old.json' });
        await engine.saveBackupHandle({ name: 'new.json' });
        expect(await engine.getBackupHandle()).toEqual({ name: 'new.json' });
    });

    it('getRawSnapshot() returns raceStartTime, race_reads, and chip_map with zero computation', async () => {
        engine.raceStartTime = '2026-07-05T10:00:00.000Z';
        await engine.saveMapping('AABBCCDD', 104);
        engine.isTrackingRace = true;
        engine.handleIncomingTag('AABBCCDD', -50);
        await new Promise(r => setTimeout(r, 300)); // let the write daemon flush

        const snapshot = await engine.getRawSnapshot();
        expect(snapshot.raceStartTime).toBe('2026-07-05T10:00:00.000Z');
        expect(snapshot.chip_map).toEqual([{ chip_hex: 'AABBCCDD', bib_num: 104 }]);
        expect(snapshot.race_reads).toHaveLength(1);
        expect(snapshot.race_reads[0].tag_hex).toBe('AABBCCDD');
    });
});

// ─── AppUI: backup orchestration ────────────────────────────────────────────

function makeStubEngine(overrides = {}) {
    return {
        ready: Promise.resolve(),
        onRecordPersisted: null,
        raceStartTime: null,
        isTrackingRace: false,
        getMappings: () => Promise.resolve([]),
        getAllFromStore: vi.fn().mockResolvedValue([]),
        getRawSnapshot: vi.fn().mockResolvedValue({ raceStartTime: null, race_reads: [], chip_map: [] }),
        getBackupHandle: vi.fn().mockResolvedValue(null),
        saveBackupHandle: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function makeUi(engineOverrides = {}) {
    loadScript('BleDriver.js');
    const AppUI = loadScript('AppUI.js');
    const ui = Object.create(AppUI.prototype);
    ui.engine = makeStubEngine(engineOverrides);
    ui.driver = { onTagRead: null, onStatusChange: null, onRawFrame: null };
    ui.clockInterval = null;
    ui.backupInterval = null;
    ui.totalReads = 0;
    ui.uniqueTags = new Set();
    return ui;
}

describe('AppUI.writeSnapshotToFile()', () => {
    it('writes JSON to the handle and closes the writable stream', async () => {
        const handle = makeMockHandle();
        const ui = makeUi();
        const snapshot = { raceStartTime: null, race_reads: [], chip_map: [] };

        await ui.writeSnapshotToFile(handle, snapshot);

        expect(handle.createWritable).toHaveBeenCalled();
        expect(handle._writable.write).toHaveBeenCalledWith(JSON.stringify(snapshot, null, 2));
        expect(handle._writable.close).toHaveBeenCalled();
    });
});

describe('AppUI.performLiveBackup()', () => {
    it('does nothing when no backup location is set', async () => {
        const ui = makeUi();
        ui.backupHandle = null;
        const result = await ui.performLiveBackup();
        expect(result).toBe(false);
        expect(ui.engine.getRawSnapshot).not.toHaveBeenCalled();
    });

    it('writes a fresh raw snapshot to the backup file when a location is set', async () => {
        const handle = makeMockHandle();
        const snapshot = { raceStartTime: '2026-07-05T10:00:00.000Z', race_reads: [{ tag_hex: 'AAAA' }], chip_map: [] };
        const ui = makeUi({ getRawSnapshot: vi.fn().mockResolvedValue(snapshot) });
        ui.backupHandle = handle;

        const result = await ui.performLiveBackup();

        expect(result).toBe(true);
        expect(ui.engine.getRawSnapshot).toHaveBeenCalled();
        expect(handle._writable.write).toHaveBeenCalledWith(JSON.stringify(snapshot, null, 2));
    });
});

describe('AppUI.downloadStandingsCsv()', () => {
    it('returns false and does not build a CSV when there are no race reads', async () => {
        const ui = makeUi({ getAllFromStore: vi.fn().mockResolvedValue([]) });
        const spy = vi.spyOn(ui, 'buildCsvString');
        const result = await ui.downloadStandingsCsv();
        expect(result).toBe(false);
        expect(spy).not.toHaveBeenCalled();
    });

    it('builds and downloads a CSV when there are race reads', async () => {
        const reads = [{ tag_hex: 'AABBCCDD', rssi: -50, timestamp: '2026-07-05T10:00:05.000Z' }];
        const ui = makeUi({
            raceStartTime: '2026-07-05T10:00:00.000Z',
            getAllFromStore: vi.fn((store) => Promise.resolve(store === 'race_reads' ? reads : [])),
        });
        ui.engine.raceStartTime = '2026-07-05T10:00:00.000Z';
        const clickSpy = vi.fn();
        const originalCreateElement = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tag) => {
            const el = originalCreateElement(tag);
            if (tag === 'a') el.click = clickSpy;
            return el;
        });

        const result = await ui.downloadStandingsCsv();

        expect(result).toBe(true);
        expect(clickSpy).toHaveBeenCalled();
        document.createElement.mockRestore();
    });
});

describe('AppUI.performHeavyBackup()', () => {
    it('performs a live backup and then attempts the standings download', async () => {
        const ui = makeUi();
        const liveSpy = vi.spyOn(ui, 'performLiveBackup').mockResolvedValue(true);
        const csvSpy = vi.spyOn(ui, 'downloadStandingsCsv').mockResolvedValue(false);

        await ui.performHeavyBackup();

        expect(liveSpy).toHaveBeenCalled();
        expect(csvSpy).toHaveBeenCalled();
    });
});

describe('AppUI.buildWipeConfirmMessage()', () => {
    it('mentions only race reads when includeMappings is false', () => {
        const ui = makeUi();
        const msg = ui.buildWipeConfirmMessage(214, 0, false);
        expect(msg).toContain('214');
        expect(msg).not.toMatch(/mapping/i);
        expect(msg).toMatch(/backup/i);
    });

    it('mentions both race reads and mappings when includeMappings is true', () => {
        const ui = makeUi();
        const msg = ui.buildWipeConfirmMessage(214, 87, true);
        expect(msg).toContain('214');
        expect(msg).toContain('87');
        expect(msg).toMatch(/mapping/i);
    });
});

describe('AppUI.chooseBackupLocation()', () => {
    let ui;

    beforeEach(() => {
        loadIndexBody();
        ui = makeUi();
    });

    afterEach(() => {
        delete global.window.showSaveFilePicker;
    });

    it('alerts and returns false when showSaveFilePicker is unsupported', async () => {
        delete global.window.showSaveFilePicker;
        global.alert = vi.fn();

        const result = await ui.chooseBackupLocation();

        expect(result).toBe(false);
        expect(global.alert).toHaveBeenCalled();
        expect(ui.engine.saveBackupHandle).not.toHaveBeenCalled();
    });

    it('saves the picked handle and updates the label when supported', async () => {
        const handle = makeMockHandle('my-backup.json');
        global.window.showSaveFilePicker = vi.fn().mockResolvedValue(handle);

        const result = await ui.chooseBackupLocation();

        expect(result).toBe(true);
        expect(ui.backupHandle).toBe(handle);
        expect(ui.engine.saveBackupHandle).toHaveBeenCalledWith(handle);
        expect(document.getElementById('backupLocationLabel').textContent).toContain('my-backup.json');
    });

    it('quietly returns false when the user cancels the native picker (AbortError), without alerting', async () => {
        const abortError = new DOMException('The user aborted a request.', 'AbortError');
        global.window.showSaveFilePicker = vi.fn().mockRejectedValue(abortError);
        global.alert = vi.fn();

        const result = await ui.chooseBackupLocation();

        expect(result).toBe(false);
        expect(global.alert).not.toHaveBeenCalled();
        expect(ui.backupHandle).toBeFalsy();
    });

    it('alerts (instead of throwing unhandled) when saving the handle fails for any other reason', async () => {
        const handle = makeMockHandle('my-backup.json');
        global.window.showSaveFilePicker = vi.fn().mockResolvedValue(handle);
        ui.engine.saveBackupHandle = vi.fn().mockRejectedValue(new Error('could not be cloned'));
        global.alert = vi.fn();

        const result = await ui.chooseBackupLocation();

        expect(result).toBe(false);
        expect(global.alert).toHaveBeenCalled();
    });
});

describe('AppUI.restoreBackupHandle()', () => {
    let ui;

    beforeEach(() => {
        loadIndexBody();
    });

    it('shows "no backup location set" when nothing was saved', async () => {
        ui = makeUi({ getBackupHandle: vi.fn().mockResolvedValue(null) });
        await ui.restoreBackupHandle();
        expect(ui.backupHandle).toBeFalsy();
        expect(document.getElementById('backupLocationLabel').textContent).toMatch(/no backup/i);
    });

    it('restores a saved handle with granted permission silently', async () => {
        const handle = makeMockHandle('restored.json');
        ui = makeUi({ getBackupHandle: vi.fn().mockResolvedValue(handle) });
        await ui.restoreBackupHandle();
        expect(ui.backupHandle).toBe(handle);
        expect(document.getElementById('backupLocationLabel').textContent).toContain('restored.json');
    });

    it('falls back to "no backup location set" when permission is denied', async () => {
        const handle = makeMockHandle('denied.json');
        handle.queryPermission = vi.fn().mockResolvedValue('denied');
        handle.requestPermission = vi.fn().mockResolvedValue('denied');
        ui = makeUi({ getBackupHandle: vi.fn().mockResolvedValue(handle) });
        await ui.restoreBackupHandle();
        expect(ui.backupHandle).toBeFalsy();
        expect(document.getElementById('backupLocationLabel').textContent).toMatch(/no backup/i);
    });
});

describe('AppUI.toggleRace(): live backup timer wiring', () => {
    let ui;

    beforeEach(() => {
        global.localStorage.clear();
        loadIndexBody();
        ui = makeUi();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        global.localStorage.clear();
    });

    it('starts a periodic live-backup timer when the race starts', async () => {
        const liveSpy = vi.spyOn(ui, 'performLiveBackup').mockResolvedValue(true);
        await ui.toggleRace();

        await vi.advanceTimersByTimeAsync(60000);
        expect(liveSpy).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60000);
        expect(liveSpy).toHaveBeenCalledTimes(2);
    });

    it('stops the timer and performs one heavy backup when the race stops', async () => {
        const liveSpy = vi.spyOn(ui, 'performLiveBackup').mockResolvedValue(true);
        const heavySpy = vi.spyOn(ui, 'performHeavyBackup').mockResolvedValue(undefined);

        await ui.toggleRace(); // start
        await ui.toggleRace(); // stop
        expect(heavySpy).toHaveBeenCalledTimes(1);

        liveSpy.mockClear();
        await vi.advanceTimersByTimeAsync(120000);
        expect(liveSpy).not.toHaveBeenCalled(); // timer was cleared
    });
});
