/**
 * BleDriver.js
 * Responsibility: Hardware Interface & Protocol Parsing
 */
class BleDriver {
    constructor() {
        this.device = null;
        this.server = null;
        this.writeCharacteristic = null;
        this.notifyCharacteristic = null;

        this.onTagRead = null;
        this.onRawFrame = null;
        this.onStatusChange = null;

        this.isAutoReconnecting = false;
        this.intentionalDisconnect = false;
        this._pendingCommand = null; // set by sendCommand(), cleared when response arrives or times out
    }

    async connect() {
        this.intentionalDisconnect = false;
        this.updateStatus("Requesting Device...", false);

        const optionalServices = [
            "0000ffe0-0000-1000-8000-00805f9b34fb",
            "0000ffe1-0000-1000-8000-00805f9b34fb"
        ];
        // If we've successfully connected to a named device before, scope the
        // picker to just that name instead of showing every BLE device in range.
        // "Forget Device" clears bleDeviceName, which reopens this to everyone.
        const savedName = localStorage.getItem('bleDeviceName');
        const requestOptions = savedName
            ? { filters: [{ name: savedName }], optionalServices }
            : { acceptAllDevices: true, optionalServices };

        try {
            this.device = await navigator.bluetooth.requestDevice(requestOptions);
        } catch (error) {
            this.updateStatus(`Discovery Error: ${error.message}`, false);
            throw error;
        }

        this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
        const result = await this.establishConnection();
        localStorage.setItem('bleDeviceId', this.device.id);
        localStorage.setItem('bleDeviceName', this.device.name || '');
        return result;
    }

    async tryAutoConnect() {
        const savedId = localStorage.getItem('bleDeviceId');
        if (!savedId) return false;
        if (typeof navigator.bluetooth.getDevices !== 'function') return false;

        let devices;
        try {
            devices = await navigator.bluetooth.getDevices();
        } catch (e) {
            return false; // getDevices() unavailable or threw — need picker
        }

        const device = devices.find(d => d.id === savedId);
        if (!device) return false; // device not in granted list — need picker

        this.device = device;
        this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
        await this.establishConnection(); // throws on GATT failure — caller handles it
        return true;
    }

    // device.gatt.connect() is known to be flaky on Windows right after a scan
    // (Chromium throws "Connection attempt failed." on attempt 1, then succeeds
    // on retry). Retry with backoff, forcing a disconnect between attempts, before
    // giving up. If it's STILL failing after this, the fault is below the page
    // (a wedged OS Bluetooth radio) - no amount of JS retrying fixes that, so the
    // final error tells the human what to do instead.
    async connectGatt(maxAttempts = 4) {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                this.updateStatus(`Connecting to GATT... (attempt ${attempt}/${maxAttempts})`, false);
                return await this.device.gatt.connect();
            } catch (error) {
                lastError = error;
                console.warn(`BleDriver: GATT connect attempt ${attempt}/${maxAttempts} failed:`, error.message);
                if (attempt < maxAttempts) {
                    try { this.device.gatt.disconnect(); } catch (e) { /* already disconnected, ignore */ }
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            }
        }
        throw new Error(`Still failing after ${maxAttempts} attempts (${lastError.message}) Try power-cycling the reader, or toggling Bluetooth off/on in Windows Settings.`);
    }

    async establishConnection() {
        try {
            if (!this.device) throw new Error("No device selected");
            this.server = await this.connectGatt();

            this.updateStatus("Mapping characteristics...", false);
            const services = await this.server.getPrimaryServices();

            for (const service of services) {
                if (!service.uuid.includes('ffe')) continue;

                const chars = await service.getCharacteristics();
                for (const c of chars) {
                    if (c.uuid.includes('ffe2')) this.notifyCharacteristic = c;
                    if (c.uuid.includes('ffe3') || c.uuid.includes('ffe1')) {
                        if (c.properties.write || c.properties.writeWithoutResponse) {
                            this.writeCharacteristic = c;
                        }
                    }
                }
            }

            if (!this.notifyCharacteristic) this.notifyCharacteristic = this.writeCharacteristic;
            if (!this.writeCharacteristic) this.writeCharacteristic = this.notifyCharacteristic;

            if (!this.notifyCharacteristic && !this.writeCharacteristic) {
                throw new Error('No usable characteristics found — is this the right device?');
            }

            if (this.notifyCharacteristic && this.notifyCharacteristic.properties.notify) {
                this.updateStatus("Starting Notifications...", false);
                await this.notifyCharacteristic.startNotifications();
                this.notifyCharacteristic.addEventListener('characteristicvaluechanged', (e) => this.parseFrame(e));
            }

            this.updateStatus("READER ONLINE", true);
            this.isAutoReconnecting = false;
            console.log("BleDriver: Pipes established. Write:", this.writeCharacteristic?.uuid, "Read:", this.notifyCharacteristic?.uuid);
            return true;
        } catch (error) {
            this.updateStatus(`Connection Error: ${error.message}`, false);
            throw error;
        }
    }

    handleDisconnect() {
        if (this.intentionalDisconnect) return;
        this.updateStatus("LINK LOST - RECONNECTING...", false);
        this.isAutoReconnecting = true;
        this.server = null;
        this.writeCharacteristic = null;
        this.notifyCharacteristic = null;
        setTimeout(() => this.attemptReconnect(), 2000);
    }

    async attemptReconnect() {
        if (!this.isAutoReconnecting || this.intentionalDisconnect) return;
        try { await this.establishConnection(); } catch (e) {
            if (this.isAutoReconnecting) setTimeout(() => this.attemptReconnect(), 4000);
        }
    }

    parseFrame(event) {
        const value = event.target.value;
        if (value.byteLength < 6) return;
        const bytes = [];
        for (let i = 0; i < value.byteLength; i++) bytes.push(value.getUint8(i));

        let i = 0;
        while (i < bytes.length) {
            // Find Header (SOI): CC (Response) or 7C (Command Echo)
            if (bytes[i] === 0xCC || bytes[i] === 0x7C) {
                // Frame: SOI(0) ADR(1,2) CID1(3) CID2/RTN(4) LEN(5)
                if (i + 5 >= bytes.length) { i++; continue; }
                const infoLen = bytes[i+5];
                const frameEnd = i + 6 + infoLen + 1;

                if (frameEnd > bytes.length) { i++; continue; }

                const frameBytes = bytes.slice(i, frameEnd);
                this.processValidFrame(frameBytes);
                i = frameEnd;
            } else { i++; }
        }
    }

    processValidFrame(frame) {
        const fullHex = this.bytesToHex(frame);

        // Validate Two's Complement SUM Checksum (Section 2.3)
        // Rule: The sum of all bytes in the frame (including CHKSUM) mod 256 should be 0.
        let sum = 0;
        for (let b of frame) sum += b;
        const checksumValid = (sum & 0xFF) === 0;

        const tagDecode = this.decodeTagFrame(frame);

        if (this.onRawFrame) {
            this.onRawFrame({ hex: fullHex, frame, checksumValid, tagDecode });
        }

        if (!checksumValid) {
            console.warn(`BleDriver: Checksum mismatch! Sum & 0xFF = ${(sum & 0xFF).toString(16)}`, fullHex);
            return;
        }

        // Resolve a pending sendCommand() call when a matching CID1 response arrives.
        // CID1=0x20 is excluded unless we're explicitly waiting for it (on-demand poll).
        // Active-mode push frames (CID1=0x20) have a different expectedCid1 in _pendingCommand,
        // so the frame[3] === expectedCid1 check already gates them out — no extra exclusion needed.
        if (this._pendingCommand && frame[3] === this._pendingCommand.expectedCid1) {
            const { resolve, reject, timer } = this._pendingCommand;
            this._pendingCommand = null;
            clearTimeout(timer);
            if (frame[4] === 0x01) {
                reject(new Error('Command failed: reader returned RTN=01 (Fail)'));
            } else {
                resolve(frame);
            }
            return;
        }

        if (tagDecode && this.onTagRead) {
            this.onTagRead(tagDecode.epcHex, tagDecode.rssiDbm);
        }
    }

    // Tag Read Detection (CID1 = 0x20). Shared by processValidFrame (for onTagRead, the
    // path real race scoring depends on) and the Tag Inspector display, so both always
    // agree on what a tag-read frame decodes to.
    //
    // INFO = [AN(1B antenna)][PC(2B, standard EPC Gen2 Protocol Control word)][EPC(PC-word
    // -derived length)][RSSI(1B)]. The EPC length is the top 5 bits of PC's high byte, in
    // 16-bit-word units - a real Gen2 field, not a reader-specific length byte. Confirmed
    // 2026-06-28 against 4 real scans across 3 races/tag providers and 2 different EPC
    // lengths (KNOWN_ISSUES.md #3, now resolved).
    decodeTagFrame(frame) {
        if (frame[3] !== 0x20) return null;

        const an = frame[6];
        const pc = (frame[7] << 8) | frame[8];
        const epcLenWords = frame[7] >>> 3;
        const epcLenBytes = epcLenWords * 2;
        const tagBytes = frame.slice(9, 9 + epcLenBytes);
        const epcHex = this.bytesToHex(tagBytes);

        const rssiRaw = frame[frame.length - 2];
        const rssiDbm = rssiRaw > 127 ? rssiRaw - 256 : -rssiRaw;

        return { an, pc, epcLenWords, epcLenBytes, epcHex, rssiRaw, rssiDbm };
    }

    bytesToHex(bytes) {
        return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    }

    // Polls once for a chip in command mode. Returns decodeTagFrame result or null on timeout.
    // Used for the post-write verify step in writeBibToEpc and the standalone Scan to Verify button.
    async scanForTag(timeoutMs = 5000, pollIntervalMs = 300) {
        const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const frame = await this.sendCommand('7CFFFF200000', 0x20, pollIntervalMs);
                const decoded = this.decodeTagFrame(frame);
                if (decoded && decoded.epcHex) return decoded;
            } catch (e) { }
        }
        return null;
    }

    // Writes a bib number into the chip's EPC bank with a 0x4F53 ("OS") magic prefix.
    // Returns {success, message}.
    //
    // Protocol: CID1=0x22 authenticated write (MM-reader extension, vendor USB trace 2026-07-07).
    // CID1=0x12 (documented spec) gets no response from this reader.
    //
    // Flow (3 steps):
    //   1. Poll (CID1=0x20) — singulates the tag. Retry up to totalWaitMs.
    //   2. Write (CID1=0x22) — writes while the tag is still singulated.
    //   3. Verify (scanForTag) — reads back EPC and checks the bib matches.
    //      Adjacent chip interference (EPC Gen2 anti-collision randomly picks among in-range chips)
    //      causes the wrong chip to be written. The verify step catches this: if the decoded bib
    //      doesn't match bibNum, returns {success: false} with a WRONG CHIP message.
    //      If verify times out (chip moved away too fast), degrades to plain success — no new failure state.
    //
    // Singulation requirement: sending CID1=0x22 without a prior CID1=0x20 poll causes false
    // RTN=0x00 — reader accepts the frame but no write reaches the chip. Confirmed 2026-07-08.
    //
    // Frame: 7C FF FF 22 00 13  00000000  01 02 06  4F53BHBL 0000000000000000  [CHKSUM]
    //   password=00000000, MB=01 (EPC bank), SA=02 (word offset 2 = first EPC word),
    //   DL=06 (6 words = full 96-bit EPC), first 4 bytes=bib encoding, rest=00s
    // Response: RTN=0x00 success + old EPC (ignored).
    async writeBibToEpc(bibNum, totalWaitMs = 5000, pollIntervalMs = 300) {
        const bh = (bibNum >> 8) & 0xFF;
        const bl = bibNum & 0xFF;
        const bhHex = bh.toString(16).padStart(2, '0').toUpperCase();
        const blHex = bl.toString(16).padStart(2, '0').toUpperCase();
        const writeHex = `7CFFFF220013000000000102064F53${bhHex}${blHex}0000000000000000`;

        // Step 1: Poll for a singulated tag (reader must be in command mode).
        const maxAttempts = Math.max(1, Math.ceil(totalWaitMs / pollIntervalMs));
        let found = false;
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await this.sendCommand('7CFFFF200000', 0x20, pollIntervalMs);
                found = true;
                break;
            } catch (e) {
                // No tag this cycle — keep trying until deadline.
            }
        }
        if (!found) {
            return { success: false, message: 'No chip detected within timeout.' };
        }

        // Step 2: Write immediately while the tag is still singulated.
        try {
            await this.sendCommand(writeHex, 0x22);
        } catch (e) {
            return { success: false, message: e.message };
        }

        // Step 3: Verify — re-poll and confirm the correct bib was written.
        // Catches adjacent chip interference (wrong chip singulated during step 1).
        // Timeout degrades to plain success — chip moved away too fast, not a write failure.
        const verify = await this.scanForTag(2000, 400);
        if (verify) {
            const hex = verify.epcHex.toUpperCase();
            const readBib = (hex.length >= 8 && hex.slice(0, 4) === '4F53')
                ? parseInt(hex.slice(4, 8), 16)
                : null;
            if (readBib === bibNum) {
                return { success: true, message: `Bib ${bibNum} written and verified.` };
            }
            if (readBib !== null) {
                return { success: false, message: `WRONG CHIP: chip reads bib ${readBib}, not ${bibNum} — keep only ONE chip near reader.` };
            }
        }
        return { success: true, message: `Bib ${bibNum} written.` };
    }

    // WM byte position in the 28-byte Basic Parameters INFO block (PROTOCOL_SPEC.md §4.8):
    // PW(0) FHE(1) FFV(2) FHV1-FHV6(3-8) WM(9) ...
    static get WM_INDEX() { return 9; }

    async getReaderParameters() {
        const frame = await this.sendCommand('7CFFFF813200', 0x81);
        // Use the actual LEN byte (frame[5]) — this hardware returns 27 bytes (0x1B),
        // not 28 (0x1C) as the spec says. Hardcoding 34 accidentally included the checksum.
        return frame.slice(6, 6 + frame[5]);
    }

    async setReaderParameters(paramBytes) {
        // The spec defines Set Parameters with LEN=0x1C (28 bytes). This hardware's
        // Get returns only 27 bytes, but Set MUST send 28 — sending 27 returns RTN=00
        // but is silently ignored. The missing 28th byte is MR (Max tags per read
        // cycle, §4.8); padding with 0x00 is out of the valid range (10–64) and
        // causes the reader to silently discard the flash write while returning RTN=00.
        const padded = new Uint8Array(28);
        padded[27] = 0x0A; // MR = 10 (minimum valid; overwritten if caller supplied 28 bytes)
        padded.set(paramBytes.slice(0, 28));
        const header = [0x7C, 0xFF, 0xFF, 0x81, 0x31, 0x1C];
        const allBytes = [...header, ...padded];
        const hex = allBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
        await this.sendCommand(hex, 0x81);
    }

    // CtrlAutoRead-only approach — never writes WM to flash.
    // WM=0x02 stays in flash (factory default) so CtrlAutoRead(1) always reliably
    // restarts the scan loop. Writing WM=0x01 to flash breaks CtrlAutoRead(1) until
    // the next reboot. See PROTOCOL_SPEC.md §6.
    async setWorkMode(mode) {
        await this.sendRawHex(mode === 'command' ? '7CFFFF34000100' : '7CFFFF34000101');
    }

    // Sends a command and returns a Promise that resolves with the raw response frame
    // once a frame with matching CID1 arrives (RTN=00), or rejects on RTN=01 or timeout.
    // Active-mode push frames (CID1=0x20) arriving while waiting are passed through to
    // onTagRead normally — they never satisfy this promise.
    sendCommand(hexString, expectedCid1, timeoutMs = 1000) {
        if (!this.writeCharacteristic) return Promise.reject(new Error('No write pipe available'));

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pendingCommand = null;
                reject(new Error(`sendCommand timeout waiting for CID1=0x${expectedCid1.toString(16).toUpperCase()}`));
            }, timeoutMs);

            this._pendingCommand = { expectedCid1, resolve, reject, timer };

            this.sendRawHex(hexString).catch(err => {
                clearTimeout(timer);
                this._pendingCommand = null;
                reject(err);
            });
        });
    }

    async sendRawHex(hex) {
        if (!this.writeCharacteristic) throw new Error("No write pipe available");

        let finalHex = hex;
        // Auto-calculate Two's Complement SUM for partial 7C commands
        const bytes = hex.match(/.{1,2}/g).map(b => parseInt(b, 16));
        const declaredLen = bytes[5] || 0;

        // If length is correct but checksum byte is missing (frame length = 6 + declaredLen)
        if (hex.startsWith('7C') && bytes.length === (6 + declaredLen)) {
            let sum = 0;
            for (let b of bytes) sum += b;
            const checksum = ((~sum) + 1) & 0xFF;
            finalHex += checksum.toString(16).padStart(2, '0').toUpperCase();
            console.log("BleDriver: Auto-signed (Two's Complement):", finalHex);
        }

        const data = new Uint8Array(finalHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        try {
            await this.writeCharacteristic.writeValueWithoutResponse(data);
        } catch (e) {
            await this.writeCharacteristic.writeValue(data);
        }
    }

    updateStatus(msg, connected) {
        if (this.onStatusChange) this.onStatusChange(msg, connected);
    }

    async disconnect() {
        this.intentionalDisconnect = true;
        this.isAutoReconnecting = false;
        localStorage.removeItem('bleDeviceId');
        localStorage.removeItem('bleDeviceName');
        if (this.device && this.device.gatt.connected) await this.device.gatt.disconnect();
        this.device = null;
        this.updateStatus("READER OFFLINE", false);
    }

    async retryConnect() {
        if (!this.device) throw new Error('No device selected — use Connect Reader first.');
        this.intentionalDisconnect = false;
        const result = await this.establishConnection();
        localStorage.setItem('bleDeviceId', this.device.id);
        localStorage.setItem('bleDeviceName', this.device.name || '');
        return result;
    }
}
