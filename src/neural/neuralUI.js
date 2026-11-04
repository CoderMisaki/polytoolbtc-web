/* neuralUI.js — ANIMAL NEURAL LAB panel renderer.
 *
 * Two jobs:
 *   1. one readable row per animal brain (name, role, direction, confidence,
 *      activation, synapse strength, top contributing factors);
 *   2. the "Pola Ditemukan" panel: the wide-context patterns mined from months
 *      of higher-timeframe data, written in plain language so a human can see
 *      what the animal brains are reacting to.
 *
 * Lightweight DOM updates, throttled via requestAnimationFrame. Never throws
 * into the chart/tick loop; all rendering is best-effort.
 * Classic script exposing window.NeuralUI (browser only; Node-safe load).
 */
(function NeuralUIUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.NeuralUI = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildNeuralUI(root) {
    'use strict';

    const MIN_RENDER_INTERVAL_MS = 1200;
    const MAX_ACTIVITY_ROWS = 30;
    const MAX_PATTERNS = 5;

    const AGENTS = [
        { id: 'chimpanzee', icon: '🐒', name: 'CHIMPANZEE', role: 'Pola & Strategi', color: '#4ade80' },
        { id: 'raven', icon: '🐦', name: 'RAVEN', role: 'Taktik & Jebakan', color: '#fbbf24' },
        { id: 'dolphin', icon: '🐬', name: 'DOLPHIN', role: 'Sentimen Massa', color: '#00e5ff' },
        { id: 'elephant', icon: '🐘', name: 'ELEPHANT', role: 'Memori Historis', color: '#c084fc' },
        { id: 'eagle', icon: '🦅', name: 'EAGLE', role: 'Struktur Besar', color: '#f59e0b' },
        { id: 'owl', icon: '🦉', name: 'OWL', role: 'Observasi Tenang', color: '#94a3b8' },
        { id: 'dragonfly', icon: '🪰', name: 'DRAGONFLY', role: 'Refleks Cepat', color: '#22d3ee' },
        { id: 'octopus', icon: '🐙', name: 'OCTOPUS', role: 'Fusi Adaptif', color: '#fb7185' }
    ];

    const S = {
        built: false,
        queued: false,
        rafId: null,
        disposed: false,
        lastRenderAt: 0,
        lastEventCount: 0,
        lastPatternKey: '',
        refs: { agents: {} }
    };

    function doc() {
        return (typeof document !== 'undefined') ? document : null;
    }

    function system() {
        if (root && root.AnimalNeuralSystem) return root.AnimalNeuralSystem;
        if (typeof AnimalNeuralSystem !== 'undefined') return AnimalNeuralSystem;
        return null;
    }

    function el(tag, className, text) {
        const d = doc();
        const node = d.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function signalWord(bias) {
        if (!Number.isFinite(bias)) return 'TU';
        if (bias > 0.12) return 'LONG';
        if (bias < -0.12) return 'SHORT';
        return 'NETRAL';
    }

    function pct(v) {
        if (!Number.isFinite(v)) return '—';
        return Math.round(v * 100) + '%';
    }

    function ensureBuilt() {
        if (S.built) return true;
        const d = doc();
        if (!d) return false;
        const mount = d.getElementById('neural-agents');
        if (!mount) return false;

        AGENTS.forEach(function (a) {
            const row = el('div', 'neural-agent');
            row.id = 'neural-agent-' + a.id;
            const head = el('div', 'neural-agent-head');
            head.appendChild(el('span', 'neural-agent-icon', a.icon));
            const title = el('div', 'neural-agent-title');
            title.appendChild(el('div', 'neural-agent-name', a.name));
            title.appendChild(el('div', 'neural-agent-role', a.role));
            head.appendChild(title);
            const sig = el('span', 'neural-agent-signal neural-sig-neutral', '—');
            head.appendChild(sig);
            row.appendChild(head);

            const grid = el('div', 'neural-agent-grid');
            const refs = { signal: sig, bars: {}, values: {} };
            const metrics = [
                ['conf', 'CONF'],
                ['act', 'AKTIV'],
                ['syn', 'SINAPS']
            ];
            metrics.forEach(function (m) {
                const cell = el('div', 'neural-metric');
                cell.appendChild(el('div', 'neural-metric-label', m[1]));
                const bar = el('div', 'neural-bar');
                const fill = el('div', 'neural-bar-fill');
                bar.appendChild(fill);
                cell.appendChild(bar);
                const val = el('div', 'neural-metric-val', '—');
                cell.appendChild(val);
                grid.appendChild(cell);
                refs.bars[m[0]] = fill;
                refs.values[m[0]] = val;
            });
            row.appendChild(grid);
            const factors = el('div', 'neural-factors', '—');
            row.appendChild(factors);
            refs.factors = factors;
            refs.row = row;
            mount.appendChild(row);
            S.refs.agents[a.id] = refs;
        });

        S.built = true;
        return true;
    }

    function setBar(refs, key, ratio) {
        const fill = refs.bars[key];
        const val = refs.values[key];
        const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
        if (fill) fill.style.width = (r * 100).toFixed(0) + '%';
        if (val) val.textContent = Number.isFinite(ratio) ? pct(ratio) : '—';
    }

    function renderAgents(snapshot) {
        const agents = (snapshot && snapshot.agents) || {};
        const synapses = (snapshot && snapshot.synapses) || [];
        const out = {};
        synapses.forEach(function (s) {
            if (!s) return;
            out[s.source] = out[s.source] || [];
            out[s.source].push(s.weight);
        });
        AGENTS.forEach(function (a) {
            const refs = S.refs.agents[a.id];
            if (!refs) return;
            const r = agents[a.id];
            if (!r) {
                refs.signal.textContent = '—';
                return;
            }
            const word = signalWord(r.bias);
            refs.signal.textContent = word;
            refs.signal.className = 'neural-agent-signal ' +
                (word === 'LONG' ? 'neural-sig-long' : (word === 'SHORT' ? 'neural-sig-short' : 'neural-sig-neutral'));
            refs.row.classList.toggle('neural-agent-offline', r.ok === false);
            setBar(refs, 'conf', r.confidence);
            setBar(refs, 'act', r.activation);
            const synList = out[a.id] || [];
            const synAvg = synList.length > 0
                ? synList.reduce(function (x, y) { return x + y; }, 0) / synList.length
                : 0;
            setBar(refs, 'syn', synAvg);
            if (refs.factors) {
                const factors = Array.isArray(r.factors) ? r.factors.slice(0, 2) : [];
                refs.factors.textContent = factors.length > 0
                    ? factors.map(function (fc) {
                        return fc.label + ' ' + (fc.value >= 0 ? '+' : '') + (fc.value * 100).toFixed(0);
                    }).join(' · ')
                    : '—';
            }
        });
    }

    function renderMeta(snapshot) {
        const d = doc();
        if (!d) return;
        function setText(id, value) {
            const n = d.getElementById(id);
            if (n) n.textContent = value;
        }
        const meta = snapshot ? snapshot.meta : null;
        const gate = snapshot ? snapshot.gate : null;
        setText('neural-meta-decision', meta ? meta.decision : '—');
        setText('neural-meta-conf', meta ? pct(meta.confidence) : '—');
        setText('neural-meta-cons', meta ? pct((meta.consensus + 1) / 2) : '—');
        setText('neural-meta-risk', meta ? pct(meta.risk) : '—');
        const gateEl = d.getElementById('neural-meta-gate');
        if (gateEl) {
            gateEl.textContent = gate ? (gate.pass ? 'PASS' : 'NO TRADE') : '—';
            gateEl.className = 'neural-gate ' + (gate && gate.pass ? 'neural-gate-pass' : 'neural-gate-block');
        }
        const statusEl = d.getElementById('neural-status');
        if (statusEl) {
            statusEl.textContent = snapshot ? snapshot.status : '—';
            statusEl.className = 'neural-status neural-st-' + String(snapshot ? snapshot.status : 'na').toLowerCase().replace(/_/g, '-');
        }
        const decEl = d.getElementById('neural-meta-decision');
        if (decEl) {
            decEl.className = 'neural-decision ' +
                (meta && meta.decision === 'LONG' ? 'neural-sig-long' :
                    (meta && meta.decision === 'SHORT' ? 'neural-sig-short' : 'neural-sig-neutral'));
        }
    }

    function patternSourceText(patterns) {
        if (!patterns) return 'Data pola: belum dimuat';
        if (!patterns.available) {
            const counts = patterns.counts || {};
            const loaded = Object.keys(counts).reduce(function (acc, tf) { return acc + (counts[tf] || 0); }, 0);
            return loaded > 0
                ? ('Data pola: ' + loaded + ' candle terkumpul, menunggu cukup data')
                : 'Data pola: memuat riwayat multi-timeframe…';
        }
        const counts = patterns.counts || {};
        const parts = [];
        ['1d', '4h', '1h', '15m', '5m', '1m'].forEach(function (tf) {
            if (counts[tf] > 0) parts.push(tf + ' × ' + counts[tf]);
        });
        return 'Data pola: ' + parts.join(' · ') +
            ' → ' + patterns.candles + ' candle' +
            (patterns.partial ? ' (sebagian)' : '') +
            (patterns.pair ? ' · ' + patterns.pair : '');
    }

    function renderPatterns(patterns) {
        const d = doc();
        if (!d) return;
        const sourceEl = d.getElementById('neural-pattern-source');
        if (sourceEl) sourceEl.textContent = patternSourceText(patterns);

        const list = d.getElementById('neural-pattern-list');
        if (!list || typeof list.replaceChildren !== 'function') return;

        const findings = patterns && patterns.available && Array.isArray(patterns.findings)
            ? patterns.findings.slice(0, MAX_PATTERNS)
            : [];
        const key = findings.map(function (f) { return f.id + ':' + f.direction + ':' + Math.round(f.strength * 100); }).join('|');
        if (key === S.lastPatternKey && list.childNodes.length > 0) return;
        S.lastPatternKey = key;

        const frag = d.createDocumentFragment();
        if (findings.length === 0) {
            const empty = el('div', 'neural-pattern-empty',
                patterns && patterns.available
                    ? 'Belum ada pola dengan bukti cukup pada data saat ini. Coba tunggu data pola selesai dimuat.'
                    : 'Mengumpulkan data luas (hari, jam, menit) untuk mencari pola…');
            frag.appendChild(empty);
        }
        findings.forEach(function (f) {
            const card = el('div', 'neural-pattern-card neural-pattern-' + String(f.direction || 'NEUTRAL').toLowerCase());
            const head = el('div', 'neural-pattern-head');
            head.appendChild(el('span', 'neural-pattern-title', f.title));
            head.appendChild(el('span', 'neural-pattern-badge', f.direction || 'NEUTRAL'));
            card.appendChild(head);
            card.appendChild(el('div', 'neural-pattern-detail', f.detail));
            card.appendChild(el('div', 'neural-pattern-meta',
                'kekuatan ' + pct(f.strength) + ' · ' + f.samples + ' contoh · ' + f.source));
            frag.appendChild(card);
        });
        list.replaceChildren(frag);
    }

    function renderActivity() {
        const d = doc();
        if (!d) return;
        const box = d.getElementById('neural-activity');
        if (!box) return;
        const sys = system();
        if (!sys || typeof sys.drainEvents !== 'function') return;
        const events = sys.drainEvents(MAX_ACTIVITY_ROWS);
        if (events.length === S.lastEventCount && box.childNodes.length > 0) return;
        S.lastEventCount = events.length;
        // Batch DOM writes: rebuild only when new events arrived.
        const frag = d.createDocumentFragment();
        events.slice(-MAX_ACTIVITY_ROWS).forEach(function (ev) {
            const row = d.createElement('div');
            row.className = 'neural-log-row neural-log-' + (ev.kind || 'info');
            const clock = d.createElement('span');
            clock.className = 'neural-log-clock';
            clock.textContent = '[' + ev.clock + ']';
            const body = d.createElement('span');
            body.className = 'neural-log-body';
            body.textContent = ' ' + ev.agent + ' → ' + ev.text;
            row.appendChild(clock);
            row.appendChild(body);
            frag.appendChild(row);
        });
        box.replaceChildren(frag);
        try { box.scrollTop = box.scrollHeight; } catch (e) { /* noop */ }
    }

    function neuralCanvas() {
        if (root && root.NeuralCanvas) return root.NeuralCanvas;
        if (typeof NeuralCanvas !== 'undefined') return NeuralCanvas;
        return null;
    }

    function render() {
        try {
            if (!ensureBuilt()) return;
            const sys = system();
            const snapshot = sys && typeof sys.getSnapshot === 'function' ? sys.getSnapshot() : null;
            renderAgents(snapshot);
            renderMeta(snapshot);
            renderPatterns(snapshot ? snapshot.patterns : null);
            renderActivity();
            // The realtime brain map owns its own rAF loop; start() is
            // idempotent and self-cancels when hidden or disposed.
            const canvas = neuralCanvas();
            if (canvas && typeof canvas.start === 'function') canvas.start();
            S.lastRenderAt = Date.now();
        } catch (e) { /* rendering never breaks the app */ }
    }

    function raf(fn) {
        S.rafId = null;
        const win = root || {};
        if (typeof win.requestAnimationFrame === 'function') return win.requestAnimationFrame(fn);
        if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
        return setTimeout(fn, 16);
    }

    function cancelRaf(id) {
        if (id === null || id === undefined) return;
        const win = root || {};
        if (typeof win.cancelAnimationFrame === 'function') {
            try { win.cancelAnimationFrame(id); return; } catch (e) { /* noop */ }
        }
        try { cancelAnimationFrame(id); } catch (e) { /* noop */ }
    }

    function scheduleUpdate() {
        try {
            if (S.disposed || S.queued) return;
            const gap = Date.now() - S.lastRenderAt;
            if (gap < MIN_RENDER_INTERVAL_MS && S.lastRenderAt > 0) return;
            S.queued = true;
            S.rafId = raf(function () {
                S.rafId = null;
                S.queued = false;
                render();
            });
        } catch (e) { S.queued = false; S.rafId = null; }
    }

    /** Cancel any queued frame; used when the page goes away. */
    function dispose() {
        S.disposed = true;
        S.queued = false;
        cancelRaf(S.rafId);
        S.rafId = null;
        S.refs = { agents: {} };
        S.built = false;
    }

    if (root && typeof root.addEventListener === 'function') {
        const onPageHide = function () {
            dispose();
            try { root.removeEventListener('pagehide', onPageHide); } catch (e) { /* noop */ }
        };
        root.addEventListener('pagehide', onPageHide, { once: true });
    }

    return {
        scheduleUpdate: scheduleUpdate,
        render: render,
        dispose: dispose,
        AGENTS: AGENTS
    };
});
