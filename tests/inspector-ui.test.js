import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// Loads the real index.html body markup into the happy-dom document so these
// tests exercise the actual shipped HTML, not a hand-copied fixture that could
// drift out of sync with it.
beforeEach(() => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
    document.body.innerHTML = body;
});

describe('Tag Inspector: WIP/dangerous controls are disabled', () => {
    it('disables the Pro Tag Writer (Burn to Tag)', () => {
        expect(document.getElementById('writeBibNum').disabled).toBe(true);
        expect(document.getElementById('writeBibBtn').disabled).toBe(true);
    });

    it('disables the Pro Diagnostics buttons (mode switch, version, TID read)', () => {
        expect(document.getElementById('modeAnswerBtn').disabled).toBe(true);
        expect(document.getElementById('modeActiveBtn').disabled).toBe(true);
        expect(document.getElementById('getVersionBtn').disabled).toBe(true);
        expect(document.getElementById('readTidBtn').disabled).toBe(true);
    });

    it('disables the Manual Command (Advanced) controls', () => {
        expect(document.getElementById('manualCmdHex').disabled).toBe(true);
        expect(document.getElementById('sendCmdBtn').disabled).toBe(true);
        expect(document.getElementById('sendRawBtn').disabled).toBe(true);
    });

    it('disables the Bit-Search Decoder input', () => {
        expect(document.getElementById('searchBibNum').disabled).toBe(true);
    });

    it('leaves the passive Tag Inspector display (frame detail + history) untouched', () => {
        expect(document.getElementById('inspectorDetail')).not.toBeNull();
        expect(document.getElementById('inspectorHistoryBody')).not.toBeNull();
    });
});

// ─── Connect / Disconnect button & Forget Device ────────────────────────────

describe('AppUI.updateBleBadge(): Connect/Disconnect button and Forget Device', () => {
    let ui;

    beforeEach(() => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);

        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
        document.body.innerHTML = body;
    });

    afterEach(() => {
        global.localStorage.clear();
    });

    it('changes the connectBtn label to "Disconnect" when connected', () => {
        ui.updateBleBadge('READER ONLINE', true);
        expect(document.getElementById('connectBtn').textContent).toBe('Disconnect');
    });

    it('changes the connectBtn label back to "Connect Reader" when disconnected', () => {
        ui.updateBleBadge('READER ONLINE', true);
        ui.updateBleBadge('READER OFFLINE', false);
        expect(document.getElementById('connectBtn').textContent).toBe('Connect Reader');
    });

    it('shows the Forget Device button when disconnected and a device is saved', () => {
        global.localStorage.setItem('bleDeviceId', 'abc-123');
        ui.updateBleBadge('READER OFFLINE', false);
        const btn = document.getElementById('forgetDeviceBtn');
        expect(btn).not.toBeNull();
        expect(btn.style.display).not.toBe('none');
    });

    it('hides the Forget Device button when disconnected with no saved device', () => {
        ui.updateBleBadge('READER OFFLINE', false);
        expect(document.getElementById('forgetDeviceBtn').style.display).toBe('none');
    });

    it('hides the Forget Device button when connected even if a device is saved', () => {
        global.localStorage.setItem('bleDeviceId', 'abc-123');
        ui.updateBleBadge('READER ONLINE', true);
        expect(document.getElementById('forgetDeviceBtn').style.display).toBe('none');
    });
});
