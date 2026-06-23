/**
 * MockBleDriver.js
 * Simulates a hardware reader for testing and development.
 */
class MockBleDriver {
    constructor() {
        this.onTagRead = null;
        this.onStatusChange = null;
        this.isConnected = false;
        this.interval = null;
    }

    async connect() {
        this.updateStatus("Searching for Simulated Reader...", false);
        return new Promise((resolve) => {
            setTimeout(() => {
                this.isConnected = true;
                this.updateStatus("MOCK READER ONLINE", true);
                resolve(true);
            }, 500);
        });
    }

    async disconnect() {
        this.isConnected = false;
        this.stopSimulation();
        this.updateStatus("MOCK READER OFFLINE", false);
    }

    updateStatus(msg, connected) {
        if (this.onStatusChange) this.onStatusChange(msg, connected);
    }

    // --- Simulation Controls ---

    /**
     * Replays a specific sequence of tag reads
     * @param {Array} sequence - [{tag: 'HEX', rssi: -50, delay: 1000}, ...]
     */
    async playSequence(sequence) {
        if (!this.isConnected) await this.connect();

        for (const item of sequence) {
            await new Promise(r => setTimeout(r, item.delay || 0));
            if (this.onTagRead) {
                this.onTagRead(item.tag, item.rssi || -50);
            }
        }
    }

    /**
     * Starts a "Chaos Mode" simulation with random reads
     */
    startSimulation() {
        if (this.interval) clearInterval(this.interval);
        this.interval = setInterval(() => {
            if (!this.isConnected) return;
            const tags = ['E2001234', 'E2005678', 'E200ABCD'];
            const randomTag = tags[Math.floor(Math.random() * tags.length)];
            const randomRssi = Math.floor(Math.random() * 40) - 80; // -80 to -40
            if (this.onTagRead) this.onTagRead(randomTag, randomRssi);
        }, 1500);
    }

    stopSimulation() {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
    }
}
