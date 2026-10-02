/**
 * utils.js
 * Shared pure-function utilities used by both BleDriver and AppUI.
 * Must be loaded before BleDriver.js and AppUI.js in index.html.
 */

function decodeBibFromEpc(epcHex) {
    if (!epcHex || epcHex.length < 8) return null;
    if (epcHex.toUpperCase().slice(0, 4) !== '4F53') return null;
    return parseInt(epcHex.slice(4, 8), 16);
}

// Allow loadScript() in tests to both return the function object AND set it as a global.
// In the browser, function declarations in <script> tags are already window-scoped.
// In Node test environment (new Function('global', ...)), 'global' is the passed-in
// Node global, so this makes decodeBibFromEpc available to all subsequent loadScript calls.
if (typeof global !== 'undefined') global.decodeBibFromEpc = decodeBibFromEpc;

// Return value for loadScript('utils.js') — avoids ReferenceError on the implicit `return utils`
const utils = { decodeBibFromEpc };
