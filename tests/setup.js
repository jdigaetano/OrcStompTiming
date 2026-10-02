import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load utils.js so decodeBibFromEpc is available globally in all tests that load
// BleDriver.js or AppUI.js, which reference it as a free variable (loaded first in
// index.html via <script src="utils.js">, so tests must mirror that load order).
const _utilsCode = readFileSync(resolve(__dirname, '../utils.js'), 'utf8');
new Function('global', _utilsCode)(global);

// Inject fake IndexedDB into the global scope
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn(key => store[key] || null),
    setItem: vi.fn((key, value) => { store[key] = value.toString(); }),
    clear: vi.fn(() => { store = {}; }),
    removeItem: vi.fn(key => { delete store[key]; }),
  };
})();

global.localStorage = localStorageMock;

// Mock navigator.bluetooth
global.navigator.bluetooth = {
    requestDevice: vi.fn(),
    getDevices: vi.fn().mockResolvedValue([]),
};
