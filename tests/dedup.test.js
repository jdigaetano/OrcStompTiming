import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const TimingEngine = loadScript('TimingEngine.js');

describe('L2 Dedup: 10-second write gate', () => {
    let engine;

    beforeEach(async () => {
        global.localStorage.clear();
        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
        engine.raceStartTime = new Date().toISOString();
        engine.isTrackingRace = true;
    });

    it('seenTags map exists and starts empty', () => {
        expect(engine.seenTags).toBeInstanceOf(Map);
        expect(engine.seenTags.size).toBe(0);
    });

    it('writes the first read for a new tag to the database', async () => {
        engine.handleIncomingTag('TAG_A', -50);
        await new Promise(r => setTimeout(r, 400));
        const reads = await engine.getAllFromStore('race_reads');
        expect(reads).toHaveLength(1);
    });

    it('records the first-seen time when a new tag is processed by the daemon', async () => {
        const before = Date.now();
        engine.handleIncomingTag('TAG_A', -50);
        await new Promise(r => setTimeout(r, 400));
        const firstSeen = engine.seenTags.get('TAG_A');
        expect(typeof firstSeen).toBe('number');
        expect(firstSeen).toBeGreaterThanOrEqual(before - 10);
        expect(firstSeen).toBeLessThanOrEqual(Date.now());
    });

    it('writes a second read within the 10s window to the database', async () => {
        engine.handleIncomingTag('TAG_A', -50);
        engine.handleIncomingTag('TAG_A', -48);
        await new Promise(r => setTimeout(r, 400));
        const reads = await engine.getAllFromStore('race_reads');
        expect(reads).toHaveLength(2);
    });

    it('drops reads that arrive after the 10-second window has closed', async () => {
        // Simulate: this tag was first seen 11 seconds ago, window is already closed
        engine.seenTags.set('TAG_A', Date.now() - 11000);
        engine.handleIncomingTag('TAG_A', -50);
        await new Promise(r => setTimeout(r, 400));
        const reads = await engine.getAllFromStore('race_reads');
        expect(reads).toHaveLength(0);
    });

    it('does not affect reads from other tags when one tag window has closed', async () => {
        // TAG_A window is closed (11s ago), TAG_B is new
        engine.seenTags.set('TAG_A', Date.now() - 11000);
        engine.handleIncomingTag('TAG_A', -50); // should be dropped
        engine.handleIncomingTag('TAG_B', -50); // should be written
        await new Promise(r => setTimeout(r, 400));
        const reads = await engine.getAllFromStore('race_reads');
        expect(reads).toHaveLength(1);
        expect(reads[0].tag_hex).toBe('TAG_B');
    });

    it('clearRaceData() resets the seenTags map', async () => {
        engine.handleIncomingTag('TAG_A', -50);
        await new Promise(r => setTimeout(r, 400));
        expect(engine.seenTags.size).toBeGreaterThan(0);
        await engine.clearRaceData();
        expect(engine.seenTags.size).toBe(0);
    });
});
