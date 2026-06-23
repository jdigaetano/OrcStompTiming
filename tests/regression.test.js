import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Helper to load and evaluate our browser scripts in the test environment
const loadScript = (fileName) => {
    const code = fs.readFileSync(path.resolve(__dirname, '../', fileName), 'utf8');
    const script = new Function('global', code + '\nreturn ' + fileName.replace('.js', ''));
    return script(global);
};

// Evaluate the classes
const BleDriver = loadScript('BleDriver.js');
const TimingEngine = loadScript('TimingEngine.js');

describe('OrcStomp Regression Suite', () => {

    describe('BleDriver Protocol Parsing & Corruption Handling', () => {
        it('should split concatenated tag frames correctly with valid checksums', () => {
            const driver = new BleDriver();
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });

            // Tag 1: CC FF FF 01 02 (Checksum: CC^FF^FF^01^02 = CF)
            // Tag 2: CC FF FF 04 05 (Checksum: CC^FF^FF^04^05 = CA)
            // Sequence: [Header][Data][RSSI][Checksum]
            const mockValue = {
                byteLength: 14,
                getUint8: (i) => {
                    const bytes = [
                        0xCC, 0xFF, 0xFF, 0x01, 0x02, 0x32, 0xFD, // Tag 1 (RSSI 50 [32], CS: CC^FF^FF^01^02^32 = FD)
                        0xCC, 0xFF, 0xFF, 0x04, 0x05, 0x2D, 0xE7  // Tag 2 (RSSI 45 [2D], CS: CC^FF^FF^04^05^2D = E7)
                    ];
                    return bytes[i];
                }
            };
            driver.parseFrame({ target: { value: mockValue } });
            expect(results).toHaveLength(2);
            expect(results[0].tag).toBe('CCFFFF0102');
            expect(results[1].tag).toBe('CCFFFF0405');
        });

        it('should discard frames with invalid checksums (Bit Flip Test)', () => {
            const driver = new BleDriver();
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });

            const mockValue = {
                byteLength: 7,
                getUint8: (i) => {
                    const bytes = [0xCC, 0xFF, 0xFF, 0x01, 0x02, 0x32, 0x00]; // Valid would be 0xFD, 0x00 is wrong
                    return bytes[i];
                }
            };
            driver.parseFrame({ target: { value: mockValue } });
            expect(results).toHaveLength(0);
        });

        it('should discard frames that do not start with the CCFFFF prefix', () => {
            const driver = new BleDriver();
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });

            const mockValue = {
                byteLength: 10,
                getUint8: (i) => [0xAA, 0xBB, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08][i]
            };
            driver.parseFrame({ target: { value: mockValue } });
            expect(results).toHaveLength(0);
        });
    });

    describe('TimingEngine & Peak RSSI Logic (Advanced)', () => {
        let engine;

        beforeEach(async () => {
            engine = new TimingEngine();
            await engine.ready;
            await engine.clearAllData();
        });

        it('should handle database initialization and mappings', async () => {
            await engine.saveMapping("TAG1", 101);
            const maps = await engine.getMappings();
            expect(maps).toContainEqual({ chip_hex: "TAG1", bib_num: 101 });
        });

        it('should calculate the peak RSSI within a 10s window (The "Brainiac" Export Logic)', async () => {
            const startMs = Date.now();
            engine.raceStartTime = new Date(startMs).toISOString();
            engine.isTrackingRace = true;

            // Scenario: Runner approaches antenna
            const reads = [
                { tag: "RUNNER1", rssi: -80, offset: 1000 },  // 1s: First seen
                { tag: "RUNNER1", rssi: -40, offset: 3000 },  // 3s: PEAK (On line)
                { tag: "RUNNER1", rssi: -60, offset: 5000 },  // 5s: Moving away
                { tag: "RUNNER1", rssi: -10, offset: 15000 }, // 15s: Outside window, strongest but should be ignored
            ];

            // Manually push reads into the engine with specific timestamps
            for (const r of reads) {
                const tx = engine.db.transaction(['race_reads'], 'readwrite');
                tx.objectStore('race_reads').add({
                    tag_hex: r.tag,
                    rssi: r.rssi,
                    timestamp: new Date(startMs + r.offset).toISOString()
                });
                await new Promise(res => tx.oncomplete = res);
            }

            // We need to run the export logic.
            // Since exportCsv is currently in index.html, let's test the logical core of it.
            const allReads = await engine.getAllFromStore('race_reads');

            // --- Logic from AppUI/index.html ---
            const tagReads = allReads.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
            const firstRead = tagReads[0];
            const windowLimitMs = new Date(firstRead.timestamp).getTime() + 10000;

            let bestRead = firstRead;
            for (const r of tagReads) {
                const currentMs = new Date(r.timestamp).getTime();
                if (currentMs > windowLimitMs) break;
                if (r.rssi > bestRead.rssi) bestRead = r;
            }
            // --- End Logic ---

            // Expectation: The -40 RSSI read at 3s is the winner, NOT the -10 RSSI at 15s.
            expect(bestRead.rssi).toBe(-40);
            const elapsedSeconds = (new Date(bestRead.timestamp).getTime() - startMs) / 1000;
            expect(elapsedSeconds).toBe(3);
        });

        it('should maintain independent 10s windows for different runners crossing simultaneously', async () => {
            const startMs = Date.now();
            engine.raceStartTime = new Date(startMs).toISOString();
            engine.isTrackingRace = true;

            // Runner A starts at 1s, peaks at 3s.
            // Runner B starts at 2s, peaks at 5s.
            const reads = [
                { tag: "RUNNER_A", rssi: -80, offset: 1000 },
                { tag: "RUNNER_B", rssi: -80, offset: 2000 },
                { tag: "RUNNER_A", rssi: -30, offset: 3000 }, // A PEAK
                { tag: "RUNNER_B", rssi: -30, offset: 5000 }, // B PEAK
            ];

            for (const r of reads) {
                const tx = engine.db.transaction(['race_reads'], 'readwrite');
                tx.objectStore('race_reads').add({
                    tag_hex: r.tag,
                    rssi: r.rssi,
                    timestamp: new Date(startMs + r.offset).toISOString()
                });
                await new Promise(res => tx.oncomplete = res);
            }

            const allReads = await engine.getAllFromStore('race_reads');

            // Logic to simulate the Export process for all runners
            const results = {};
            const groups = {};
            allReads.forEach(r => {
                if (!groups[r.tag_hex]) groups[r.tag_hex] = [];
                groups[r.tag_hex].push(r);
            });

            Object.keys(groups).forEach(tag => {
                const tagReads = groups[tag].sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
                let best = tagReads[0];
                const limit = new Date(best.timestamp).getTime() + 10000;
                for (const r of tagReads) {
                    if (new Date(r.timestamp).getTime() > limit) break;
                    if (r.rssi > best.rssi) best = r;
                }
                results[tag] = (new Date(best.timestamp).getTime() - startMs) / 1000;
            });

            expect(results["RUNNER_A"]).toBe(3);
            expect(results["RUNNER_B"]).toBe(5);
        });
    });
});
