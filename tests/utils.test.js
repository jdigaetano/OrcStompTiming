import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// utils.js exports a {decodeBibFromEpc} object via the loadScript convention
const utils = loadScript('utils.js');

describe('utils.decodeBibFromEpc()', () => {
    it('returns null for a factory EPC with no magic prefix', () => {
        expect(utils.decodeBibFromEpc('E2806915000050042B3611EE')).toBeNull();
    });

    it('returns null when the EPC is shorter than 4 bytes', () => {
        expect(utils.decodeBibFromEpc('4F53')).toBeNull();
    });

    it('returns null when the first 2 bytes are not the 0x4F53 magic', () => {
        expect(utils.decodeBibFromEpc('DEADBEEF00000000')).toBeNull();
    });

    it('returns null for null/undefined input', () => {
        expect(utils.decodeBibFromEpc(null)).toBeNull();
        expect(utils.decodeBibFromEpc(undefined)).toBeNull();
    });

    it('returns the bib number for bib 104 (0x0068)', () => {
        expect(utils.decodeBibFromEpc('4F530068' + '00'.repeat(8))).toBe(104);
    });

    it('returns the bib number for bib 1 (0x0001)', () => {
        expect(utils.decodeBibFromEpc('4F530001' + '00'.repeat(8))).toBe(1);
    });

    it('returns the bib number for bib 65535 (0xFFFF)', () => {
        expect(utils.decodeBibFromEpc('4F53FFFF' + '00'.repeat(8))).toBe(65535);
    });

    it('is case-insensitive for the magic prefix', () => {
        expect(utils.decodeBibFromEpc('4f530068' + '00'.repeat(8))).toBe(104);
    });

    it('is also available as a global function decodeBibFromEpc after loadScript()', () => {
        // Loading utils.js via loadScript should also set global.decodeBibFromEpc
        expect(typeof global.decodeBibFromEpc).toBe('function');
        expect(global.decodeBibFromEpc('4F530068' + '00'.repeat(8))).toBe(104);
    });
});
