/**
 * TimingEngine.js
 * Responsibility: State, Persistence, and Deduplication
 */
class TimingEngine {
    constructor() {
        this.DB_NAME = "RaceTimingDB";
        this.DB_VERSION = 2;
        this.db = null;

        this.isTrackingRace = false;
        this.raceStartTime = null;

        this.writeQueue = [];
        this.seenTags = new Map(); // tag_hex → first-seen ms; gate for 10s write window
        this.onRecordPersisted = null; // Callback for UI updates

        // Expose a promise that resolves when DB is ready
        this.ready = this.initDB().then(() => {
            this.restoreSession();
            this.startDaemon();
            console.log("TimingEngine: Database and Daemon ready.");
        });
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                console.log("TimingEngine: Upgrading/Initializing Database...");
                if (!db.objectStoreNames.contains('chip_map')) {
                    db.createObjectStore('chip_map', { keyPath: 'chip_hex' });
                }
                if (!db.objectStoreNames.contains('race_reads')) {
                    db.createObjectStore('race_reads', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('app_settings')) {
                    db.createObjectStore('app_settings', { keyPath: 'key' });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve();
            };

            request.onerror = (e) => {
                console.error("TimingEngine: IndexedDB Error", e.target.error);
                reject(e.target.error);
            };
        });
    }

    restoreSession() {
        this.raceStartTime = localStorage.getItem('raceStartTime');
    }

    handleIncomingTag(tagHex, rssi) {
        if (!this.isTrackingRace || !this.raceStartTime) return;

        const now = new Date();
        const record = {
            tag_hex: tagHex,
            rssi: rssi,
            timestamp: now.toISOString(),
            elapsed_ms: now.getTime() - new Date(this.raceStartTime).getTime(),
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
                const recordTime = new Date(record.timestamp).getTime();
                const firstSeen = this.seenTags.get(record.tag_hex);
                if (firstSeen !== undefined && recordTime - firstSeen >= 10000) {
                    return; // past 10-second window — drop
                }
                if (firstSeen === undefined) {
                    this.seenTags.set(record.tag_hex, recordTime);
                }
                store.add(record);
                if (this.onRecordPersisted) this.onRecordPersisted(record);
            });

            tx.onerror = (e) => console.error("TimingEngine: Batch write failed", e.target.error);
        }, 250);
    }

    async saveMapping(chipHex, bibNum) {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(['chip_map'], 'readwrite');
        tx.objectStore('chip_map').put({ chip_hex: chipHex.toUpperCase().trim(), bib_num: parseInt(bibNum, 10) });
        return new Promise(r => tx.oncomplete = r);
    }

    async getMappings() {
        if (!this.db) return [];
        return this.getAllFromStore('chip_map');
    }

    async deleteMapping(chipHex) {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(['chip_map'], 'readwrite');
        tx.objectStore('chip_map').delete(chipHex.toUpperCase().trim());
        return new Promise(r => tx.oncomplete = r);
    }

    async saveBackupHandle(handle) {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(['app_settings'], 'readwrite');
        tx.objectStore('app_settings').put({ key: 'backupHandle', handle });
        return new Promise(r => tx.oncomplete = r);
    }

    async getBackupHandle() {
        if (!this.db) return null;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['app_settings'], 'readonly');
            const req = tx.objectStore('app_settings').get('backupHandle');
            req.onsuccess = () => resolve(req.result ? req.result.handle : null);
            req.onerror = () => reject(req.error);
        });
    }

    // Deliberately does zero computation — a raw, complete dump of both stores.
    // This is what the periodic in-race backup timer calls; any aggregation/joins
    // belong in the heavyweight (race-stopped) backup path instead.
    async getRawSnapshot() {
        return {
            raceStartTime: this.raceStartTime,
            race_reads: await this.getAllFromStore('race_reads'),
            chip_map: await this.getAllFromStore('chip_map'),
        };
    }

    async replaceChipMap(mappings) {
        if (!this.db) throw new Error("Database not initialized");
        const tx = this.db.transaction(['chip_map'], 'readwrite');
        const store = tx.objectStore('chip_map');
        store.clear();
        mappings.forEach(m => store.put({ chip_hex: m.chip_hex.toUpperCase().trim(), bib_num: parseInt(m.bib_num, 10) }));
        return new Promise(r => tx.oncomplete = r);
    }

    async clearRaceData() {
        const tx = this.db.transaction(['race_reads'], 'readwrite');
        tx.objectStore('race_reads').clear();
        localStorage.removeItem('raceStartTime');
        this.raceStartTime = null;
        this.isTrackingRace = false;
        this.seenTags.clear();
        return new Promise(r => tx.oncomplete = r);
    }

    async clearAllData() {
        await this.clearRaceData();
        if (!this.db) return;
        const tx = this.db.transaction(['chip_map'], 'readwrite');
        tx.objectStore('chip_map').clear();
        return new Promise(r => tx.oncomplete = r);
    }

    getAllFromStore(storeName) {
        return new Promise((resolve, reject) => {
            if (!this.db) return resolve([]);
            const tx = this.db.transaction([storeName], 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
}
