import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Helper to load scripts
const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

const TimingEngine = loadScript('TimingEngine.js');

describe('Mission Critical: Data Integrity & Recovery', () => {
    let engine;

    beforeEach(async () => {
        global.localStorage.clear();
        engine = new TimingEngine();
        await engine.ready;
        await engine.clearAllData();
    });

    describe('Session Recovery (Accidental Refresh)', () => {
        it('should correctly recover the race start time from localStorage', async () => {
            const fakeStartTime = "2026-06-23T10:00:00.000Z";
            global.localStorage.setItem('raceStartTime', fakeStartTime);

            // Create a new engine instance to simulate a page refresh
            const newEngine = new TimingEngine();
            await newEngine.ready;

            expect(newEngine.raceStartTime).toBe(fakeStartTime);
        });

        it('should NOT allow recording if race is paused (even if start time exists)', async () => {
            engine.raceStartTime = new Date().toISOString();
            engine.isTrackingRace = false; // Paused

            engine.handleIncomingTag("TAG_WHILE_PAUSED", -50);
            await new Promise(r => setTimeout(r, 400)); // Wait for daemon

            const reads = await engine.getAllFromStore('race_reads');
            expect(reads).toHaveLength(0);
        });
    });

    describe('Database Durability (High Speed Writing)', () => {
        it('should not drop any tags during a massive burst (100 tags in < 250ms)', async () => {
            engine.raceStartTime = new Date().toISOString();
            engine.isTrackingRace = true;

            // Simulate 100 tags hitting the queue before the first daemon tick
            for (let i = 0; i < 100; i++) {
                engine.handleIncomingTag(`TAG_${i}`, -50);
            }

            // Wait for 2 daemon cycles (250ms * 2)
            await new Promise(r => setTimeout(r, 600));

            const reads = await engine.getAllFromStore('race_reads');
            expect(reads).toHaveLength(100);
            expect(reads[99].tag_hex).toBe('TAG_99');
        });
    });

    describe('Dual Timestamps', () => {
        it('handleIncomingTag() stores both an ISO wall-clock timestamp and elapsed_ms', async () => {
            const startIso = new Date(Date.now() - 5000).toISOString();
            engine.raceStartTime = startIso;
            engine.isTrackingRace = true;

            engine.handleIncomingTag('TAG_A', -50);
            await new Promise(r => setTimeout(r, 400));

            const reads = await engine.getAllFromStore('race_reads');
            expect(reads).toHaveLength(1);
            expect(reads[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            expect(typeof reads[0].elapsed_ms).toBe('number');
            expect(reads[0].elapsed_ms).toBeGreaterThanOrEqual(5000);
            expect(reads[0].elapsed_ms).toBeLessThan(6000);
        });
    });

    describe('Kiosk Security', () => {
        it('should preserve mappings even when race data is wiped', async () => {
            // 1. Setup mapping and race data
            await engine.saveMapping("PERMANENT_CHIP", 500);
            engine.raceStartTime = new Date().toISOString();
            engine.isTrackingRace = true;
            engine.handleIncomingTag("RACE_READ", -50);
            await new Promise(r => setTimeout(r, 400));

            // 2. Perform Race Reset
            await engine.clearRaceData();

            // 3. Verify Mapping survived, but Read is gone
            const maps = await engine.getMappings();
            const reads = await engine.getAllFromStore('race_reads');

            expect(maps).toHaveLength(1);
            expect(maps[0].chip_hex).toBe("PERMANENT_CHIP");
            expect(reads).toHaveLength(0);
        });
    });
});
