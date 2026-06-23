/**
 * TimingEngine.js
 * Responsibility: State, Persistence, and Deduplication
 */
class TimingEngine {
    constructor() {
        this.DB_NAME = "RaceTimingDB";
        this.DB_VERSION = 1;
        this.db = null;

        this.isTrackingRace = false;
        this.raceStartTime = null;

        this.writeQueue = [];
        this.onRecordPersisted = null; // Callback for UI updates

        this.initDB();
        this.restoreSession();
        this.startDaemon();
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('chip_map')) db.createObjectStore('chip_map', { keyPath: 'chip_hex' });
                if (!db.objectStoreNames.contains('race_reads')) db.createObjectStore('race_reads', { keyPath: 'id', autoIncrement: true });
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    restoreSession() {
        this.raceStartTime = localStorage.getItem('raceStartTime');
        // tracking status will be handled by AppUI state recovery
    }

    handleIncomingTag(tagHex, rssi) {
        if (!this.isTrackingRace || !this.raceStartTime) return;

        const record = {
            tag_hex: tagHex,
            rssi: rssi,
            timestamp: new Date().toISOString()
        };

        // High-speed producer push
        this.writeQueue.push(record);
    }

    startDaemon() {
        setInterval(() => {
            if (this.writeQueue.length === 0 || !this.db) return;

            const batch = [...this.writeQueue];
            this.writeQueue = [];

            const tx = this.db.transaction(['race_reads'], 'readwrite');
            const store = tx.objectStore('race_reads');

            batch.forEach(record => {
                store.add(record);
                if (this.onRecordPersisted) this.onRecordPersisted(record);
            });
        }, 250);
    }

    async saveMapping(chipHex, bibNum) {
        const tx = this.db.transaction(['chip_map'], 'readwrite');
        tx.objectStore('chip_map').put({ chip_hex: chipHex.toUpperCase(), bib_num: bibNum });
        return new Promise(r => tx.oncomplete = r);
    }

    async getMappings() {
        return this.getAllFromStore('chip_map');
    }

    async clearRaceData() {
        const tx = this.db.transaction(['race_reads'], 'readwrite');
        tx.objectStore('race_reads').clear();
        localStorage.removeItem('raceStartTime');
        this.raceStartTime = null;
        return new Promise(r => tx.oncomplete = r);
    }

    async clearAllData() {
        await this.clearRaceData();
        const tx = this.db.transaction(['chip_map'], 'readwrite');
        tx.objectStore('chip_map').clear();
        return new Promise(r => tx.oncomplete = r);
    }

    getAllFromStore(storeName) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction([storeName], 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
}
