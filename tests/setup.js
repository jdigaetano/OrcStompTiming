import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { beforeEach, vi } from 'vitest';

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
