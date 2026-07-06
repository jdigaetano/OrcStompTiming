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
        // Active-mode push frames (CID1=0x20) are never command responses — let them
        // fall through to onTagRead as normal even while a command is in flight.
        if (this._pendingCommand && frame[3] === this._pendingCommand.expectedCid1 && frame[3] !== 0x20) {
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

    // Writes a bib number into the chip's EPC bank with a 0x4F53 ("OS") magic prefix,
    // then reads it back to verify the write landed. Returns {success, message}.
    // Encoding: bytes 0-1 = 0x4F 0x53 magic; bytes 2-3 = bib as 16-bit big-endian.
    // Write: MB=01 (EPC), SA=02 (byte offset 2, past the 2-byte PC word), DL=02 (2 words).
    // Read-back: MB=01, SA=01 (word offset 1 = byte 2), DL=02.
    async writeBibToEpc(bibNum) {
        const bh = (bibNum >> 8) & 0xFF;
        const bl = bibNum & 0xFF;
        // 7C FF FF 12 31 07  01 02 02  4F 53 BH BL  [CHKSUM]
        const writeHex = `7CFFFF1231070102024F53${bh.toString(16).padStart(2,'0').toUpperCase()}${bl.toString(16).padStart(2,'0').toUpperCase()}`;
        try {
            await this.sendCommand(writeHex, 0x12);
        } catch (e) {
            return { success: false, message: e.message };
        }
        let readFrame;
        try {
            // 7C FF FF 12 32 03  01 01 02  [CHKSUM] — read 2 words at word offset 1 (byte 2)
            readFrame = await this.sendCommand('7CFFFF123203010102', 0x12);
        } catch (e) {
            return { success: false, message: `Write may have succeeded but read-back failed: ${e.message}` };
        }
        // Read-back INFO: AN(frame[6]) + 4 data bytes (frame[7..10])
        const match = readFrame[7] === 0x4F && readFrame[8] === 0x53 &&
                      readFrame[9] === bh  && readFrame[10] === bl;
        return match
            ? { success: true,  message: `Bib ${bibNum} written and verified.` }
            : { success: false, message: `Write sent but verify failed — chip returned unexpected bytes.` };
    }

    // WM byte position in the 28-byte Basic Parameters INFO block (PROTOCOL_SPEC.md §4.8):
    // PW(0) FHE(1) FFV(2) FHV1-FHV6(3-8) WM(9) ...
    static get WM_INDEX() { return 9; }

    async getReaderParameters() {
        const frame = await this.sendCommand('7CFFFF813200', 0x81);
        return frame.slice(6, 34); // INFO block: 28 bytes starting after the 6-byte header
    }

    async setReaderParameters(paramBytes) {
        // 7C FF FF 81 31 1C [28 bytes]. sendRawHex auto-signs when length matches header.
        const header = [0x7C, 0xFF, 0xFF, 0x81, 0x31, 0x1C];
        const allBytes = [...header, ...paramBytes];
        const hex = allBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
        await this.sendCommand(hex, 0x81);
    }

    // Get Parameters → flip WM byte only → Set Parameters back.
    // 'command' = WM=0x01 (quiet, on-demand reads only)
    // 'active'  = WM=0x02 (auto-broadcasts every read, default factory mode)
    async setWorkMode(mode) {
        const params = new Uint8Array(await this.getReaderParameters());
        params[BleDriver.WM_INDEX] = mode === 'command' ? 0x01 : 0x02;
        await this.setReaderParameters(params);
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
