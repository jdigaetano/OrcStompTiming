import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

function makeRecord(tagHex, rssi = -70) {
    return { tag_hex: tagHex, rssi, timestamp: new Date().toISOString() };
}

describe('AppUI: Ping Counter and Unique Reads Counter', () => {
    let ui, engine;

    beforeEach(() => {
        global.localStorage.clear();
        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
        document.body.innerHTML = body;

        const AppUI = loadScript('AppUI.js');
        engine = {
            ready: Promise.resolve(),
            onRecordPersisted: null,
            raceStartTime: null,
            isTrackingRace: false,
            getMappings: () => Promise.resolve([]),
        };
        const driver = { onTagRead: null, onStatusChange: null, onRawFrame: null };

        ui = Object.create(AppUI.prototype);
        ui.engine = engine;
        ui.driver = driver;
        ui.clockInterval = null;
        ui.totalReads = 0;
        ui.uniqueTags = new Set();
        ui.setupBindings();
    });

    afterEach(() => {
        global.localStorage.clear();
    });

    it('pingCounter starts at 0 before any reads', () => {
        expect(document.getElementById('pingCounter').textContent).toBe('0');
    });

    it('pingCounter increments to 1 on first read', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        expect(document.getElementById('pingCounter').textContent).toBe('1');
    });

    it('pingCounter increments on every read including duplicate tags', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        expect(document.getElementById('pingCounter').textContent).toBe('3');
    });

    it('uniqueCounter starts at 0 before any reads', () => {
        expect(document.getElementById('uniqueCounter').textContent).toBe('0');
    });

    it('uniqueCounter increments to 1 on first read', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        expect(document.getElementById('uniqueCounter').textContent).toBe('1');
    });

    it('uniqueCounter does NOT increment on a repeated tag read', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        expect(document.getElementById('uniqueCounter').textContent).toBe('1');
    });

    it('uniqueCounter increments for each distinct chip', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('11223344'));
        engine.onRecordPersisted(makeRecord('DEADBEEF'));
        expect(document.getElementById('uniqueCounter').textContent).toBe('3');
    });

    it('uniqueCounter stays the same when a previously seen chip is read again', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('11223344'));
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        expect(document.getElementById('uniqueCounter').textContent).toBe('2');
    });

    it('pingCounter and uniqueCounter correctly diverge when duplicates arrive', () => {
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('AABBCCDD'));
        engine.onRecordPersisted(makeRecord('11223344'));
        expect(document.getElementById('pingCounter').textContent).toBe('3');
        expect(document.getElementById('uniqueCounter').textContent).toBe('2');
    });
});

// ─── AppUI.toggleRace() ──────────────────────────────────────────────────────

describe('AppUI.toggleRace()', () => {
    let ui, engine;

    function makeStubEngine(overrides = {}) {
        return {
            ready: Promise.resolve(),
            onRecordPersisted: null,
            raceStartTime: null,
            isTrackingRace: false,
            getMappings: () => Promise.resolve([]),
            getRawSnapshot: () => Promise.resolve({ raceStartTime: null, race_reads: [], chip_map: [] }),
            getAllFromStore: () => Promise.resolve([]),
            buildResultsFromReads: () => ({}),
            buildUnknownResultsFromReads: () => ({}),
            buildCsvString: () => 'Bib,Elapsed Time,Wall Clock,Chip\n',
            ...overrides,
        };
    }

    beforeEach(() => {
        global.localStorage.clear();
        const html = require('fs').readFileSync(require('path').resolve(__dirname, '../index.html'), 'utf8');
        const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
        document.body.innerHTML = body;

        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        engine = makeStubEngine();

        ui = Object.create(AppUI.prototype);
        ui.engine = engine;
        ui.driver = { onTagRead: null, onStatusChange: null, onRawFrame: null };
        ui.clockInterval = null;
        ui.backupInterval = null;
        ui.totalReads = 0;
        ui.uniqueTags = new Set();
        ui.backupHandle = null;
    });

    afterEach(() => {
        if (ui.clockInterval) clearInterval(ui.clockInterval);
        if (ui.backupInterval) clearInterval(ui.backupInterval);
        global.localStorage.clear();
    });

    it('sets engine.isTrackingRace to true when starting', async () => {
        await ui.toggleRace();
        expect(engine.isTrackingRace).toBe(true);
    });

    it('persists isTrackingRace=true to localStorage when starting', async () => {
        await ui.toggleRace();
        expect(global.localStorage.getItem('isTrackingRace')).toBe('true');
    });

    it('sets raceStartTime on engine and in localStorage when no prior race', async () => {
        await ui.toggleRace();
        expect(engine.raceStartTime).not.toBeNull();
        expect(global.localStorage.getItem('raceStartTime')).toBe(engine.raceStartTime);
    });

    it('does NOT overwrite an existing raceStartTime (resumed race keeps original start)', async () => {
        engine.raceStartTime = '2026-06-30T10:00:00.000Z';
        await ui.toggleRace();
        expect(engine.raceStartTime).toBe('2026-06-30T10:00:00.000Z');
    });

    it('updates the raceStatus label to CLOCK RUNNING when starting', async () => {
        await ui.toggleRace();
        expect(document.getElementById('raceStatus').textContent).toBe('CLOCK RUNNING');
    });

    it('sets engine.isTrackingRace to false when stopping', async () => {
        engine.isTrackingRace = true;
        engine.raceStartTime = new Date().toISOString();
        await ui.toggleRace();
        expect(engine.isTrackingRace).toBe(false);
    });

    it('persists isTrackingRace=false to localStorage when stopping', async () => {
        engine.isTrackingRace = true;
        engine.raceStartTime = new Date().toISOString();
        await ui.toggleRace();
        expect(global.localStorage.getItem('isTrackingRace')).toBe('false');
    });

    it('updates the raceStatus label to CLOCK STOPPED when stopping', async () => {
        engine.isTrackingRace = true;
        engine.raceStartTime = new Date().toISOString();
        await ui.toggleRace();
        expect(document.getElementById('raceStatus').textContent).toBe('CLOCK STOPPED');
    });
});

describe('AppUI.switchTab() — tab lock during race', () => {
    let ui, engine;

    beforeEach(() => {
        global.localStorage.clear();
        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
        document.body.innerHTML = body;

        const AppUI = loadScript('AppUI.js');
        engine = {
            ready: Promise.resolve(),
            onRecordPersisted: null,
            raceStartTime: null,
            isTrackingRace: false,
            getMappings: () => Promise.resolve([]),
        };
        const driver = { onTagRead: null, onStatusChange: null, onRawFrame: null };

        ui = Object.create(AppUI.prototype);
        ui.engine = engine;
        ui.driver = driver;
        ui.clockInterval = null;
        ui.totalReads = 0;
        ui.uniqueTags = new Set();
        ui.setupBindings();
    });

    afterEach(() => { global.localStorage.clear(); });

    it('blocks switching to mapping-tab when the clock is running', () => {
        engine.isTrackingRace = true;
        const mappingBtn = document.getElementById('mappingTabBtn');
        ui.switchTab('mapping-tab', mappingBtn);
        expect(document.getElementById('mapping-tab').classList.contains('active')).toBe(false);
    });

    it('blocks switching to inspector-tab when the clock is running', () => {
        engine.isTrackingRace = true;
        const inspectorBtn = document.getElementById('inspectorTabBtn');
        ui.switchTab('inspector-tab', inspectorBtn);
        expect(document.getElementById('inspector-tab').classList.contains('active')).toBe(false);
    });

    it('allows switching to mapping-tab when clock is not running', () => {
        engine.isTrackingRace = false;
        const mappingBtn = document.getElementById('mappingTabBtn');
        ui.switchTab('mapping-tab', mappingBtn);
        expect(document.getElementById('mapping-tab').classList.contains('active')).toBe(true);
    });

    it('auto-switches away from mapping-tab when the clock starts', async () => {
        // Simulate user being on mapping tab before starting the race
        document.getElementById('mapping-tab').classList.add('active');
        document.getElementById('race-tab').classList.remove('active');
        engine.isTrackingRace = false;
        engine.raceStartTime = null;
        await ui.toggleRace();
        expect(document.getElementById('race-tab').classList.contains('active')).toBe(true);
        expect(document.getElementById('mapping-tab').classList.contains('active')).toBe(false);
    });
});
