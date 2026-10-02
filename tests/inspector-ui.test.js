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

describe('Tag Inspector: Bib Programming controls are enabled and passive display is present', () => {
    it('enables the Bib Programming session button (mode switch is now implemented)', () => {
        expect(document.getElementById('startBibProgBtn')).not.toBeNull();
        expect(document.getElementById('startBibProgBtn').disabled).toBe(false);
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

// ─── Retry Connection button ─────────────────────────────────────────────────

describe('AppUI.updateBleBadge(): Retry Connection button', () => {
    let ui;

    beforeEach(() => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);
        ui.driver = { device: null };

        const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
        const body = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
        document.body.innerHTML = body;
    });

    afterEach(() => {
        global.localStorage.clear();
    });

    it('retry button is hidden when connected even if a device is selected', () => {
        ui.driver.device = { id: 'some-device' };
        ui.updateBleBadge('READER ONLINE', true);
        expect(document.getElementById('retryConnectBtn').style.display).toBe('none');
    });

    it('retry button is hidden when disconnected with no device selected', () => {
        ui.driver.device = null;
        ui.updateBleBadge('Connection Error: failed', false);
        expect(document.getElementById('retryConnectBtn').style.display).toBe('none');
    });

    it('retry button appears when disconnected and a device is selected', () => {
        ui.driver.device = { id: 'some-device' };
        ui.updateBleBadge('Connection Error: failed', false);
        expect(document.getElementById('retryConnectBtn').style.display).not.toBe('none');
    });

    it('bluetooth toggle note appears alongside the retry button', () => {
        ui.driver.device = { id: 'some-device' };
        ui.updateBleBadge('Connection Error: failed', false);
        expect(document.getElementById('retryConnectNote').style.display).not.toBe('none');
    });
});

// ─── AppUI.updateInspector() ────────────────────────────────────────────────

describe('AppUI.updateInspector()', () => {
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

    it('renders the raw hex in the detail panel for a non-tag response frame', () => {
        // CID1=0x81 heartbeat response — no tagDecode
        ui.updateInspector({ hex: 'CC FFFF 81 00 00 7F'.replace(/ /g, ''), checksumValid: true, tagDecode: null });
        const detail = document.getElementById('inspectorDetail');
        expect(detail.innerHTML).toContain('CC FFFF 81 00 00 7F'.replace(/ /g, ''));
    });

    it('marks a valid checksum as VALID in green (accent color)', () => {
        ui.updateInspector({ hex: 'CCFFFF810000' + '7F', checksumValid: true, tagDecode: null });
        const detail = document.getElementById('inspectorDetail');
        expect(detail.innerHTML).toContain('VALID');
        expect(detail.innerHTML).toContain('var(--accent)');
    });

    it('marks an invalid checksum as INVALID in red (error color)', () => {
        ui.updateInspector({ hex: 'CCFFFF810000' + 'FF', checksumValid: false, tagDecode: null });
        const detail = document.getElementById('inspectorDetail');
        expect(detail.innerHTML).toContain('INVALID');
        expect(detail.innerHTML).toContain('var(--error)');
    });

    it('renders TAG READ DECODE panel and EPC hex for a valid tag frame', () => {
        const tagDecode = {
            an: 1, pc: 0x3000, epcHex: '4F530068' + '00'.repeat(8),
            epcLenWords: 6, epcLenBytes: 12, rssiRaw: 0xB0, rssiDbm: -80,
        };
        ui.updateInspector({ hex: 'CCFFFF200500', checksumValid: true, tagDecode });
        const detail = document.getElementById('inspectorDetail');
        expect(detail.innerHTML).toContain('TAG READ DECODE');
        expect(detail.innerHTML).toContain(tagDecode.epcHex);
    });

    it('shows the decoded bib number when the EPC has the OrcStomp magic prefix', () => {
        const tagDecode = {
            an: 1, pc: 0x3000, epcHex: '4F530068' + '00'.repeat(8), // bib 104
            epcLenWords: 6, epcLenBytes: 12, rssiRaw: 0xB0, rssiDbm: -80,
        };
        ui.updateInspector({ hex: 'CCFFFF200500', checksumValid: true, tagDecode });
        const detail = document.getElementById('inspectorDetail');
        expect(detail.innerHTML).toContain('104');
        expect(detail.innerHTML).toContain('OrcStomp encoded');
    });

    it('adds a row to the history table and clears the placeholder text', () => {
        const history = document.getElementById('inspectorHistoryBody');
        history.innerHTML = '<tr><td colspan="2">No data captured yet.</td></tr>';
        ui.updateInspector({ hex: 'CCFFFF810000' + '7F', checksumValid: true, tagDecode: null });
        expect(history.innerHTML).not.toContain('No data captured');
        expect(history.children.length).toBeGreaterThan(0);
    });

    it('does nothing when inspectorDetail element is absent', () => {
        document.getElementById('inspectorDetail').remove();
        expect(() => {
            ui.updateInspector({ hex: 'CCFFFF810000' + '7F', checksumValid: true, tagDecode: null });
        }).not.toThrow();
    });
});

// ─── AppUI.bibProgLog() ──────────────────────────────────────────────────────

describe('AppUI.bibProgLog()', () => {
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

    it('appends a timestamped entry to #bibProgLog', () => {
        ui.bibProgLog('Test entry');
        const el = document.getElementById('bibProgLog');
        expect(el.innerHTML).toContain('Test entry');
    });

    it('clears the "No activity yet." placeholder on first call', () => {
        document.getElementById('bibProgLog').innerHTML = '<span style="color: #555;">No activity yet.</span>';
        ui.bibProgLog('First entry');
        expect(document.getElementById('bibProgLog').innerHTML).not.toContain('No activity yet');
    });

    it('colors the entry with var(--error) when isError is true', () => {
        ui.bibProgLog('Something went wrong', true);
        expect(document.getElementById('bibProgLog').innerHTML).toContain('var(--error)');
    });

    it('colors the entry with var(--data) for a normal entry', () => {
        ui.bibProgLog('All good');
        expect(document.getElementById('bibProgLog').innerHTML).toContain('var(--data)');
    });

    it('prepends new entries so newest appears first', () => {
        ui.bibProgLog('First');
        ui.bibProgLog('Second');
        const html = document.getElementById('bibProgLog').innerHTML;
        expect(html.indexOf('Second')).toBeLessThan(html.indexOf('First'));
    });

    it('removes entries beyond 30 to prevent unbounded growth', () => {
        for (let i = 0; i < 35; i++) ui.bibProgLog(`Entry ${i}`);
        const entries = document.getElementById('bibProgLog').querySelectorAll('div');
        expect(entries.length).toBeLessThanOrEqual(30);
    });

    it('does nothing when #bibProgLog element is absent', () => {
        document.getElementById('bibProgLog').remove();
        expect(() => ui.bibProgLog('Should not throw')).not.toThrow();
    });
});
