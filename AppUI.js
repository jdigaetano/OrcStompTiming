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

        // Link Engine to UI
        this.engine.onRecordPersisted = (record) => {
            this.totalReads++;
            document.getElementById('pingCounter').textContent = this.totalReads;

            if (!this.uniqueTags.has(record.tag_hex)) {
                this.uniqueTags.add(record.tag_hex);
                document.getElementById('uniqueCounter').textContent = this.uniqueTags.size;
            }

            this.flashPing();
            this.addLiveTableRow(record);
        };
    }

    restoreState() {
        if (this.engine.raceStartTime) {
            this.sysLog(`Recovered race: ${new Date(this.engine.raceStartTime).toLocaleTimeString()}`);
            this.startVisualClock();

            // Check if we were tracking (this is a simple recovery,
            // you might want to store isTracking in localStorage too)
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
