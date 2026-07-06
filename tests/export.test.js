import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

loadScript('BleDriver.js');
const AppUI = loadScript('AppUI.js');

// Bypass the constructor (requires engine+driver+DOM) — we only test pure methods
const ui = Object.create(AppUI.prototype);

// ─── formatWallClock ────────────────────────────────────────────────────────

describe('AppUI.formatWallClock()', () => {
    it('returns a string in HH:MM:SS.mmm format', () => {
        const result = ui.formatWallClock(new Date().toISOString());
        expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('preserves millisecond precision', () => {
        // Build a date with known ms and verify they appear in the output
        const d = new Date();
        d.setMilliseconds(347);
        const result = ui.formatWallClock(d.toISOString());
        expect(result).toMatch(/\.347$/);
    });

    it('zero-pads single-digit seconds', () => {
        const d = new Date();
        d.setSeconds(5);
        d.setMilliseconds(0);
        const result = ui.formatWallClock(d.toISOString());
        // seconds field (chars 6-7) should be zero-padded
        const secondsPart = result.split(':')[2].split('.')[0];
        expect(secondsPart).toBe('05');
    });
});

// ─── buildResultsFromReads ──────────────────────────────────────────────────

describe('AppUI.buildResultsFromReads()', () => {
    const START = new Date('2026-06-30T10:00:00.000Z').getTime();

    function makeRead(tag, rssi, offsetMs) {
        return { tag_hex: tag, rssi, timestamp: new Date(START + offsetMs).toISOString() };
    }

    it('picks the highest-RSSI read within the 10s window', () => {
        const reads = [
            makeRead('TAG1', -70, 0),
            makeRead('TAG1', -50, 3000),   // best RSSI, still in window
            makeRead('TAG1', -60, 7000),
        ];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results['TAG1'].elapsedMs).toBe(3000);
    });

    it('ignores reads outside the 10s window when selecting peak RSSI', () => {
        const reads = [
            makeRead('TAG1', -70, 0),
            makeRead('TAG1', -50, 11000),  // after window — should NOT become the best
        ];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results['TAG1'].elapsedMs).toBe(0); // first read wins since -50 is excluded
    });

    it('computes elapsedMs correctly from the best read timestamp and raceStartMs', () => {
        const reads = [makeRead('TAG1', -70, 5234)];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results['TAG1'].elapsedMs).toBe(5234);
    });

    it('formats elapsed as HH:MM:SS via formatTime', () => {
        const reads = [makeRead('TAG1', -70, 75000)]; // 1m 15s
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results['TAG1'].elapsed).toBe('00:01:15');
    });

    it('includes a wallClock field in HH:MM:SS.mmm format', () => {
        const reads = [makeRead('TAG1', -70, 0)];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results['TAG1'].wallClock).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('looks up bib from maps by chip_hex', () => {
        const reads = [makeRead('AABBCCDD', -70, 1000)];
        const maps = [{ chip_hex: 'AABBCCDD', bib_num: 104 }];
        const results = ui.buildResultsFromReads(reads, maps, START);
        expect(results['AABBCCDD'].bib).toBe(104);
    });

    it('uses "UNKNOWN" when no bib mapping exists', () => {
        const reads = [makeRead('DEADBEEF', -70, 1000)];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results['DEADBEEF'].bib).toBe('UNKNOWN');
    });

    it('handles multiple independent tags correctly', () => {
        const reads = [
            makeRead('TAG1', -70, 1000),
            makeRead('TAG2', -60, 2000),
        ];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(Object.keys(results)).toHaveLength(2);
        expect(results['TAG1'].elapsedMs).toBe(1000);
        expect(results['TAG2'].elapsedMs).toBe(2000);
    });
});

// ─── decodeBibFromEpc ───────────────────────────────────────────────────────

describe('AppUI.decodeBibFromEpc()', () => {
    it('returns null for a factory EPC with no magic prefix', () => {
        expect(ui.decodeBibFromEpc('E2806915000050042B3611EE')).toBeNull();
    });

    it('returns null for an EPC shorter than 4 bytes (no room for prefix+bib)', () => {
        expect(ui.decodeBibFromEpc('4F53')).toBeNull();
    });

    it('returns null when the first 2 bytes are not the 0x4F53 magic', () => {
        expect(ui.decodeBibFromEpc('DEADBEEF00000000')).toBeNull();
    });

    it('returns the bib number for bib 104 (0x0068)', () => {
        expect(ui.decodeBibFromEpc('4F530068' + '00'.repeat(8))).toBe(104);
    });

    it('returns the bib number for bib 1 (0x0001)', () => {
        expect(ui.decodeBibFromEpc('4F530001' + '00'.repeat(8))).toBe(1);
    });

    it('returns the bib number for bib 9999 (0x270F)', () => {
        expect(ui.decodeBibFromEpc('4F53270F' + '00'.repeat(8))).toBe(9999);
    });

    it('returns the bib number for bib 65535 (0xFFFF)', () => {
        expect(ui.decodeBibFromEpc('4F53FFFF' + '00'.repeat(8))).toBe(65535);
    });
});

// ─── buildResultsFromReads — EPC decode path ────────────────────────────────

describe('AppUI.buildResultsFromReads() — EPC-encoded bib', () => {
    const START = new Date('2026-06-30T10:00:00.000Z').getTime();

    function makeRead(tag, rssi, offsetMs) {
        return { tag_hex: tag, rssi, timestamp: new Date(START + offsetMs).toISOString() };
    }

    it('uses the EPC-decoded bib when the magic prefix is present, ignoring chip_map', () => {
        const epc = '4F530068' + '00'.repeat(8); // bib 104
        const reads = [makeRead(epc, -60, 1000)];
        const maps = [{ chip_hex: epc, bib_num: 999 }]; // chip_map has wrong bib — should be ignored
        const results = ui.buildResultsFromReads(reads, maps, START);
        expect(results[epc].bib).toBe(104);
    });

    it('falls back to chip_map when EPC has no magic prefix', () => {
        const epc = 'AABBCCDDEEFF001122334455';
        const reads = [makeRead(epc, -60, 1000)];
        const maps = [{ chip_hex: epc, bib_num: 42 }];
        const results = ui.buildResultsFromReads(reads, maps, START);
        expect(results[epc].bib).toBe(42);
    });

    it('returns UNKNOWN when EPC has no magic prefix and no chip_map entry', () => {
        const epc = 'AABBCCDDEEFF001122334455';
        const reads = [makeRead(epc, -60, 1000)];
        const results = ui.buildResultsFromReads(reads, [], START);
        expect(results[epc].bib).toBe('UNKNOWN');
    });
});

// ─── buildCsvString ─────────────────────────────────────────────────────────

describe('AppUI.buildCsvString()', () => {
    const sampleResults = {
        'AABBCCDD': { bib: 104, elapsed: '00:25:30', wallClock: '10:25:30.000' },
        'DEADBEEF': { bib: 'UNKNOWN', elapsed: '00:30:00', wallClock: '10:30:00.000' },
    };

    it('includes Bib, Elapsed Time, Wall Clock, and Chip headers', () => {
        const csv = ui.buildCsvString(sampleResults);
        const header = csv.split('\n')[0];
        expect(header).toBe('Bib,Elapsed Time,Wall Clock,Chip');
    });

    it('includes one data row per chip', () => {
        const csv = ui.buildCsvString(sampleResults);
        const dataRows = csv.trim().split('\n').slice(1);
        expect(dataRows).toHaveLength(2);
    });

    it('includes bib, elapsed, wall clock, and chip hex in each row', () => {
        const csv = ui.buildCsvString({ 'AABBCCDD': { bib: 104, elapsed: '00:25:30', wallClock: '10:25:30.000' } });
        const row = csv.trim().split('\n')[1];
        expect(row).toContain('104');
        expect(row).toContain('00:25:30');
        expect(row).toContain('10:25:30.000');
        expect(row).toContain('AABBCCDD');
    });
});
