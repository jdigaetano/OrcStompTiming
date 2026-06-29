/**
 * AppUI.js
 * Responsibility: DOM Orchestration & Event Handling
 */
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
        if (this.engine.raceStartTime) {
            this.sysLog(`Recovered race: ${new Date(this.engine.raceStartTime).toLocaleTimeString()}`);
            this.startVisualClock();

            const wasTracking = localStorage.getItem('isTrackingRace') === 'true';
            if (wasTracking) {
                this.engine.isTrackingRace = true;
                this.updateRaceStatus(true);
            }
        }
        this.renderMappingTable();
    }

    // UI Logic Methods
    toggleRace() {
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
        } else {
            this.engine.isTrackingRace = false;
            localStorage.setItem('isTrackingRace', 'false');
            this.stopVisualClock();
            this.updateRaceStatus(false);
            this.sysLog("RACE PAUSED");
        }
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

    fillKioskForm(tag) {
        const input = document.getElementById('formChipHex');
        if (input) {
            input.value = tag;
            document.getElementById('formBibNum').focus();
        }
        this.flashPing();
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
            tagPanel = `
                <div style="margin-top: 15px; border-top: 1px solid #444; padding-top: 10px;">
                    <div style="color: var(--timer-color); font-weight: bold; margin-bottom: 5px;">TAG READ DECODE</div>
                    <div style="display: grid; grid-template-columns: 80px 1fr; gap: 2px;">
                        <b style="color: #888;">AN:</b> <span>${anHex} <small>(antenna)</small></span>
                        <b style="color: #888;">PC:</b> <span>${pcHex} <small>(EPC len ${tagDecode.epcLenWords} words / ${tagDecode.epcLenBytes} bytes)</small></span>
                        <b style="color: #888;">EPC:</b> <span id="inspectorEpcHex" style="word-break: break-all; background: #1a1a1a; padding: 2px 4px;">${tagDecode.epcHex}</span>
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

    async setReaderMode(mode) {
        // mode 01 = Answer Mode (Quiet), 00 = Active Mode (Beeping)
        const cmd = `7CFFFF010201${mode}`;
        try {
            await this.driver.sendRawHex(cmd);
            this.sysLog(`SYSTEM: Switched to ${mode === '01' ? 'ANSWER' : 'ACTIVE'} mode.`);
        } catch (e) {
            this.sysLog(`MODE ERROR: ${e.message}`, true);
        }
    }

    async writeBibToTag() {
        const bib = document.getElementById('writeBibNum').value;
        if (!bib) return alert("Enter a Bib number first");

        const bibHex = parseInt(bib, 10).toString(16).padStart(4, '0').toUpperCase();

        // Command 12 31 (Write Memory)
        // Bank 01 (EPC), Start 02 (Skip PC), Len 01 (1 word / 2 bytes)
        // Full Info: [Bank][Start][Len][Data] = 01 02 01 + [bibHex]
        const info = `010201${bibHex}`;
        const lenByte = (info.length / 2).toString(16).padStart(2, '0');
        const cmd = `7CFFFF1231${lenByte}${info}`;

        try {
            this.sysLog(`WRITER: Attempting to burn Bib ${bib} (${bibHex}) to tag...`);
            await this.driver.sendRawHex(cmd);
        } catch (e) {
            this.sysLog(`WRITE ERROR: ${e.message}`, true);
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
                <td>${item.chip_hex}</td>
                <td style="color:var(--accent); font-weight:bold;">${item.bib_num}</td>
                <td><button class="btn btn-danger" style="padding:4px 8px; font-size:10px;" onclick="app.deleteMapping('${item.chip_hex}')">Remove</button></td>
            </tr>
        `).join('');
    }
}
