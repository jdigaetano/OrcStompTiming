import { describe, it, expect, beforeEach } from 'vitest';
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

// ─── TimingEngine.saveMapping() / chip_map persistence ──────────────────────

describe('TimingEngine: chip_map persistence', () => {
    let engine;

    beforeEach(async () => {
        global.localStorage.clear();
        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
    });

    it('stores a new chip_hex/bib_num mapping', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1);
        expect(maps[0]).toEqual({ chip_hex: 'AABBCCDD', bib_num: 104 });
    });

    it('normalizes chip_hex to uppercase and trims whitespace', async () => {
        await engine.saveMapping('  aabbccdd  ', 104);
        const maps = await engine.getMappings();
        expect(maps[0].chip_hex).toBe('AABBCCDD');
    });

    it('getMappings returns every mapping with no dedup applied', async () => {
        await engine.saveMapping('AAAA', 1);
        await engine.saveMapping('BBBB', 2);
        await engine.saveMapping('CCCC', 3);
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(3);
    });

    it('silently overwrites an existing chip_hex mapping (guardrails are in AppUI.submitMapping, not the engine)', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await engine.saveMapping('AABBCCDD', 207); // re-map same chip, different bib
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1); // old mapping is gone, not preserved anywhere
        expect(maps[0].bib_num).toBe(207);
    });

    it('allows the same bib_num on two different chip_hex values — enforcement is in AppUI.submitMapping, not the engine', async () => {
        await engine.saveMapping('AAAA1111', 104);
        await engine.saveMapping('BBBB2222', 104); // same bib, different chip — should be rejected, isn't
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(2);
        expect(maps.filter(m => m.bib_num === 104)).toHaveLength(2);
    });

    // ─── Fixed this session: bib_num is now coerced to a number regardless of ──
    // caller type, so the kiosk form path (raw <input>.value string) and the CSV
    // import path (already parseInt'd) always converge to the same stored type.
    // This is a prerequisite for checkMappingConflicts()'s bib-side comparison below.
    it('coerces bib_num to a number whether the caller passes a string or a number', async () => {
        await engine.saveMapping('AAAA1111', '104'); // simulates kiosk form (input.value is a string)
        await engine.saveMapping('BBBB2222', 104);   // simulates CSV import (parseInt'd)
        const maps = await engine.getMappings();
        expect(maps.find(m => m.chip_hex === 'AAAA1111').bib_num).toBe(104);
        expect(maps.find(m => m.chip_hex === 'BBBB2222').bib_num).toBe(104);
        expect(maps.find(m => m.chip_hex === 'AAAA1111').bib_num === maps.find(m => m.chip_hex === 'BBBB2222').bib_num).toBe(true);
    });

    it('clearAllData() clears chip_map', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await engine.clearAllData();
        expect(await engine.getMappings()).toHaveLength(0);
    });

    it('clearRaceData() does NOT clear chip_map (kiosk registry survives a race reset)', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await engine.clearRaceData();
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1);
        expect(maps[0].chip_hex).toBe('AABBCCDD');
    });

    it('deleteMapping() removes a mapping by chip_hex', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await engine.saveMapping('EEFF0011', 207);
        await engine.deleteMapping('AABBCCDD');
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1);
        expect(maps[0].chip_hex).toBe('EEFF0011');
    });

    it('deleteMapping() is a no-op when the chip_hex is not mapped', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await engine.deleteMapping('NOTMAPPED');
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1);
    });

    it('replaceChipMap() replaces the entire registry, dropping mappings not in the new set', async () => {
        await engine.saveMapping('OLDCHIP', 999);
        await engine.replaceChipMap([
            { chip_hex: 'AABBCCDD', bib_num: 104 },
            { chip_hex: 'EEFF0011', bib_num: 207 },
        ]);
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(2);
        expect(maps.find(m => m.chip_hex === 'OLDCHIP')).toBeUndefined();
        expect(maps.find(m => m.chip_hex === 'AABBCCDD').bib_num).toBe(104);
    });

    it('replaceChipMap() normalizes chip_hex/bib_num the same way saveMapping does', async () => {
        await engine.replaceChipMap([{ chip_hex: '  aabbccdd  ', bib_num: '104' }]);
        const maps = await engine.getMappings();
        expect(maps[0]).toEqual({ chip_hex: 'AABBCCDD', bib_num: 104 });
    });
});

// ─── AppUI: mapping-tab rendering & kiosk auto-fill ─────────────────────────

describe('AppUI: Active Registry Table rendering', () => {
    let ui, engine;

    beforeEach(async () => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);

        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
        ui.engine = engine;

        loadIndexBody();
    });

    it('shows a placeholder row when no mappings exist', async () => {
        await ui.renderMappingTable();
        expect(document.getElementById('mappingTableBody').textContent).toContain('No hardware links mapped yet');
    });

    it('renders one row per mapping with chip hex and bib number', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await engine.saveMapping('EEFF0011', 207);
        await ui.renderMappingTable();
        const rows = document.querySelectorAll('#mappingTableBody tr');
        expect(rows).toHaveLength(2);
        expect(document.getElementById('mappingTableBody').textContent).toContain('AABBCCDD');
        expect(document.getElementById('mappingTableBody').textContent).toContain('104');
    });

    it('renders a Remove button wired to app.deleteMapping for each row', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await ui.renderMappingTable();
        const btn = document.querySelector('#mappingTableBody button');
        expect(btn.getAttribute('onclick')).toBe("app.deleteMapping('AABBCCDD')");
    });

    // ─── Fixed this session: chip_hex/bib_num are now escaped before being ──
    // interpolated into innerHTML. Chip hexes only ever come from the reader in
    // normal use, but the CSV import path (app.importChipMap) accepts arbitrary
    // text with no format validation, so this closes an injection route.
    it('escapes chip_hex before interpolating it into innerHTML', async () => {
        // saveMapping() uppercases chip_hex, so the stored/escaped value is "<B>...".
        await engine.saveMapping('<b>INJECTED</b>', 104);
        await ui.renderMappingTable();
        // Escaped means the tag text shows up literally and is NOT parsed as an element.
        const bold = document.querySelector('#mappingTableBody b, #mappingTableBody B');
        expect(bold).toBeNull();
        expect(document.getElementById('mappingTableBody').textContent).toContain('<B>INJECTED</B>');
    });
});

describe('AppUI: Kiosk auto-fill (isKioskMode / fillKioskForm)', () => {
    let ui, engine;

    beforeEach(async () => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);

        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
        ui.engine = engine;

        loadIndexBody();
    });

    it('isKioskMode is false when the mapping tab is not active', () => {
        expect(ui.isKioskMode()).toBe(false);
    });

    it('isKioskMode is true when the mapping tab has the active class', () => {
        document.getElementById('mapping-tab').classList.add('active');
        expect(ui.isKioskMode()).toBe(true);
    });

    it('fillKioskForm populates the chip hex field with the scanned tag', () => {
        ui.fillKioskForm('AABBCCDD');
        expect(document.getElementById('formChipHex').value).toBe('AABBCCDD');
    });

    it('fillKioskForm focuses the bib number field for entry', () => {
        ui.fillKioskForm('AABBCCDD');
        expect(document.activeElement.id).toBe('formBibNum');
    });

    // ─── Fixed this session: fillKioskForm now refreshes the conflict warning ──
    // immediately after auto-filling, so scanning an already-registered chip
    // shows the ALREADY MAPPED banner without waiting for further typing.
    it('shows the ALREADY MAPPED warning immediately after scanning a chip that already has a mapping', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        await ui.fillKioskForm('AABBCCDD');
        const warning = document.getElementById('mappingConflictWarning');
        expect(warning.style.display).not.toBe('none');
        expect(warning.textContent).toContain('104');
    });

    it('does not show the warning when scanning a brand-new chip', async () => {
        await ui.fillKioskForm('FRESHCHIP');
        const warning = document.getElementById('mappingConflictWarning');
        expect(warning.style.display).toBe('none');
    });
});

// ─── AppUI.checkMappingConflicts() ──────────────────────────────────────────

describe('AppUI.checkMappingConflicts()', () => {
    let ui;

    beforeEach(() => {
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);
    });

    it('reports no conflict for a chip and bib that are both new', () => {
        const maps = [{ chip_hex: 'EXISTING', bib_num: 1 }];
        const result = ui.checkMappingConflicts('NEWCHIP', 999, maps);
        expect(result.chipConflict).toBeNull();
        expect(result.bibConflict).toBeNull();
        expect(result.isNoOp).toBe(false);
    });

    it('reports a chipConflict when the chip is already mapped to a different bib', () => {
        const maps = [{ chip_hex: 'AABBCCDD', bib_num: 104 }];
        const result = ui.checkMappingConflicts('AABBCCDD', 207, maps);
        expect(result.chipConflict).toEqual({ chip_hex: 'AABBCCDD', bib_num: 104 });
        expect(result.bibConflict).toBeNull();
        expect(result.isNoOp).toBe(false);
    });

    it('reports a bibConflict when the bib is already assigned to a different chip', () => {
        const maps = [{ chip_hex: 'AABBCCDD', bib_num: 104 }];
        const result = ui.checkMappingConflicts('EEFF0011', 104, maps);
        expect(result.bibConflict).toEqual({ chip_hex: 'AABBCCDD', bib_num: 104 });
        expect(result.chipConflict).toBeNull();
        expect(result.isNoOp).toBe(false);
    });

    it('reports both conflicts at once when reassigning would both change the chip and steal a bib from another chip', () => {
        const maps = [
            { chip_hex: 'AABBCCDD', bib_num: 104 },
            { chip_hex: 'EEFF0011', bib_num: 207 },
        ];
        const result = ui.checkMappingConflicts('AABBCCDD', 207, maps);
        expect(result.chipConflict).toEqual({ chip_hex: 'AABBCCDD', bib_num: 104 });
        expect(result.bibConflict).toEqual({ chip_hex: 'EEFF0011', bib_num: 207 });
        expect(result.isNoOp).toBe(false);
    });

    it('reports isNoOp true when resubmitting the exact same chip/bib pair unchanged', () => {
        const maps = [{ chip_hex: 'AABBCCDD', bib_num: 104 }];
        const result = ui.checkMappingConflicts('AABBCCDD', 104, maps);
        expect(result.isNoOp).toBe(true);
    });

    it('normalizes chip hex casing/whitespace and bib type the same way saveMapping does', () => {
        const maps = [{ chip_hex: 'AABBCCDD', bib_num: 104 }];
        const result = ui.checkMappingConflicts('  aabbccdd  ', '104', maps);
        expect(result.isNoOp).toBe(true);
    });

    it('does not report a bibConflict when the bib is unparseable', () => {
        const maps = [{ chip_hex: 'AABBCCDD', bib_num: 104 }];
        const result = ui.checkMappingConflicts('NEWCHIP', '', maps);
        expect(result.bibConflict).toBeNull();
    });
});

// ─── AppUI.submitMapping() ──────────────────────────────────────────────────

describe('AppUI.submitMapping()', () => {
    let ui, engine;

    beforeEach(async () => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);

        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
        ui.engine = engine;
    });

    it('saves immediately with no confirm prompt when there is no conflict', async () => {
        global.confirm = () => { throw new Error('confirm should not be called'); };
        const saved = await ui.submitMapping('AABBCCDD', 104);
        expect(saved).toBe(true);
        expect(await engine.getMappings()).toHaveLength(1);
    });

    it('does not prompt when resubmitting an unchanged chip/bib pair (no-op)', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        global.confirm = () => { throw new Error('confirm should not be called'); };
        const saved = await ui.submitMapping('AABBCCDD', 104);
        expect(saved).toBe(true);
    });

    it('prompts for confirmation before reassigning an already-mapped chip', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        let confirmMessage = null;
        global.confirm = (msg) => { confirmMessage = msg; return true; };
        await ui.submitMapping('AABBCCDD', 207);
        expect(confirmMessage).toContain('AABBCCDD');
        expect(confirmMessage).toContain('104');
        const maps = await engine.getMappings();
        expect(maps[0].bib_num).toBe(207);
    });

    it('aborts the save when the user cancels the confirmation', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        global.confirm = () => false;
        const saved = await ui.submitMapping('AABBCCDD', 207);
        expect(saved).toBe(false);
        const maps = await engine.getMappings();
        expect(maps[0].bib_num).toBe(104); // unchanged
    });

    it('prompts for confirmation before stealing a bib already assigned to a different chip', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        let confirmMessage = null;
        global.confirm = (msg) => { confirmMessage = msg; return true; };
        await ui.submitMapping('EEFF0011', 104);
        expect(confirmMessage).toContain('104');
        expect(confirmMessage).toContain('AABBCCDD');
        const maps = await engine.getMappings();
        expect(maps.find(m => m.chip_hex === 'EEFF0011').bib_num).toBe(104);
    });

    // ─── Found via manual smoke test: confirming a bib-side steal only wrote ──
    // the new chip's row — chip_map is keyed by chip_hex, so saveMapping() had no
    // way to touch the losing chip's row, leaving two chips sharing one bib
    // (the exact duplicate this feature exists to prevent). Per user decision,
    // confirming a bib steal now deletes the losing chip's mapping entirely.
    it('deletes the other chip\'s mapping entirely once a bib steal is confirmed', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        global.confirm = () => true;
        await ui.submitMapping('EEFF0011', 104);
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1);
        expect(maps[0]).toEqual({ chip_hex: 'EEFF0011', bib_num: 104 });
    });

    it('does not delete the other chip\'s mapping if the bib steal is cancelled', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        global.confirm = () => false;
        const saved = await ui.submitMapping('EEFF0011', 104);
        expect(saved).toBe(false);
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(1);
        expect(maps[0]).toEqual({ chip_hex: 'AABBCCDD', bib_num: 104 });
    });
});

// ─── AppUI.refreshMappingFormState() ────────────────────────────────────────

describe('AppUI.refreshMappingFormState()', () => {
    let ui, engine;

    beforeEach(async () => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);

        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
        ui.engine = engine;

        loadIndexBody();
    });

    it('hides the warning and shows "Register Mapping" for a fresh chip/bib pair', async () => {
        document.getElementById('formChipHex').value = 'NEWCHIP';
        document.getElementById('formBibNum').value = '999';
        await ui.refreshMappingFormState();
        expect(document.getElementById('mappingConflictWarning').style.display).toBe('none');
        expect(document.getElementById('mappingSubmitBtn').textContent).toBe('Register Mapping');
    });

    it('shows the warning and relabels the button to REASSIGN when the chip is already mapped', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        document.getElementById('formChipHex').value = 'AABBCCDD';
        document.getElementById('formBibNum').value = '207';
        await ui.refreshMappingFormState();
        expect(document.getElementById('mappingConflictWarning').style.display).not.toBe('none');
        expect(document.getElementById('mappingSubmitBtn').textContent).toBe('REASSIGN');
    });

    it('shows the warning and relabels the button to REASSIGN when the bib is already assigned to a different chip', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        document.getElementById('formChipHex').value = 'EEFF0011';
        document.getElementById('formBibNum').value = '104';
        await ui.refreshMappingFormState();
        expect(document.getElementById('mappingConflictWarning').style.display).not.toBe('none');
        expect(document.getElementById('mappingSubmitBtn').textContent).toBe('REASSIGN');
    });

    it('does not treat resubmitting an unchanged pair as a conflict requiring REASSIGN', async () => {
        await engine.saveMapping('AABBCCDD', 104);
        document.getElementById('formChipHex').value = 'AABBCCDD';
        document.getElementById('formBibNum').value = '104';
        await ui.refreshMappingFormState();
        expect(document.getElementById('mappingSubmitBtn').textContent).toBe('Register Mapping');
    });
});

// ─── AppUI.parseChipMapCsv() ────────────────────────────────────────────────

describe('AppUI.parseChipMapCsv()', () => {
    let ui;

    beforeEach(() => {
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);
    });

    it('parses chip_hex/bib_num rows, normalized the same way saveMapping does', () => {
        const rows = ui.parseChipMapCsv('ChipHex,BibNum\naabbccdd,104\nEEFF0011,207');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ chip_hex: 'AABBCCDD', bib_num: 104 });
        expect(rows[1]).toMatchObject({ chip_hex: 'EEFF0011', bib_num: 207 });
    });

    it('skips the header row regardless of casing', () => {
        const rows = ui.parseChipMapCsv('chiphex,bibnum\nAABBCCDD,104');
        expect(rows).toHaveLength(1);
    });

    it('skips blank lines', () => {
        const rows = ui.parseChipMapCsv('ChipHex,BibNum\n\nAABBCCDD,104\n\n');
        expect(rows).toHaveLength(1);
    });

    it('records the 1-indexed source line number for each row', () => {
        const rows = ui.parseChipMapCsv('ChipHex,BibNum\nAABBCCDD,104\nEEFF0011,207');
        expect(rows[0].line).toBe(2);
        expect(rows[1].line).toBe(3);
    });

    it('returns an empty array for a file with no valid rows', () => {
        const rows = ui.parseChipMapCsv('ChipHex,BibNum\n');
        expect(rows).toHaveLength(0);
    });
});

// ─── AppUI.findCsvConflicts() ───────────────────────────────────────────────

describe('AppUI.findCsvConflicts()', () => {
    let ui;

    beforeEach(() => {
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);
    });

    it('reports no conflicts for a clean file', () => {
        const rows = [
            { chip_hex: 'AABBCCDD', bib_num: 104, line: 2 },
            { chip_hex: 'EEFF0011', bib_num: 207, line: 3 },
        ];
        const conflicts = ui.findCsvConflicts(rows);
        expect(conflicts.duplicateChips).toHaveLength(0);
        expect(conflicts.duplicateBibs).toHaveLength(0);
    });

    it('flags a chip_hex that appears on more than one row', () => {
        const rows = [
            { chip_hex: 'AABBCCDD', bib_num: 104, line: 2 },
            { chip_hex: 'AABBCCDD', bib_num: 207, line: 3 },
        ];
        const conflicts = ui.findCsvConflicts(rows);
        expect(conflicts.duplicateChips).toEqual([{ chip_hex: 'AABBCCDD', lines: [2, 3] }]);
    });

    it('flags a bib_num assigned to two different chips', () => {
        const rows = [
            { chip_hex: 'AABBCCDD', bib_num: 104, line: 2 },
            { chip_hex: 'EEFF0011', bib_num: 104, line: 3 },
        ];
        const conflicts = ui.findCsvConflicts(rows);
        expect(conflicts.duplicateBibs).toEqual([{ bib_num: 104, chip_hexes: ['AABBCCDD', 'EEFF0011'], lines: [2, 3] }]);
    });

    it('does not double-count an exact duplicate row as a bib conflict', () => {
        const rows = [
            { chip_hex: 'AABBCCDD', bib_num: 104, line: 2 },
            { chip_hex: 'AABBCCDD', bib_num: 104, line: 3 },
        ];
        const conflicts = ui.findCsvConflicts(rows);
        expect(conflicts.duplicateChips).toHaveLength(1); // still a chip-side conflict
        expect(conflicts.duplicateBibs).toHaveLength(0);  // but not a bib-side one — same chip both times
    });
});

// ─── AppUI.submitChipMapImport() ────────────────────────────────────────────

describe('AppUI.submitChipMapImport()', () => {
    let ui, engine;

    beforeEach(async () => {
        global.localStorage.clear();
        loadScript('BleDriver.js');
        const AppUI = loadScript('AppUI.js');
        ui = Object.create(AppUI.prototype);

        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
        ui.engine = engine;
    });

    it('refuses the import and leaves the registry untouched when the file has a duplicate chip_hex', async () => {
        await engine.saveMapping('KEEPME', 1);
        let alertMessage = null;
        global.alert = (msg) => { alertMessage = msg; };
        global.confirm = () => { throw new Error('confirm should not be called when the file has conflicts'); };

        const result = await ui.submitChipMapImport('ChipHex,BibNum\nAABBCCDD,104\nAABBCCDD,207');

        expect(result.imported).toBe(false);
        expect(alertMessage).toContain('AABBCCDD');
        const maps = await engine.getMappings();
        expect(maps).toEqual([{ chip_hex: 'KEEPME', bib_num: 1 }]);
    });

    it('refuses the import and leaves the registry untouched when the file has a duplicate bib_num', async () => {
        await engine.saveMapping('KEEPME', 1);
        let alertMessage = null;
        global.alert = (msg) => { alertMessage = msg; };
        global.confirm = () => { throw new Error('confirm should not be called when the file has conflicts'); };

        const result = await ui.submitChipMapImport('ChipHex,BibNum\nAABBCCDD,104\nEEFF0011,104');

        expect(result.imported).toBe(false);
        expect(alertMessage).toContain('104');
        const maps = await engine.getMappings();
        expect(maps).toEqual([{ chip_hex: 'KEEPME', bib_num: 1 }]);
    });

    it('warns about a full overwrite and aborts without changing the registry if cancelled', async () => {
        await engine.saveMapping('KEEPME', 1);
        let confirmMessage = null;
        global.confirm = (msg) => { confirmMessage = msg; return false; };

        const result = await ui.submitChipMapImport('ChipHex,BibNum\nAABBCCDD,104');

        expect(result.imported).toBe(false);
        expect(confirmMessage).toMatch(/entire|replace/i);
        const maps = await engine.getMappings();
        expect(maps).toEqual([{ chip_hex: 'KEEPME', bib_num: 1 }]);
    });

    it('replaces the entire registry with the file contents when confirmed', async () => {
        await engine.saveMapping('OLDCHIP', 999);
        global.confirm = () => true;

        const result = await ui.submitChipMapImport('ChipHex,BibNum\nAABBCCDD,104\nEEFF0011,207');

        expect(result.imported).toBe(true);
        expect(result.count).toBe(2);
        const maps = await engine.getMappings();
        expect(maps).toHaveLength(2);
        expect(maps.find(m => m.chip_hex === 'OLDCHIP')).toBeUndefined();
    });

    it('refuses the import without prompting when the file has zero valid rows, leaving the registry untouched', async () => {
        await engine.saveMapping('KEEPME', 1);
        let alertMessage = null;
        global.alert = (msg) => { alertMessage = msg; };
        global.confirm = () => { throw new Error('confirm should not be called for an empty file'); };

        const result = await ui.submitChipMapImport('ChipHex,BibNum\n');

        expect(result.imported).toBe(false);
        expect(alertMessage).toBeTruthy();
        const maps = await engine.getMappings();
        expect(maps).toEqual([{ chip_hex: 'KEEPME', bib_num: 1 }]);
    });
});
