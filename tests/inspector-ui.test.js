import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

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
