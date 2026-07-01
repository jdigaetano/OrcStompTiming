/**
 * MockBleDriver.js
 * Simulates a hardware reader for testing and development.
 */
class MockBleDriver {
    constructor() {
        this.onTagRead = null;
        this.onRawFrame = null;
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

    async sendRawHex(hex) {
        console.log("MockBleDriver: Received Raw Hex Command:", hex);
    }

    updateStatus(msg, connected) {
        if (this.onStatusChange) this.onStatusChange(msg, connected);
    }

    bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
    }

    // Builds a protocol-accurate CID1=0x20 push frame matching BleDriver's confirmed
    // AN+PC+EPC+RSSI layout. PC high byte encodes EPC word count (top 5 bits), matching
    // the real Gen2 PC word — same formula BleDriver.decodeTagFrame() uses to read it back.
    buildTagFrame(epcHex, rssiDbm, an = 0x00) {
        const epcBytes = epcHex.match(/.{1,2}/g).map(b => parseInt(b, 16));
        const epcLenWords = epcBytes.length / 2;
        const pcHighByte = (epcLenWords << 3) & 0xFF;
        const rssiRaw = rssiDbm < 0 ? (-rssiDbm) & 0xFF : 0;
        const info = [an, pcHighByte, 0x00, ...epcBytes, rssiRaw];
        const header = [0xCC, 0xFF, 0xFF, 0x20, 0x05, info.length];
        const frameWithoutChecksum = [...header, ...info];
        const sum = frameWithoutChecksum.reduce((a, b) => a + b, 0);
        const chksum = (256 - (sum % 256)) % 256;
        return [...frameWithoutChecksum, chksum];
    }

    // Mirrors BleDriver.decodeTagFrame() exactly — MockBleDriver builds its own frames,
    // so it needs to decode them too (to populate tagDecode in onRawFrame and to extract
    // the correct args for onTagRead). Tests cross-validate both against BleDriver's version.
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

    // --- Simulation Controls ---

    /**
     * Replays a sequence of tag reads using protocol-accurate frames.
     * Each item: { epcHex: 'hex string', rssi: -70, delay: 0 }
     */
    async playSequence(sequence) {
        if (!this.isConnected) await this.connect();

        for (const item of sequence) {
            await new Promise(r => setTimeout(r, item.delay || 0));

            const rssiDbm = item.rssi ?? item.rssiDbm ?? -50;
            const frame = this.buildTagFrame(item.epcHex, rssiDbm);
            const tagDecode = this.decodeTagFrame(frame);

            if (this.onRawFrame) {
                this.onRawFrame({ hex: this.bytesToHex(frame), frame, checksumValid: true, tagDecode });
            }
            if (this.onTagRead && tagDecode) {
                this.onTagRead(tagDecode.epcHex, tagDecode.rssiDbm);
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
            const epcs = [
                'AABBCCDDEEFF001122334455',
                'DDEEFF001122334455AABBCC',
                '001122334455AABBCCDDEEFF',
            ];
            const epcHex = epcs[Math.floor(Math.random() * epcs.length)];
            const rssiDbm = Math.floor(Math.random() * 40) - 80;
            const frame = this.buildTagFrame(epcHex, rssiDbm);
            const tagDecode = this.decodeTagFrame(frame);
            if (this.onRawFrame && tagDecode) {
                this.onRawFrame({ hex: this.bytesToHex(frame), frame, checksumValid: true, tagDecode });
            }
            if (this.onTagRead && tagDecode) {
                this.onTagRead(tagDecode.epcHex, tagDecode.rssiDbm);
            }
        }, 1500);
    }

    stopSimulation() {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
    }
}
