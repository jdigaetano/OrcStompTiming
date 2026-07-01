import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

function makeTestSetup() {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    document.body.innerHTML = body;

    const AppUI = loadScript('AppUI.js');
    const engine = {
        ready: Promise.resolve(),
        onRecordPersisted: null,
        raceStartTime: null,
        isTrackingRace: false,
        getMappings: () => Promise.resolve([]),
    };
    const driver = { onTagRead: null, onStatusChange: null, onRawFrame: null };

    const ui = Object.create(AppUI.prototype);
    ui.engine = engine;
    ui.driver = driver;
    ui.clockInterval = null;
    ui.totalReads = 0;
    ui.uniqueTags = new Set();
    ui.setupBindings();

    return { ui, engine };
}

function setHidden(value) {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
}

describe('AppUI: Background Resilience (visibilitychange)', () => {
    let ui, engine;

    beforeEach(() => {
        global.localStorage.clear();
        ({ ui, engine } = makeTestSetup());
        setHidden(false);
    });

    afterEach(() => {
        if (ui && ui._visibilityHandler) {
            document.removeEventListener('visibilitychange', ui._visibilityHandler);
        }
        setHidden(false);
        global.localStorage.clear();
    });

    it('logs a warning when the tab becomes hidden', () => {
        const spy = vi.spyOn(ui, 'sysLog');
        setHidden(true);
        ui.handleVisibilityChange();
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('hidden'));
    });

    it('logs a recovery message when the tab becomes visible', () => {
        const spy = vi.spyOn(ui, 'sysLog');
        setHidden(false);
        ui.handleVisibilityChange();
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('visible'));
    });

    it('fires handleVisibilityChange() when the native visibilitychange event fires', () => {
        const spy = vi.spyOn(ui, 'handleVisibilityChange');
        document.dispatchEvent(new Event('visibilitychange'));
        expect(spy).toHaveBeenCalledOnce();
    });
});
