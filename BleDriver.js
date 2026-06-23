/**
 * BleDriver.js
 * Responsibility: Hardware Interface & Protocol Parsing
 */
class BleDriver {
    constructor() {
        this.SERVICE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb";
        this.NOTIFY_UUID  = "0000ffe2-0000-1000-8000-00805f9b34fb";

        this.device = null;
        this.server = null;
        this.characteristic = null;

        this.onTagRead = null; // Callback (tagId, rssi)
        this.onStatusChange = null; // Callback (statusString, isConnected)

        this.isAutoReconnecting = false;
        this.intentionalDisconnect = false;
    }

    async connect() {
        try {
            this.intentionalDisconnect = false;
            this.updateStatus("Requesting Device...", false);

            this.device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [this.SERVICE_UUID] }],
                optionalServices: [this.SERVICE_UUID]
            });

            this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());

            return await this.establishConnection();
        } catch (error) {
            this.updateStatus(`Connection Failed: ${error.message}`, false);
            throw error;
        }
    }

    async establishConnection() {
        try {
            if (!this.device) throw new Error("No device reference");

            this.updateStatus("Connecting GATT Server...", false);
            this.server = await this.device.gatt.connect();

            const service = await this.server.getPrimaryService(this.SERVICE_UUID);
            this.characteristic = await service.getCharacteristic(this.NOTIFY_UUID);

            await this.characteristic.startNotifications();
            this.characteristic.addEventListener('characteristicvaluechanged', (e) => this.parseFrame(e));

            this.updateStatus("READER ONLINE", true);
            this.isAutoReconnecting = false;
            return true;
        } catch (error) {
            throw error;
        }
    }

    handleDisconnect() {
        if (this.intentionalDisconnect) return;

        this.updateStatus("LINK LOST - RECONNECTING...", false);
        this.isAutoReconnecting = true;

        this.server = null;
        this.characteristic = null;

        console.log("BleDriver: Link lost. Initiating recovery loop in 2s...");
        setTimeout(() => this.attemptReconnect(), 2000);
    }

    async attemptReconnect() {
        if (!this.isAutoReconnecting || this.intentionalDisconnect) return;

        try {
            this.updateStatus("RECONNECTING...", false);
            await this.establishConnection();
        } catch (error) {
            if (this.isAutoReconnecting) {
                setTimeout(() => this.attemptReconnect(), 4000);
            }
        }
    }

    /**
     * Protocol Parser: Handles multi-tag frames with Checksum validation
     */
    parseFrame(event) {
        const value = event.target.value;
        if (value.byteLength < 6) return;

        // 1. Convert to Byte Array for processing
        const bytes = [];
        for (let i = 0; i < value.byteLength; i++) {
            bytes.push(value.getUint8(i));
        }

        // 2. Identify and Process individual frames
        // We look for 0xCC 0xFF 0xFF as the start sequence
        let i = 0;
        while (i < bytes.length) {
            if (bytes[i] === 0xCC && bytes[i+1] === 0xFF && bytes[i+2] === 0xFF) {
                // Potential frame start.
                // We need to find the end of this frame (next CCFFFF or end of buffer)
                let nextHeader = -1;
                for (let j = i + 3; j < bytes.length - 2; j++) {
                    if (bytes[j] === 0xCC && bytes[j+1] === 0xFF && bytes[j+2] === 0xFF) {
                        nextHeader = j;
                        break;
                    }
                }

                const frameEnd = (nextHeader !== -1) ? nextHeader : bytes.length;
                const frameBytes = bytes.slice(i, frameEnd);

                if (frameBytes.length >= 6) {
                    this.processValidFrame(frameBytes);
                }

                i = frameEnd;
            } else {
                i++;
            }
        }
    }

    processValidFrame(frame) {
        // 1. Validate XOR Checksum
        // Rule: XOR of all bytes in a valid frame should be 0 (if checksum is at the end)
        let checksum = 0;
        for (let b of frame) {
            checksum ^= b;
        }

        if (checksum !== 0) {
            console.warn("BleDriver: Discarding corrupted frame (Checksum mismatch)", this.bytesToHex(frame));
            return;
        }

        // 2. Extract Data
        // Format: [Header 3][Data...][RSSI 1][Checksum 1]
        const rssiRaw = frame[frame.length - 2];
        const processedRssi = rssiRaw > 127 ? rssiRaw - 256 : -rssiRaw;

        const tagBytes = frame.slice(0, frame.length - 2);
        const tagHex = this.bytesToHex(tagBytes);

        if (this.onTagRead) {
            this.onTagRead(tagHex, processedRssi);
        }
    }

    bytesToHex(bytes) {
        return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    }

    updateStatus(msg, connected) {
        if (this.onStatusChange) this.onStatusChange(msg, connected);
    }

    async disconnect() {
        this.intentionalDisconnect = true;
        this.isAutoReconnecting = false;
        if (this.device && this.device.gatt.connected) {
            await this.device.gatt.disconnect();
        }
        this.updateStatus("READER OFFLINE", false);
    }
}
