/**
 * HidDriver.js
 * Responsibility: Hardware Interface & Protocol Parsing (USB HID transport)
 *
 * Drop-in replacement for BleDriver using WebHID instead of Web Bluetooth.
 * Same 7C FF FF protocol frames, same public interface (onTagRead, onStatusChange,
 * onRawFrame, connect, disconnect, sendRawHex, setWorkMode, scanForTag, writeBibToEpc).
 *
 * Hardware: Aosid USB UHF Reader (vendorId=0x04D8), Interface 0, usage page 0xFF00
 * (vendor-defined). Endpoint 1 IN / Endpoint 2 OUT, 64-byte interrupt. reportId=0
 * (raw bytes, no report ID prefix byte on either direction).
 */
class HidDriver {
    constructor() {
        this.device = null;

        this.onTagRead = null;
        this.onRawFrame = null;
        this.onStatusChange = null;

        this.intentionalDisconnect = false;
        this._pendingCommand = null;
        this._inputReportHandler = null;
    }

    get isConnected() {
        return !!(this.device && this.device.opened);
    }

    async connect() {
        const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x04D8 }] });
        const device = devices[0];
        if (!device) throw new Error('No device selected');
        this.device = device;
        await this._openAndListen();
    }

    async tryAutoConnect() {
        if (!navigator.hid) return false;
        let devices;
        try {
            devices = await navigator.hid.getDevices();
        } catch (e) {
            return false;
        }
        const device = devices.find(d => d.vendorId === 0x04D8);
        if (!device) return false;
        this.device = device;
        await this._openAndListen();
        return true;
    }

    async retryConnect() {
        if (!this.device) throw new Error('No device selected — use Connect Reader first.');
        await this._openAndListen();
    }

    async _openAndListen() {
        this.intentionalDisconnect = false;
        if (!this.device.opened) await this.device.open();
        this._inputReportHandler = (event) => this.parseFrame(event);
        this.device.addEventListener('inputreport', this._inputReportHandler);
        this.device.addEventListener('disconnect', () => this._handleDisconnect());
        this.updateStatus('READER ONLINE', true);
    }

    _handleDisconnect() {
        if (this.intentionalDisconnect) return;
        this.updateStatus('READER OFFLINE - USB UNPLUGGED', false);
    }

    async disconnect() {
        this.intentionalDisconnect = true;
        if (this._inputReportHandler && this.device) {
            this.device.removeEventListener('inputreport', this._inputReportHandler);
            this._inputReportHandler = null;
        }
        if (this.device && this.device.opened) await this.device.close();
        this.device = null;
        this.updateStatus('READER OFFLINE', false);
    }

    // HID inputreport event shape: { data: DataView, reportId: number }
    // reportId=0 means no report ID byte prefix — data contains raw frame bytes.
    parseFrame(event) {
        const value = event.data;
        if (value.byteLength < 6) return;
        const bytes = [];
        for (let i = 0; i < value.byteLength; i++) bytes.push(value.getUint8(i));

        let i = 0;
        while (i < bytes.length) {
            if (bytes[i] === 0xCC || bytes[i] === 0x7C) {
                if (i + 5 >= bytes.length) { i++; continue; }
                const infoLen = bytes[i + 5];
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

        let sum = 0;
        for (let b of frame) sum += b;
        const checksumValid = (sum & 0xFF) === 0;

        const tagDecode = this.decodeTagFrame(frame);

        if (this.onRawFrame) {
            this.onRawFrame({ hex: fullHex, frame, checksumValid, tagDecode });
        }

        if (!checksumValid) {
            console.warn(`HidDriver: Checksum mismatch! Sum & 0xFF = ${(sum & 0xFF).toString(16)}`, fullHex);
            return;
        }

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

    sendCommand(hexString, expectedCid1, timeoutMs = 1000) {
        if (!this.device) return Promise.reject(new Error('No write pipe available'));

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
        if (!this.device) throw new Error('No write pipe available');

        let finalHex = hex;
        const bytes = hex.match(/.{1,2}/g).map(b => parseInt(b, 16));
        const declaredLen = bytes[5] || 0;

        if (hex.startsWith('7C') && bytes.length === (6 + declaredLen)) {
            let sum = 0;
            for (let b of bytes) sum += b;
            const checksum = ((~sum) + 1) & 0xFF;
            finalHex += checksum.toString(16).padStart(2, '0').toUpperCase();
        }

        const data = new Uint8Array(finalHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        await this.device.sendReport(0, data);
    }

    async setWorkMode(mode) {
        await this.sendRawHex(mode === 'command' ? '7CFFFF34000100' : '7CFFFF34000101');
    }

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

    async writeBibToEpc(bibNum, totalWaitMs = 5000, pollIntervalMs = 300) {
        const bh = (bibNum >> 8) & 0xFF;
        const bl = bibNum & 0xFF;
        const bhHex = bh.toString(16).padStart(2, '0').toUpperCase();
        const blHex = bl.toString(16).padStart(2, '0').toUpperCase();
        const writeHex = `7CFFFF220013000000000102064F53${bhHex}${blHex}0000000000000000`;

        const maxAttempts = Math.max(1, Math.ceil(totalWaitMs / pollIntervalMs));
        let found = false;
        for (let i = 0; i < maxAttempts; i++) {
            try {
                await this.sendCommand('7CFFFF200000', 0x20, pollIntervalMs);
                found = true;
                break;
            } catch (e) { }
        }
        if (!found) {
            return { success: false, message: 'No chip detected within timeout.' };
        }

        try {
            await this.sendCommand(writeHex, 0x22);
        } catch (e) {
            return { success: false, message: e.message };
        }

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

    updateStatus(msg, connected) {
        if (this.onStatusChange) this.onStatusChange(msg, connected);
    }
}
