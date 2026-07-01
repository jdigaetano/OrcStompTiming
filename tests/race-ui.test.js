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
