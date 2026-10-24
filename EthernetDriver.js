/**
 * EthernetDriver.js
 * Zebra FX9600 via ZIoTC WebSocket endpoint (ws://[reader-ip]/ws).
 * Implements the same callback/method interface as BleDriver — drop-in from AppUI's perspective.
 *
 * ZIoTC JSON field names (data[].idHex, data[].rssi) are the most common in third-party
 * integrations but are not confirmed from official docs. parseZiotcEvent() tries the most
 * likely variants in order — collapse to confirmed names after first hardware test.
 */
class EthernetDriver {
    constructor() {
        this.device = null;          // reader IP string (truthy) when configured, null otherwise
        this.ws = null;
        this._intentionalDisconnect = false;
        this._reconnectTimer = null;
        this._reconnectDelay = 2000;

        // Callbacks assigned by AppUI.setupBindings
        this.onTagRead = null;
        this.onStatusChange = null;
        this.onRawFrame = null;
        this.onLog = null;
    }

    // Parses a raw ZIoTC WebSocket message string into an array of {epcHex, rssiDbm} objects.
    // Field name fallback chain covers the most common ZIoTC variants — trim to confirmed names
    // after hardware test.
    // Confirmed from Zebra ZIoTC Node.js guide: EPC is at msg.data.idHex.
    // `data` may be a single-event object OR an array — normalize to array.
    // RSSI field name unconfirmed; rssi/peakRssi fallback chain resolves on first hardware test.
    static parseZiotcEvent(jsonStr) {
        if (!jsonStr) return [];
        let msg;
        try { msg = JSON.parse(jsonStr); } catch { return []; }
        const raw = msg.data ?? msg.tagReads ?? (Array.isArray(msg) ? msg : [msg]);
        const events = Array.isArray(raw) ? raw : [raw];
        return events.map(e => ({
            epcHex: (e.idHex ?? e.epc ?? e.EPC ?? '').replace(/\s/g, ''),
            rssiDbm: e.peakRssi ?? e.rssi ?? 0,
        })).filter(e => e.epcHex.length > 0);
    }

    _updateStatus(msg, connected) {
        if (this.onStatusChange) this.onStatusChange(msg, connected);
    }

    _log(msg) {
        if (this.onLog) this.onLog(msg);
    }

    // Opens a WebSocket connection to ws://[ip]/ws and wires up event handlers.
    // Returns a Promise that resolves when the connection opens, or rejects on error.
    _openWebSocket(ip) {
        return new Promise((resolve, reject) => {
            if (this.ws) {
                const old = this.ws;
                this.ws = null;
                try { old.close(); } catch (e) {}
            }

            this._updateStatus('Connecting to FX9600...', false);
            const ws = new WebSocket(`ws://${ip}/ws`);

            ws.onopen = () => {
                this.ws = ws;
                this.device = ip;
                localStorage.setItem('ethernetReaderIp', ip);
                this._reconnectDelay = 2000;
                this._updateStatus('FX9600 CONNECTED', true);
                resolve(true);
            };

            ws.onmessage = (e) => {
                const events = EthernetDriver.parseZiotcEvent(e.data);
                for (const ev of events) {
                    if (this.onTagRead) this.onTagRead(ev.epcHex, ev.rssiDbm);
                }
            };

            ws.onclose = () => {
                if (ws !== this.ws) return; // stale socket — ignore
                this.ws = null;
                this.device = null;
                this._updateStatus('READER OFFLINE', false);
                if (!this._intentionalDisconnect) this._scheduleReconnect(ip);
            };

            ws.onerror = () => {
                this._log(`WebSocket error connecting to ${ip}`);
                reject(new Error(`Failed to connect to FX9600 at ${ip}`));
            };
        });
    }

    _scheduleReconnect(ip) {
        if (this._intentionalDisconnect) return;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(async () => {
            if (this._intentionalDisconnect) return;
            this._updateStatus('RECONNECTING...', false);
            try {
                await this._openWebSocket(ip);
            } catch (e) {
                this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
                this._scheduleReconnect(ip);
            }
        }, this._reconnectDelay);
    }

    // User-initiated connection. Pass the IP from the UI input; if omitted uses the saved IP.
    async connect(ip = null) {
        const resolvedIp = ip || localStorage.getItem('ethernetReaderIp');
        if (!resolvedIp) throw new Error('No reader IP configured — enter an IP address and try again.');
        this._intentionalDisconnect = false;
        return this._openWebSocket(resolvedIp);
    }

    // Silent reconnect to a previously saved IP — called by AppUI.restoreState() on page load.
    async tryAutoConnect() {
        const savedIp = localStorage.getItem('ethernetReaderIp');
        if (!savedIp) return false;
        try {
            this._intentionalDisconnect = false;
            await this._openWebSocket(savedIp);
            return true;
        } catch (e) {
            return false;
        }
    }

    async disconnect() {
        this._intentionalDisconnect = true;
        clearTimeout(this._reconnectTimer);
        if (this.ws) {
            const ws = this.ws;
            this.ws = null;
            try { ws.close(); } catch (e) {}
        }
        this.device = null;
        this._updateStatus('READER OFFLINE', false);
    }

    async retryConnect() {
        const savedIp = localStorage.getItem('ethernetReaderIp');
        if (!savedIp) throw new Error('No reader IP configured — enter an IP address first.');
        this._intentionalDisconnect = false;
        return this._openWebSocket(savedIp);
    }

    // FX9600 streams continuously while the WebSocket is open — no explicit mode command needed.
    async setWorkMode(mode) {}

    async writeBibToEpc(bibNum) {
        throw new Error('Chip programming requires BLE handheld — switch to BLE mode in the reader selector.');
    }

    async scanForTag(timeoutMs) {
        throw new Error('Chip programming requires BLE handheld — switch to BLE mode in the reader selector.');
    }
}
