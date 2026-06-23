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
     * Protocol Parser: Handles multi-tag frames
     */
    parseFrame(event) {
        const value = event.target.value;
        if (value.byteLength < 6) return;

        // 1. Convert entire buffer to Hex
        const hexCodes = [];
        for (let i = 0; i < value.byteLength; i++) {
            hexCodes.push(value.getUint8(i).toString(16).padStart(2, '0').toUpperCase());
        }
        const fullHex = hexCodes.join('');

        // 2. Split buffer into individual tag chunks using the "CCFFFF" prefix as a delimiter
        // We use a positive lookahead regex to keep the "CCFFFF" at the start of each part
        const chunks = fullHex.split(/(?=CCFFFF)/);

        chunks.forEach(chunk => {
            if (chunk.length < 10) return; // Ignore fragments

            // Extract RSSI (2nd to last byte of THIS chunk)
            // chunk is hex, so 2 chars per byte. RSSI is at length - 4 to length - 2
            const rssiHex = chunk.substring(chunk.length - 4, chunk.length - 2);
            const rawRssiByte = parseInt(rssiHex, 16);
            const processedRssi = rawRssiByte > 127 ? rawRssiByte - 256 : -rawRssiByte;

            // Strip trailing 4 chars (RSSI + Checksum) from THIS chunk
            const cleanChipHex = chunk.substring(0, chunk.length - 4);

            if (this.onTagRead && cleanChipHex.startsWith("CCFFFF")) {
                this.onTagRead(cleanChipHex, processedRssi);
            }
        });
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
