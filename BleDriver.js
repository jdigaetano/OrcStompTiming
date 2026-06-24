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
    }

    async connect() {
        try {
            this.intentionalDisconnect = false;
            this.updateStatus("Requesting Device...", false);

            this.device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [
                    "0000ffe0-0000-1000-8000-00805f9b34fb",
                    "0000ffe1-0000-1000-8000-00805f9b34fb"
                ]
            });

            this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
            return await this.establishConnection();
        } catch (error) {
            this.updateStatus(`Discovery Error: ${error.message}`, false);
            throw error;
        }
    }

    async establishConnection() {
        try {
            if (!this.device) throw new Error("No device selected");
            this.updateStatus("Connecting to GATT...", false);
            this.server = await this.device.gatt.connect();

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
        if (this.onRawFrame) this.onRawFrame(fullHex);

        // Validate Two's Complement SUM Checksum (Section 2.3)
        // Rule: The sum of all bytes in the frame (including CHKSUM) mod 256 should be 0.
        let sum = 0;
        for (let b of frame) sum += b;
        if ((sum & 0xFF) !== 0) {
            console.warn(`BleDriver: Checksum mismatch! Sum & 0xFF = ${(sum & 0xFF).toString(16)}`, fullHex);
            return;
        }

        // Tag Read Detection (CID1 = 0x20)
        if (frame[3] === 0x20) {
            const rssiRaw = frame[frame.length - 2];
            const processedRssi = rssiRaw > 127 ? rssiRaw - 256 : -rssiRaw;

            // Extract EPC from INFO section
            const epcLen = frame[6];
            const tagBytes = frame.slice(6, 6 + epcLen);
            const tagHex = this.bytesToHex(tagBytes);

            if (this.onTagRead) {
                this.onTagRead(tagHex, processedRssi);
            }
        }
    }

    bytesToHex(bytes) {
        return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
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
        if (this.device && this.device.gatt.connected) await this.device.gatt.disconnect();
        this.updateStatus("READER OFFLINE", false);
    }
}
