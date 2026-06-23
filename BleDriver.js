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

    /**
     * Internal: Performs the actual GATT handshake
     */
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
            // Rethrow so the caller (connect or retry loop) handles it
            throw error;
        }
    }

    /**
     * Event Listener: Triggered when the physical link drops
     */
    handleDisconnect() {
        if (this.intentionalDisconnect) return;

        this.updateStatus("LINK LOST - RECONNECTING...", false);
        this.isAutoReconnecting = true;

        // Clear references
        this.server = null;
        this.characteristic = null;

        // Start the reconnect loop with a 2s delay to allow hardware to reset
        console.log("BleDriver: Link lost. Initiating recovery loop in 2s...");
        setTimeout(() => this.attemptReconnect(), 2000);
    }

    /**
     * Reconnect Loop: Retries until success or intentional disconnect
     */
    async attemptReconnect() {
        if (!this.isAutoReconnecting || this.intentionalDisconnect) {
            console.log("BleDriver: Reconnect loop aborted.");
            return;
        }

        try {
            console.log("BleDriver: Attempting GATT reconnection...");
            this.updateStatus("RECONNECTING...", false);
            await this.establishConnection();
            console.log("BleDriver: Reconnection successful.");
        } catch (error) {
            console.warn("BleDriver: Reconnect failed:", error.message);
            this.updateStatus("RECONNECT RETRYING...", false);
            if (this.isAutoReconnecting) {
                setTimeout(() => this.attemptReconnect(), 4000);
            }
        }
    }

    parseFrame(event) {
        const value = event.target.value;
        if (value.byteLength < 6) return;

        // Extract Hex
        const hexCodes = [];
        for (let i = 0; i < value.byteLength; i++) {
            hexCodes.push(value.getUint8(i).toString(16).padStart(2, '0').toUpperCase());
        }
        const fullHex = hexCodes.join('');

        // Protocol: [Tag...][RSSI][Check1][Check2]
        // Extract RSSI (second to last byte)
        let rawRssiByte = value.getUint8(value.byteLength - 2);
        let processedRssi = rawRssiByte > 127 ? rawRssiByte - 256 : -rawRssiByte;

        // Strip trailing 4 chars (RSSI + 2 protocol bytes)
        const cleanChipHex = fullHex.substring(0, fullHex.length - 4);

        if (this.onTagRead) {
            this.onTagRead(cleanChipHex, processedRssi);
        }
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
