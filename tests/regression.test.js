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
        it('should split two concatenated, protocol-accurate tag-push frames in a single BLE notification', () => {
            const driver = new BleDriver();
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });

            // Each frame follows the documented general format (PROTOCOL_SPEC.md Section 2):
            // [SOI=0xCC][ADR(2)][CID1][CID2/RTN][LENGTH][INFO(LENGTH bytes)][CHKSUM]
            // CID1=0x20 is this codebase's own empirical assumption for an unsolicited
            // tag-read push - NOT documented in the manual itself (see PROTOCOL_SPEC.md
            // Section 6, item 1). What IS confirmed (2026-06-28, against 4 real scans
            // with verified checksums - see decodeTagFrame tests below) is the INFO shape:
            // [AN(1B antenna)][PC(2B EPC Gen2 Protocol Control word)][EPC(PC-word-derived
            // length)][RSSI(1B)]. The EPC length isn't a separate length byte - it's the
            // top 5 bits of the PC word's high byte, in 16-bit-word units, exactly like a
            // real Gen2 PC word. This replaced an earlier (wrong) assumption that byte 6
            // was a raw EPC_LEN byte, which real hardware proved false (byte 6 is always
            // 0x00 - the antenna byte - so that old code always decoded an empty EPC).
            //
            // Checksum uses the verified additive two's-complement algorithm (Section 2.3),
            // confirmed against the manual's own reference code and real hardware.

            // Frame A: AN=0x00, PC=0x1000 (top 5 bits=00010=2 words=4 byte EPC), EPC AA BB CC DD, RSSI raw 0xCE (-50 dBm)
            const frameA = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0xF0];
            // Frame B: AN=0x00, PC=0x0800 (top 5 bits=00001=1 word=2 byte EPC), EPC 11 22, RSSI raw 0x2D (-45 dBm)
            const frameB = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x06, 0x00, 0x08, 0x00, 0x11, 0x22, 0x2D, 0x76];
            const bytes = [...frameA, ...frameB];

            const mockValue = {
                byteLength: bytes.length,
                getUint8: (i) => bytes[i],
            };

            driver.parseFrame({ target: { value: mockValue } });

            expect(results).toHaveLength(2);
            expect(results[0]).toEqual({ tag: 'AABBCCDD', rssi: -50 });
            expect(results[1]).toEqual({ tag: '1122', rssi: -45 });
        });

        it('should discard a correctly-framed tag-push frame whose checksum byte was bit-flipped (Bit Flip Test)', () => {
            const driver = new BleDriver();
            const results = [];
            driver.onTagRead = (tag, rssi) => results.push({ tag, rssi });
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            // Same protocol-accurate shape as Frame A in the concatenated-frames test above
            // (SOI/ADR/CID1/CID2/LENGTH/INFO/CHKSUM, LENGTH=0x08 is correct), but the
            // final CHKSUM byte is bit-flipped: 0xF0 (valid) -> 0x00 (invalid). This
            // matters because the LENGTH byte being correct means parseFrame's framing
            // succeeds and the frame actually reaches processValidFrame's checksum
            // check - unlike the old version of this test, which used a stale 7-byte
            // shape that got rejected by the *framing* check before checksum
            // validation was ever reached, so it passed without exercising checksum
            // logic at all. Asserting the console.warn call below proves the rejection
            // really did happen in the checksum branch this time, not by accident.
            const bytes = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0x00]; // valid checksum would be 0xF0

            const mockValue = {
                byteLength: bytes.length,
                getUint8: (i) => bytes[i],
            };

            driver.parseFrame({ target: { value: mockValue } });

            expect(results).toHaveLength(0);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Checksum mismatch'), expect.any(String));
            warnSpy.mockRestore();
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

    describe('BleDriver.decodeTagFrame() - reusable tag-read decode for the inspector', () => {
        // Pulls the same AN/PC/EPC/RSSI extraction processValidFrame uses for onTagRead,
        // so the Tag Inspector can display it without re-implementing (and risking drift
        // from) the logic that actually feeds race scoring.
        //
        // Layout confirmed 2026-06-28 against 4 real scans (3 different races/tag
        // providers, 2 different EPC lengths) - see the four "real scan" tests below.
        // INFO = [AN(1B)][PC(2B, standard EPC Gen2 Protocol Control word)][EPC(variable,
        // length = top 5 bits of PC's high byte, in 16-bit words)][RSSI(1B)]. This replaced
        // an earlier (falsified) assumption that byte 6 was a raw EPC_LEN byte - on every
        // real frame seen so far, byte 6 is always 0x00 (it's AN, the antenna number), so
        // the old code always decoded an empty-string EPC on real hardware (KNOWN_ISSUES.md
        // #3, now resolved).
        const toHex = (bytes) => bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
        const hexToBytes = (hex) => hex.match(/.{1,2}/g).map(b => parseInt(b, 16));

        it('extracts AN, PC, EPC hex, raw RSSI byte, and decoded RSSI dBm from a tag-read frame', () => {
            const driver = new BleDriver();
            // Same frame as Frame A in the concatenated-frames test above:
            // AN=0x00, PC=0x1000 (2-word/4-byte EPC), EPC AA BB CC DD, RSSI raw 0xCE (-50 dBm)
            const frame = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0xF0];

            expect(driver.decodeTagFrame(frame)).toEqual({
                an: 0x00,
                pc: 0x1000,
                epcLenWords: 2,
                epcLenBytes: 4,
                epcHex: 'AABBCCDD',
                rssiRaw: 0xCE,
                rssiDbm: -50,
            });
        });

        it('returns null for a non-tag-read frame (e.g. CID1=0x82 Get Version reply)', () => {
            const driver = new BleDriver();
            const frame = [0xCC, 0xFF, 0xFF, 0x82, 0x00, 0x02, 0xAA, 0xBB, 0x00];
            expect(driver.decodeTagFrame(frame)).toBeNull();
        });

        it('processValidFrame passes hex, checksumValid, and the tag decode to onRawFrame for a valid frame', () => {
            const driver = new BleDriver();
            const onRawFrame = vi.fn();
            driver.onRawFrame = onRawFrame;
            const frame = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0xF0];

            const mockValue = { byteLength: frame.length, getUint8: (i) => frame[i] };
            driver.parseFrame({ target: { value: mockValue } });

            expect(onRawFrame).toHaveBeenCalledWith({
                hex: toHex(frame),
                frame,
                checksumValid: true,
                tagDecode: { an: 0x00, pc: 0x1000, epcLenWords: 2, epcLenBytes: 4, epcHex: 'AABBCCDD', rssiRaw: 0xCE, rssiDbm: -50 },
            });
        });

        it('processValidFrame passes checksumValid:false to onRawFrame for a corrupted-checksum tag frame, but still includes the tag decode for display', () => {
            const driver = new BleDriver();
            const onRawFrame = vi.fn();
            driver.onRawFrame = onRawFrame;
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            // Same shape as the Bit Flip Test above: valid checksum would be 0xF0, this is 0x00
            const frame = [0xCC, 0xFF, 0xFF, 0x20, 0x32, 0x08, 0x00, 0x10, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0xCE, 0x00];

            const mockValue = { byteLength: frame.length, getUint8: (i) => frame[i] };
            driver.parseFrame({ target: { value: mockValue } });

            expect(onRawFrame).toHaveBeenCalledWith({
                hex: toHex(frame),
                frame,
                checksumValid: false,
                tagDecode: { an: 0x00, pc: 0x1000, epcLenWords: 2, epcLenBytes: 4, epcHex: 'AABBCCDD', rssiRaw: 0xCE, rssiDbm: -50 },
            });
            warnSpy.mockRestore();
        });

        describe('real scans (Tony, 2026-06-28) - checksums hand-verified, used as regression data', () => {
            it('decodes Bib 21251 (Race 1) - 12-byte EPC', () => {
                const driver = new BleDriver();
                const frame = hexToBytes('CCFFFF200510003400184608348582EF50F5365AF7B7BA');
                expect(driver.decodeTagFrame(frame)).toEqual({
                    an: 0x00,
                    pc: 0x3400,
                    epcLenWords: 6,
                    epcLenBytes: 12,
                    epcHex: '184608348582EF50F5365AF7',
                    rssiRaw: 0xB7,
                    rssiDbm: -73,
                });
            });

            it('decodes Bib 5251 (Race 1, same provider) - 12-byte EPC', () => {
                const driver = new BleDriver();
                const frame = hexToBytes('CCFFFF2005100034001E5FB1B8F84F2D5D3A6B075ABA56');
                expect(driver.decodeTagFrame(frame)).toEqual({
                    an: 0x00,
                    pc: 0x3400,
                    epcLenWords: 6,
                    epcLenBytes: 12,
                    epcHex: '1E5FB1B8F84F2D5D3A6B075A',
                    rssiRaw: 0xBA,
                    rssiDbm: -70,
                });
            });

            it('decodes Bib 982 (Race 2, different provider) - 16-byte EPC', () => {
                const driver = new BleDriver();
                const frame = hexToBytes('CCFFFF2005140040002038B48C05880250B7C0F3B5F66F1206BEEC');
                expect(driver.decodeTagFrame(frame)).toEqual({
                    an: 0x00,
                    pc: 0x4000,
                    epcLenWords: 8,
                    epcLenBytes: 16,
                    epcHex: '2038B48C05880250B7C0F3B5F66F1206',
                    rssiRaw: 0xBE,
                    rssiDbm: -66,
                });
            });

            it('decodes Bib 868 (Race 3, different tag style) - 16-byte EPC', () => {
                const driver = new BleDriver();
                const frame = hexToBytes('CCFFFF200514004000696AB5A98BA302F84144C2580A465B2FC625');
                expect(driver.decodeTagFrame(frame)).toEqual({
                    an: 0x00,
                    pc: 0x4000,
                    epcLenWords: 8,
                    epcLenBytes: 16,
                    epcHex: '696AB5A98BA302F84144C2580A465B2F',
                    rssiRaw: 0xC6,
                    rssiDbm: -58,
                });
            });

            it('decodes the manufacturer sample/test tag bundled with the reader (no bib - not from a race) - 12-byte EPC, E2-prefixed', () => {
                const driver = new BleDriver();
                const frame = hexToBytes('CCFFFF200510003000E2806915000050042B3611EEB885');
                expect(driver.decodeTagFrame(frame)).toEqual({
                    an: 0x00,
                    pc: 0x3000,
                    epcLenWords: 6,
                    epcLenBytes: 12,
                    epcHex: 'E2806915000050042B3611EE',
                    rssiRaw: 0xB8,
                    rssiDbm: -72,
                });
            });
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
