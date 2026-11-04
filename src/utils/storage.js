function safeLoad(key, fallback, version = null) { 
    try { 
        const v = localStorage.getItem(key); 
        if (v === null || v === undefined || v === "undefined") {
            return fallback; 
        }
        const parsed = JSON.parse(v); 
        // A stored envelope may carry an older __v after a schema bump. That
        // must NEVER discard real data: the fallback here silently reset the
        // demo portfolio (positions + ledger went back to balance 10000 and
        // then the empty state was persisted over the good one). Consumers
        // normalize the shape they read; version drift only logs.
        if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'data') && Object.prototype.hasOwnProperty.call(parsed, '__v')) {
            if (version && parsed.__v !== version) {
                console.warn(`[Storage] Schema drift for "${key}" (stored __v=${parsed.__v}, current=${version}); payload kept.`);
            }
            return parsed.data;
        }
        return parsed; 
    } catch (e) { 
        console.warn('[Storage] Failed to load:', key, e);
        return fallback; 
    }
}

// Preferences used to be plain strings; newer writes use the versioned
// safeStore envelope. Accept both so reload never silently changes the pair.
function loadPreference(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null || raw === undefined || raw === 'undefined') return fallback;
        const value = safeLoad(key, raw);
        return typeof value === 'string' || typeof value === 'number' ? value : fallback;
    } catch (e) {
        return fallback;
    }
}

// localStorage is attacker-writable (DevTools, extensions, bookmarklets).
// Everything read back through these helpers is shape-checked so one hostile
// value cannot crash the boot loop or poison a render with non-finite math.
function toFiniteNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
}

// Ledgers (futuresLog/polymarketLog): array of plain objects, capped so a
// hand-crafted 10 MB array cannot stall the UI. Entries are kept verbatim
// (they are rendered via textContent paths); non-object rows are dropped.
function loadTradingLog(key, maxEntries = 500) {
    const raw = safeLoad(key, []);
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
        .slice(0, maxEntries);
}

function safeStore(key, value, version = null) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return false;
        localStorage.setItem(key, JSON.stringify(version ? { __v: version, data: value } : value));
        return true;
    } catch (e) {
        console.warn('safeStore failed', key, e);
        return false;
    }
}

function escapeHTML(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function createSafeContentNode(content) {
    if (typeof Node !== 'undefined' && content instanceof Node) return content;
    if (content && typeof content === 'object' && !Array.isArray(content)) {
        const tag = /^[a-z][a-z0-9-]*$/i.test(content.tag || '') ? content.tag : 'span';
        const node = document.createElement(tag);
        if (content.className) node.className = String(content.className);
        if (content.text !== undefined) node.textContent = String(content.text);
        if (content.attrs && typeof content.attrs === 'object') {
            Object.entries(content.attrs).forEach(([key, value]) => {
                if (value === undefined || value === null) return;
                if (!/^[a-z_:][a-z0-9_:.\-]*$/i.test(key)) return;
                // Atribut event/style dan URL javascript: ditolak agar descriptor node tetap aman.
                if (/^on/i.test(key) || key.toLowerCase() === 'style') return;
                if ((key === 'href' || key === 'src') && /^javascript:/i.test(String(value).trim())) return;
                node.setAttribute(key, String(value));
            });
        }
        return node;
    }
    return document.createTextNode(String(content ?? ''));
}

function setSafeText(id, content, color, contentType = 'text') {
    const e = document.getElementById(id); 
    if (e) { 
        if (content !== undefined) {
            if (contentType === 'nodes') {
                const nodes = Array.isArray(content) ? content : [content];
                e.replaceChildren(...nodes.map(createSafeContentNode));
            } else {
                // Default textContent memaksa data dinamis tidak pernah dieksekusi sebagai HTML.
                e.textContent = String(content ?? '');
            }
        }
        if (color !== undefined) e.style.color = color; 
    } 
}

if (typeof window !== 'undefined') {
    window.safeStore = safeStore;
    window.escapeHTML = escapeHTML;
    window.createSafeContentNode = createSafeContentNode;
    window.setSafeText = setSafeText;
    window.toFiniteNumber = toFiniteNumber;
    window.loadTradingLog = loadTradingLog;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { safeLoad, loadPreference, safeStore, escapeHTML, createSafeContentNode, setSafeText, toFiniteNumber, loadTradingLog };
}
