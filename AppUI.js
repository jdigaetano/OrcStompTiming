/**
 * AppUI.js
 * Responsibility: DOM Orchestration & Event Handling
 */
const LIVE_BACKUP_INTERVAL_MS = 60000;

class AppUI {
    constructor(engine, driver) {
        this.engine = engine;
        this.driver = driver;

        this.clockInterval = null;
        this.totalReads = 0;
        this.uniqueTags = new Set();

        this.setupBindings();

        // Wait for engine to be ready before restoring state
        this.engine.ready.then(() => {
            this.restoreState();
            this.sysLog("System Ready.");
        }).catch(err => {
            this.sysLog("System Initialization Failed!", true);
            console.error(err);
        });
    }

    setupBindings() {
        // Link Driver to Engine & UI
        this.driver.onTagRead = (tag, rssi) => {
            if (this.isKioskMode()) {
                this.fillKioskForm(tag);
            } else {
                this.engine.handleIncomingTag(tag, rssi);
            }
        };

        this.driver.onStatusChange = (msg, connected) => {
            this.updateBleBadge(msg, connected);
            this.sysLog(`BLE: ${msg}`, !connected && msg.includes('FAIL'));
        };

        this.driver.onRawFrame = (payload) => {
            this.updateInspector(payload);
        };

        // Page visibility: stop the visual clock when backgrounded (saves resources and
        // avoids a frozen display); restart it when foregrounded if the race is active.
        // Web Bluetooth events fire regardless of visibility, so no tag reads are lost.
        this._visibilityHandler = () => this.handleVisibilityChange();
        document.addEventListener('visibilitychange', this._visibilityHandler);

        // Link Engine to UI
        this.engine.onRecordPersisted = (record) => {
            this.totalReads++;
            const pingEl = document.getElementById('pingCounter');
            if (pingEl) pingEl.textContent = this.totalReads;

            if (!this.uniqueTags.has(record.tag_hex)) {
                this.uniqueTags.add(record.tag_hex);
                const uniqueEl = document.getElementById('uniqueCounter');
                if (uniqueEl) uniqueEl.textContent = this.uniqueTags.size;
            }

            this.flashPing();
            this.addLiveTableRow(record);
        };
    }

    restoreState() {
        this.restoreBackupHandle();
        if (this.engine.raceStartTime) {
            this.sysLog(`Recovered race: ${new Date(this.engine.raceStartTime).toLocaleTimeString()}`);
            this.startVisualClock();

            const wasTracking = localStorage.getItem('isTrackingRace') === 'true';
            if (wasTracking) {
                this.engine.isTrackingRace = true;
                this.updateRaceStatus(true);
                this.startBackupTimer();
            }
        }
        this.renderMappingTable();

        if (localStorage.getItem('bleDeviceId')) {
            const savedName = localStorage.getItem('bleDeviceName') || 'saved reader';
            this.sysLog(`SYSTEM: "${savedName}" was previously connected — attempting auto-connect...`);
            this.driver.tryAutoConnect()
                .then(ok => {
                    if (!ok) this.sysLog('SYSTEM: Saved reader not found — click "Connect Reader" to pair.');
                })
                .catch(() => {
                    // Device was found but GATT failed — retry button is now visible
                    this.sysLog('SYSTEM: Auto-connect failed — click "Retry Connection" above, or toggle Bluetooth off/on first.');
                });
        }
    }

    // UI Logic Methods
    async toggleRace() {
        if (!this.engine.isTrackingRace) {
            if (!this.engine.raceStartTime) {
                this.engine.raceStartTime = new Date().toISOString();
                localStorage.setItem('raceStartTime', this.engine.raceStartTime);
            }
            this.engine.isTrackingRace = true;
            localStorage.setItem('isTrackingRace', 'true');
            this.startVisualClock();
            this.updateRaceStatus(true);
            this.sysLog("RACE START");
            this.startBackupTimer();
        } else {
            this.engine.isTrackingRace = false;
            localStorage.setItem('isTrackingRace', 'false');
            this.stopVisualClock();
            this.updateRaceStatus(false);
            this.sysLog("RACE PAUSED");
            this.stopBackupTimer();
            await this.performHeavyBackup();
        }
    }

    // Periodic in-race backup: cheap, zero-computation raw snapshots only (see
    // TimingEngine.getRawSnapshot). Any heavier processing happens once the clock
    // stops, in performHeavyBackup() below — not on this recurring timer.
    startBackupTimer() {
        if (this.backupInterval) clearInterval(this.backupInterval);
        this.backupInterval = setInterval(() => this.performLiveBackup(), LIVE_BACKUP_INTERVAL_MS);
    }

    stopBackupTimer() {
        if (this.backupInterval) clearInterval(this.backupInterval);
        this.backupInterval = null;
    }

    startVisualClock() {
        if (this.clockInterval) clearInterval(this.clockInterval);
        const el = document.getElementById('raceClock');
        if (!el) return;

        const start = new Date(this.engine.raceStartTime).getTime();
        this.clockInterval = setInterval(() => {
            const elapsed = Date.now() - start;
            el.textContent = this.formatTime(elapsed);
        }, 200);
    }

    stopVisualClock() {
        clearInterval(this.clockInterval);
    }

    formatTime(ms) {
        if (ms < 0) ms = 0;
        let s = Math.floor(ms / 1000);
        let h = Math.floor(s / 3600);
        let m = Math.floor((s % 3600) / 60);
        s = s % 60;
        return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
    }

    // ... DOM Helpers ...
    updateBleBadge(msg, connected) {
        const b = document.getElementById('bleStatus');
        if (!b) return;
        b.textContent = msg;
        b.className = `status-badge ${connected ? 'status-connected' : 'status-disconnected'}`;

        const startBtn = document.getElementById('startRaceBtn');
        if (startBtn) startBtn.disabled = !connected;

        const connectBtn = document.getElementById('connectBtn');
        if (connectBtn) connectBtn.textContent = connected ? 'Disconnect' : 'Connect Reader';

        const forgetBtn = document.getElementById('forgetDeviceBtn');
        if (forgetBtn) {
            const hasSaved = !!localStorage.getItem('bleDeviceId');
            forgetBtn.style.display = (!connected && hasSaved) ? '' : 'none';
        }

        const hasDeviceSelected = !!(this.driver && this.driver.device);
        const retryBtn = document.getElementById('retryConnectBtn');
        const retryNote = document.getElementById('retryConnectNote');
        if (retryBtn) retryBtn.style.display = (!connected && hasDeviceSelected) ? '' : 'none';
        if (retryNote) retryNote.style.display = (!connected && hasDeviceSelected) ? '' : 'none';
    }

    async handleRetryBtn() {
        try {
            await this.driver.retryConnect();
        } catch (e) {
            // Error is surfaced via driver.onStatusChange → updateBleBadge
        }
    }

    updateRaceStatus(running) {
        const b = document.getElementById('raceStatus');
        const btn = document.getElementById('startRaceBtn');
        if (b) {
            b.textContent = running ? "CLOCK RUNNING" : "CLOCK STOPPED";
            b.style.background = running ? "rgba(0,255,0,0.1)" : "#333";
        }
        if (btn) {
            btn.textContent = running ? "STOP CLOCK" : "START CLOCK";
            btn.style.color = running ? "var(--error)" : "gold";
            btn.style.borderColor = running ? "var(--error)" : "gold";
        }
    }

    addLiveTableRow(record) {
        const tbody = document.getElementById('liveTableBody');
        if (!tbody) return;
        if (this.totalReads === 1) tbody.innerHTML = '';

        const row = `<tr><td>${new Date(record.timestamp).toLocaleTimeString()}</td><td style="color:var(--data);">${record.tag_hex}</td><td>${record.rssi} dBm</td></tr>`;
        tbody.insertAdjacentHTML('afterbegin', row);
        if (tbody.children.length > 50) tbody.removeChild(tbody.lastChild);
    }

    isKioskMode() {
        const tab = document.getElementById('mapping-tab');
        return tab && tab.classList.contains('active');
    }

    async fillKioskForm(tag) {
        const input = document.getElementById('formChipHex');
        if (input) {
            input.value = tag;
            document.getElementById('formBibNum').focus();
        }
        this.flashPing();
        await this.refreshMappingFormState();
    }

    // Normalizes chipHex/bibNum the same way TimingEngine.saveMapping() does, then
    // checks the pair against the current chip_map for either side already existing.
    checkMappingConflicts(chipHexRaw, bibNumRaw, maps) {
        const chip = (chipHexRaw || '').toUpperCase().trim();
        const parsedBib = parseInt(bibNumRaw, 10);
        const bib = Number.isNaN(parsedBib) ? null : parsedBib;

        const chipConflict = maps.find(m => m.chip_hex === chip) || null;
        const bibConflict = (bib !== null)
            ? (maps.find(m => m.bib_num === bib && m.chip_hex !== chip) || null)
            : null;
        const isNoOp = !!(chipConflict && bib !== null && chipConflict.bib_num === bib);

        return { chipConflict, bibConflict, isNoOp };
    }

    // Factual description of what a reassignment would overwrite — reused as both
    // the on-screen warning label and (with a question appended) the confirm() prompt.
    buildReassignConfirmMessage(conflicts, chipHex, bibNum) {
        const chip = (chipHex || '').toUpperCase().trim();
        const parts = [];
        if (conflicts.chipConflict) {
            parts.push(`Chip ${chip} is already mapped to Bib ${conflicts.chipConflict.bib_num}.`);
        }
        if (conflicts.bibConflict) {
            parts.push(`Bib ${bibNum} is already assigned to Chip ${conflicts.bibConflict.chip_hex}.`);
        }
        return parts.join(' ');
    }

    async submitMapping(chipHexRaw, bibNumRaw) {
        const maps = await this.engine.getMappings();
        const conflicts = this.checkMappingConflicts(chipHexRaw, bibNumRaw, maps);
        const hasConflict = (conflicts.chipConflict || conflicts.bibConflict) && !conflicts.isNoOp;

        if (hasConflict) {
            const message = `${this.buildReassignConfirmMessage(conflicts, chipHexRaw, bibNumRaw)} Reassigning will overwrite the existing mapping(s). Continue?`;
            if (!confirm(message)) return false;
        }

        await this.engine.saveMapping(chipHexRaw, bibNumRaw);
        // A bib steal only overwrites the incoming chip's row (chip_map is keyed by
        // chip_hex) — without this, the losing chip would keep its old mapping and
        // the bib would end up on two chips at once. Delete its row outright.
        if (conflicts.bibConflict) {
            await this.engine.deleteMapping(conflicts.bibConflict.chip_hex);
        }
        return true;
    }

    async refreshMappingFormState() {
        const chipInput = document.getElementById('formChipHex');
        const bibInput = document.getElementById('formBibNum');
        const warningEl = document.getElementById('mappingConflictWarning');
        const submitBtn = document.getElementById('mappingSubmitBtn');
        if (!chipInput || !bibInput || !warningEl || !submitBtn) return;

        const maps = await this.engine.getMappings();
        const conflicts = this.checkMappingConflicts(chipInput.value, bibInput.value, maps);
        const hasConflict = (conflicts.chipConflict || conflicts.bibConflict) && !conflicts.isNoOp;

        if (hasConflict) {
            warningEl.textContent = `ALREADY MAPPED — ${this.buildReassignConfirmMessage(conflicts, chipInput.value, bibInput.value)}`;
            warningEl.style.display = '';
            submitBtn.textContent = 'REASSIGN';
        } else {
            warningEl.style.display = 'none';
            submitBtn.textContent = 'Register Mapping';
        }
    }

    // Parses a chip-map CSV into {chip_hex, bib_num, line} rows, normalized the
    // same way saveMapping() normalizes them. `line` is the 1-indexed position in
    // the original file (matching what a user sees in a text editor/spreadsheet),
    // so conflict reports can point back at the source file.
    parseChipMapCsv(text) {
        const rows = [];
        text.split('\n').forEach((rawLine, idx) => {
            const line = rawLine.trim();
            if (!line) return;
            const [hex, bib] = line.split(',').map(s => s.trim());
            if (!hex || !bib || hex.toUpperCase() === 'CHIPHEX') return;
            rows.push({ chip_hex: hex.toUpperCase().trim(), bib_num: parseInt(bib, 10), line: idx + 1 });
        });
        return rows;
    }

    // Internal-consistency check for a parsed CSV, before it ever touches chip_map.
    findCsvConflicts(rows) {
        const chipGroups = new Map();
        const bibGroups = new Map();
        rows.forEach(r => {
            if (!chipGroups.has(r.chip_hex)) chipGroups.set(r.chip_hex, []);
            chipGroups.get(r.chip_hex).push(r);
            if (!bibGroups.has(r.bib_num)) bibGroups.set(r.bib_num, []);
            bibGroups.get(r.bib_num).push(r);
        });

        const duplicateChips = [...chipGroups.entries()]
            .filter(([, group]) => group.length > 1)
            .map(([chip_hex, group]) => ({ chip_hex, lines: group.map(g => g.line) }));

        const duplicateBibs = [...bibGroups.entries()]
            .filter(([, group]) => new Set(group.map(g => g.chip_hex)).size > 1)
            .map(([bib_num, group]) => ({ bib_num, chip_hexes: group.map(g => g.chip_hex), lines: group.map(g => g.line) }));

        return { duplicateChips, duplicateBibs };
    }

    buildCsvConflictReport(conflicts) {
        const parts = [];
        conflicts.duplicateChips.forEach(c => {
            parts.push(`Chip ${c.chip_hex} appears on lines ${c.lines.join(', ')}.`);
        });
        conflicts.duplicateBibs.forEach(b => {
            parts.push(`Bib ${b.bib_num} is assigned to multiple chips (${b.chip_hexes.join(', ')}) on lines ${b.lines.join(', ')}.`);
        });
        return parts.join(' ');
    }

    // Bulk CSV import is a full replace, not a merge — deliberately refuses to
    // touch chip_map at all if the file is internally inconsistent or empty.
    async submitChipMapImport(text) {
        const rows = this.parseChipMapCsv(text);
        if (rows.length === 0) {
            alert('No valid mappings found in file — import aborted, existing registry unchanged.');
            return { imported: false, count: 0 };
        }

        const conflicts = this.findCsvConflicts(rows);
        if (conflicts.duplicateChips.length || conflicts.duplicateBibs.length) {
            alert(`Import refused — this file has internal conflicts that must be fixed first. ${this.buildCsvConflictReport(conflicts)}`);
            return { imported: false, count: 0 };
        }

        const proceed = confirm(`This will replace the ENTIRE chip registry with the ${rows.length} mapping(s) in this file. Any existing mappings not in the file will be deleted. Continue?`);
        if (!proceed) return { imported: false, count: 0 };

        await this.engine.replaceChipMap(rows);
        return { imported: true, count: rows.length };
    }

    escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    flashPing() {
        const f = document.getElementById('pingFlash');
        if (f) {
            f.classList.add('flash-active');
            setTimeout(() => f.classList.remove('flash-active'), 100);
        }
    }

    sysLog(msg, isError = false) {
        const log = document.getElementById('consoleLog');
        if (!log) return;
        const color = isError ? 'var(--error)' : 'var(--data)';
        log.innerHTML += `\n<span style="color:${color}">[${new Date().toLocaleTimeString()}] ${msg}</span>`;
        log.scrollTop = log.scrollHeight;
    }

    updateInspector({ hex, checksumValid, tagDecode }) {
        const detail = document.getElementById('inspectorDetail');
        const history = document.getElementById('inspectorHistoryBody');
        if (!detail || !history) return;

        // Breakdown based on Section 2.2 Table 2.2-1
        const header = hex.substring(0, 2);
        const address = hex.substring(2, 6);
        const cid1 = hex.substring(6, 8);
        const cid2_rtn = hex.substring(8, 10);
        const lenHex = hex.substring(10, 12);
        const infoLen = parseInt(lenHex, 16);
        const info = hex.substring(12, 12 + (infoLen * 2));
        const checksum = hex.substring(hex.length - 2);

        const checksumColor = checksumValid ? 'var(--accent)' : 'var(--error)';
        const checksumLabel = checksumValid ? 'VALID' : 'INVALID';

        // Separate, clearly-labeled breakdown for tag-read frames (CID1=0x20). CID1=0x20
        // itself is still an undocumented, empirically reverse-engineered frame trigger
        // (PROTOCOL_SPEC.md Section 6, item 1), but the INFO layout below - AN + a
        // standard EPC Gen2 PC word + PC-length-derived EPC + RSSI - is now confirmed
        // against 4 real scans (KNOWN_ISSUES.md #3, resolved 2026-06-28).
        let tagPanel = '';
        if (tagDecode) {
            const anHex = tagDecode.an.toString(16).padStart(2, '0').toUpperCase();
            const pcHex = tagDecode.pc.toString(16).padStart(4, '0').toUpperCase();
            const rssiRawHex = tagDecode.rssiRaw.toString(16).padStart(2, '0').toUpperCase();
            const decodedBib = this.decodeBibFromEpc(tagDecode.epcHex);
            const bibRow = decodedBib !== null
                ? `<b style="color: var(--accent); font-weight: bold;">BIB:</b> <span style="color: var(--accent); font-weight: bold;">${decodedBib} <small>(OrcStomp encoded)</small></span>`
                : `<b style="color: #555;">BIB:</b> <span style="color: #555;">— <small>(not programmed)</small></span>`;
            tagPanel = `
                <div style="margin-top: 15px; border-top: 1px solid #444; padding-top: 10px;">
                    <div style="color: var(--timer-color); font-weight: bold; margin-bottom: 5px;">TAG READ DECODE</div>
                    <div style="display: grid; grid-template-columns: 80px 1fr; gap: 2px;">
                        <b style="color: #888;">AN:</b> <span>${anHex} <small>(antenna)</small></span>
                        <b style="color: #888;">PC:</b> <span>${pcHex} <small>(EPC len ${tagDecode.epcLenWords} words / ${tagDecode.epcLenBytes} bytes)</small></span>
                        <b style="color: #888;">EPC:</b> <span id="inspectorEpcHex" style="word-break: break-all; background: #1a1a1a; padding: 2px 4px;">${tagDecode.epcHex}</span>
                        ${bibRow}
                        <b style="color: #888;">RSSI Raw:</b> <span>${rssiRawHex}</span>
                        <b style="color: #888;">RSSI:</b> <span>${tagDecode.rssiDbm} dBm</span>
                    </div>
                </div>
            `;
        }

        detail.innerHTML = `
            <div style="font-family: monospace; font-size: 13px;">
                <div style="margin-bottom: 5px; border-bottom: 1px solid #444; padding-bottom: 5px;">
                    <span style="color: #555;">Raw:</span> <span style="word-break: break-all; font-size: 11px;">${hex}</span>
                </div>
                <div style="display: grid; grid-template-columns: 80px 1fr; gap: 2px;">
                    <b style="color: #888;">Header:</b> <span>${header} <small>(${header === '7C' ? 'Cmd Echo' : 'Resp'})</small></span>
                    <b style="color: #888;">Addr:</b> <span>${address}</span>
                    <b style="color: var(--data);">CID1:</b> <span>${cid1}</span>
                    <b style="color: var(--accent);">CID2/RTN:</b> <span>${cid2_rtn} <small>(${cid2_rtn === '00' ? 'SUCCESS' : ''})</small></span>
                    <b style="color: orange;">Length:</b> <span>${lenHex} <small>(${infoLen} bytes)</small></span>
                    <b style="color: var(--timer-color);">Info:</b> <span style="word-break: break-all; background: #1a1a1a; padding: 2px 4px;">${info}</span>
                    <b style="color: #888;">Check:</b> <span style="color: ${checksumColor};">${checksum} <small>(${checksumLabel})</small></span>
                </div>
                ${tagPanel}
            </div>
        `;

        if (history.innerHTML.includes('No data captured')) history.innerHTML = '';
        const row = `<tr><td style="white-space:nowrap">${new Date().toLocaleTimeString()}</td><td style="font-size:10px; word-break:break-all; font-family:monospace;">${hex}</td></tr>`;
        history.insertAdjacentHTML('afterbegin', row);
        if (history.children.length > 20) history.removeChild(history.lastChild);
    }

    async setBibProgrammingMode(active) {
        try {
            await this.driver.setWorkMode(active ? 'command' : 'active');
        } catch (e) {
            this.sysLog(`MODE ERROR: ${e.message}`, true);
            return;
        }
        const section = document.getElementById('bibProgrammingControls');
        if (section) section.style.display = active ? '' : 'none';
        const startBtn = document.getElementById('startBibProgBtn');
        if (startBtn) startBtn.textContent = active ? 'End Programming Session' : 'Start Programming Session';
        this.sysLog(`SYSTEM: Bib programming ${active ? 'started — reader is quiet' : 'ended — reader back to active scanning'}.`);
    }

    async writeBibToScannedTag() {
        const bibInput = document.getElementById('bibProgBibNum');
        const statusEl = document.getElementById('bibProgStatus');
        const bibNum = parseInt(bibInput?.value, 10);
        if (!bibInput || isNaN(bibNum) || bibNum < 1) {
            if (statusEl) statusEl.textContent = 'Enter a valid bib number first.';
            return;
        }
        if (statusEl) statusEl.textContent = 'Place chip near reader… (up to 5s)';
        // Reader stays in command mode. writeBibToEpc polls for a chip, then writes.
        const result = await this.driver.writeBibToEpc(bibNum);
        if (statusEl) statusEl.textContent = result.success ? `✓ ${result.message}` : `✗ ${result.message}`;
        if (result.success) {
            this.sysLog(`BIB PROG: Bib ${bibNum} written and verified.`);
            if (bibInput) bibInput.value = bibNum + 1;
        }
    }

    handleVisibilityChange() {
        if (document.hidden) {
            this.sysLog('Tab hidden — BLE reads continue, display throttled by browser.');
        } else {
            this.sysLog('Tab visible — display restored.');
        }
    }

    formatWallClock(isoString) {
        const d = new Date(isoString);
        const hh = d.getHours().toString().padStart(2, '0');
        const mm = d.getMinutes().toString().padStart(2, '0');
        const ss = d.getSeconds().toString().padStart(2, '0');
        const ms = d.getMilliseconds().toString().padStart(3, '0');
        return `${hh}:${mm}:${ss}.${ms}`;
    }

    // Returns the bib number encoded in an EPC hex string, or null if not present.
    // Encoding: first 4 hex chars must be "4F53" (magic), next 4 hex chars are bib as 16-bit big-endian.
    decodeBibFromEpc(epcHex) {
        if (!epcHex || epcHex.length < 8) return null;
        if (epcHex.toUpperCase().slice(0, 4) !== '4F53') return null;
        return parseInt(epcHex.slice(4, 8), 16);
    }

    buildResultsFromReads(reads, maps, raceStartMs) {
        const chipToBib = {};
        maps.forEach(m => chipToBib[m.chip_hex] = m.bib_num);

        const groups = {};
        reads.forEach(r => {
            if (!groups[r.tag_hex]) groups[r.tag_hex] = [];
            groups[r.tag_hex].push(r);
        });

        const results = {};
        Object.keys(groups).forEach(hex => {
            const tagReads = groups[hex].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            const firstRead = tagReads[0];
            const windowLimitMs = new Date(firstRead.timestamp).getTime() + 10000;
            let bestRead = firstRead;
            for (const r of tagReads) {
                if (new Date(r.timestamp).getTime() > windowLimitMs) break;
                if (r.rssi > bestRead.rssi) bestRead = r;
            }
            const elapsedMs = new Date(bestRead.timestamp).getTime() - raceStartMs;
            const epcBib = this.decodeBibFromEpc(hex);
            results[hex] = {
                bib: epcBib !== null ? epcBib : (chipToBib[hex] ?? 'UNKNOWN'),
                elapsedMs,
                elapsed: this.formatTime(elapsedMs),
                wallClock: this.formatWallClock(bestRead.timestamp),
            };
        });
        return results;
    }

    buildCsvString(results) {
        let csv = 'Bib,Elapsed Time,Wall Clock,Chip\n';
        Object.keys(results).forEach(hex => {
            const r = results[hex];
            csv += `"${r.bib}","${r.elapsed}","${r.wallClock}","${hex}"\n`;
        });
        return csv;
    }

    // Computes and downloads the standings CSV (same logic previously inline as
    // index.html's app.exportCsv). Returns false without downloading anything if
    // there's no data yet — used both by the manual "Export" button and by
    // performHeavyBackup(), where an empty race shouldn't produce a spurious file.
    async downloadStandingsCsv() {
        const reads = await this.engine.getAllFromStore('race_reads');
        if (!reads.length) return false;
        const maps = await this.engine.getAllFromStore('chip_map');
        const startMs = new Date(this.engine.raceStartTime).getTime();
        const results = this.buildResultsFromReads(reads, maps, startMs);
        const csv = this.buildCsvString(results);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.setAttribute('href', url);
        a.setAttribute('download', `race-export-${Date.now()}.csv`);
        a.click();
        return true;
    }

    // Writes a complete snapshot to a previously-chosen file handle, overwriting
    // it in full each time (not an append/patch) — see TimingEngine.getRawSnapshot.
    async writeSnapshotToFile(handle, snapshot) {
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(snapshot, null, 2));
        await writable.close();
    }

    // Lightweight, zero-computation live backup — safe to call on a recurring
    // timer while the race clock is running. No-ops if no backup location is set.
    async performLiveBackup() {
        if (!this.backupHandle) return false;
        const snapshot = await this.engine.getRawSnapshot();
        await this.writeSnapshotToFile(this.backupHandle, snapshot);
        return true;
    }

    // Runs once the clock has stopped (or right before a destructive reset/nuke):
    // a fresh raw snapshot, plus the heavier computed standings CSV — both "free"
    // now that the race isn't live.
    async performHeavyBackup() {
        await this.performLiveBackup();
        await this.downloadStandingsCsv();
    }

    buildWipeConfirmMessage(readCount, mappingCount, includeMappings) {
        let message = `This will permanently delete ${readCount} race read(s)`;
        if (includeMappings) message += ` and ${mappingCount} chip-to-bib mapping(s)`;
        message += '. A backup will be saved first. Continue?';
        return message;
    }

    updateBackupLabel(name) {
        const el = document.getElementById('backupLocationLabel');
        if (!el) return;
        el.textContent = name ? `Backing up to: ${name}` : 'No backup location set';
    }

    // One-time picker (browser security requires a user gesture to grant
    // filesystem access at all — there's no way to pick a location silently).
    // The resulting handle is persisted so restoreBackupHandle() can reuse it
    // silently on every later page load.
    async chooseBackupLocation() {
        if (typeof window.showSaveFilePicker !== 'function') {
            alert("Live backups need a Chromium browser (Chrome/Edge) — this browser doesn't support choosing a backup file.");
            return false;
        }
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: 'orcstomp-backup.json',
                startIn: 'documents',
                types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }],
            });
            this.backupHandle = handle;
            await this.engine.saveBackupHandle(handle);
            this.updateBackupLabel(handle.name);
            return true;
        } catch (e) {
            if (e.name === 'AbortError') return false; // user cancelled the picker — not an error
            alert(`Couldn't set up the backup location: ${e.message}`);
            return false;
        }
    }

    // Re-acquires a previously-chosen backup handle without showing the file
    // picker again — at most a lightweight one-click permission reconfirmation.
    async restoreBackupHandle() {
        const handle = await this.engine.getBackupHandle();
        if (!handle) { this.updateBackupLabel(null); return; }
        try {
            let perm = await handle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
            if (perm !== 'granted') { this.updateBackupLabel(null); return; }
            this.backupHandle = handle;
            this.updateBackupLabel(handle.name);
        } catch (e) {
            this.updateBackupLabel(null);
        }
    }

    async renderMappingTable() {
        const list = await this.engine.getMappings();
        const tbody = document.getElementById('mappingTableBody');
        if (!tbody) return;

        if (list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-dim);">No hardware links mapped yet</td></tr>`;
            return;
        }
        tbody.innerHTML = list.map(item => `
            <tr>
                <td>${this.escapeHtml(item.chip_hex)}</td>
                <td style="color:var(--accent); font-weight:bold;">${this.escapeHtml(item.bib_num)}</td>
                <td><button class="btn btn-danger" style="padding:4px 8px; font-size:10px;" onclick="app.deleteMapping('${this.escapeHtml(item.chip_hex)}')">Remove</button></td>
            </tr>
        `).join('');
    }
}
