/* chartLifecycle.js — robust chart boot orchestration (P1 initial-load fix).
 *
 * Enforced pipeline (no WS tick required for visibility):
 *   APP_READY -> CHART_CONTAINER_READY -> CREATE_CHART -> FETCH_HISTORICAL_DATA
 *   -> VALIDATE+NORMALIZE -> SET_SERIES -> RENDER -> FIT_CONTENT
 *   -> REMOVE_LOADING -> CONNECT_REALTIME_FEED -> LIVE
 *
 * Classic browser script exposing window.ChartLifecycle. Also loads in Node
 * (UMD) for unit tests; browser globals are only touched inside functions
 * behind typeof guards.
 */
(function ChartLifecycleUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.ChartLifecycle = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildChartLifecycle(root) {
    'use strict';

    const PHASES = {
        IDLE: 'IDLE',
        WAITING_LAYOUT: 'WAITING_LAYOUT',
        CREATING: 'CREATING',
        FETCHING: 'FETCHING',
        RENDERING: 'RENDERING',
        LIVE: 'LIVE',
        ERROR: 'ERROR'
    };

    const LAYOUT_TIMEOUT_MS = 5000;
    const LAYOUT_POLL_FALLBACK_MS = 16;
    const FETCH_TIMEOUT_MS = 10000;
    const MAX_FAST_RETRIES = 5;
    const SLOW_RETRY_MS = 30000;

    function getCV() {
        if (root && root.CandleValidation) return root.CandleValidation;
        try {
            if (typeof require === 'function') return require('./candleValidation');
        } catch (e) { /* browser without global yet */ }
        return null;
    }

    const guard = (function () {
        const CV = null;
        void CV;
        let current = 0;
        return {
            next: function () { current += 1; return current; },
            current: function () { return current; },
            isCurrent: function (token) { return token === current; },
            invalidate: function () { current += 1; return current; }
        };
    })();

    const state = {
        phase: PHASES.IDLE,
        session: 0,
        retryCount: 0,
        slowTimer: null,
        abortController: null,
        lastError: null,
        bootPromise: null,
        listeners: [],
        timingOverride: null,
        historySession: 0
    };

    // Test-only timing override ({ maxFastRetries, retryDelayMs, slowRetryMs }).
    // Production behavior is unchanged when no override is set.
    function maxFastRetries() {
        const o = state.timingOverride;
        return (o && Number.isFinite(o.maxFastRetries)) ? o.maxFastRetries : MAX_FAST_RETRIES;
    }

    function retryDelayMs(count) {
        const o = state.timingOverride;
        if (o && Number.isFinite(o.retryDelayMs)) return Math.max(0, o.retryDelayMs);
        const CV = getCV();
        return CV ? CV.computeRetryDelayMs(count) : Math.min(3000 * count, 15000);
    }

    function slowRetryMs() {
        const o = state.timingOverride;
        return (o && Number.isFinite(o.slowRetryMs)) ? Math.max(0, o.slowRetryMs) : SLOW_RETRY_MS;
    }

    function getDoc() {
        return (typeof document !== 'undefined') ? document : null;
    }

    function getAppState() {
        if (root && root.AppState) return root.AppState;
        // AppState is a top-level `const` in appState.js: in real browsers it
        // is NOT a window property, only a global lexical binding.
        try {
            if (typeof AppState !== 'undefined' && AppState) return AppState;
        } catch (e) { /* TDZ / unavailable */ }
        return null;
    }

    function emitLifecycleEvent(phase, detail) {
        state.phase = phase;
        const payload = Object.assign({ phase: phase, session: state.session }, detail || {});
        for (let i = 0; i < state.listeners.length; i++) {
            try { state.listeners[i](payload); } catch (e) { /* never break boot */ }
        }
        try {
            const doc = getDoc();
            if (doc && typeof doc.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                doc.dispatchEvent(new CustomEvent('masako:lifecycle', { detail: payload }));
            }
        } catch (e) { /* non-browser or old DOM */ }
        return payload;
    }

    function onPhase(listener) {
        if (typeof listener === 'function') state.listeners.push(listener);
        return function unsubscribe() {
            const idx = state.listeners.indexOf(listener);
            if (idx >= 0) state.listeners.splice(idx, 1);
        };
    }

    function readLayout() {
        const doc = getDoc();
        if (!doc || typeof doc.getElementById !== 'function') return { ok: false, reason: 'no-dom' };
        const container = doc.getElementById('chart-container');
        const main = doc.getElementById('main-chart');
        const rsi = doc.getElementById('rsi-chart');
        if (!container || !main || !rsi) return { ok: false, reason: 'missing-nodes' };
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (!(w > 0 && h > 0)) {
            // Fallback viewport: di desktop, flex layout frame-pertama sering 0
            // (mobile punya height eksplisit 400px sehingga lolos). Tanpa ini
            // desktop menunggu sampai timeout lalu mengandalkan fallback flag.
            try {
                const vw = (root && root.innerWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
                const vh = (root && root.innerHeight) || (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
                if (vw > 300 && vh > 300) {
                    return {
                        ok: false, reason: 'zero-size', w: w, h: h, fallback: true,
                        vw: vw, vh: vh,
                        fw: Math.max(320, vw - (vw > 768 ? 360 : 0)),
                        fh: Math.max(420, Math.floor(vh * 0.62))
                    };
                }
            } catch (e) { /* abaikan, pakai zero-size biasa */ }
            return { ok: false, reason: 'zero-size', w: w, h: h };
        }
        return { ok: true, w: w, h: h };
    }

    /**
     * Wait until the chart container has a valid (non-zero) layout.
     * Never relies on a single first-frame measurement: combines
     * requestAnimationFrame polling with ResizeObserver + a bounded timeout.
     */
    function waitForLayoutReady(session, timeoutMs) {
        const limit = Number.isFinite(timeoutMs) ? timeoutMs : LAYOUT_TIMEOUT_MS;
        return new Promise(function (resolve) {
            const startedAt = Date.now();
            let settled = false;
            let rafId = null;
            let observer = null;

            function done(result) {
                if (settled) return;
                settled = true;
                try {
                    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
                } catch (e) { /* noop */ }
                try { if (observer) observer.disconnect(); } catch (e) { /* noop */ }
                resolve(result);
            }

            function poll() {
                if (settled) return;
                if (!guard.isCurrent(session)) {
                    done({ ok: false, reason: 'session-changed' });
                    return;
                }
                const layout = readLayout();
                if (layout.ok) {
                    // Require two consecutive valid frames to avoid first-frame flukes.
                    const w = layout.w;
                    const h = layout.h;
                    const confirm = function () {
                        if (settled) return;
                        if (!guard.isCurrent(session)) {
                            done({ ok: false, reason: 'session-changed' });
                            return;
                        }
                        const again = readLayout();
                        if (again.ok && again.w === w && again.h === h) {
                            done({ ok: true, w: w, h: h, waitedMs: Date.now() - startedAt });
                        } else if (Date.now() - startedAt >= limit) {
                            done({ ok: false, reason: 'timeout', fallback: true });
                        } else {
                            schedule(poll);
                        }
                    };
                    schedule(confirm);
                    return;
                }
                if (Date.now() - startedAt >= limit) {
                    // Sertakan dimensi fallback viewport agar boot tetap lanjut
                    // (setupChart/applyChartSize sudah tahu cara memakainya).
                    const fb = { ok: false, reason: layout.reason || 'timeout', fallback: true };
                    if (layout && layout.fallback) {
                        fb.fw = layout.fw;
                        fb.fh = layout.fh;
                        fb.vw = layout.vw;
                        fb.vh = layout.vh;
                    } else {
                        try {
                            const vw = (root && root.innerWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0) || 0;
                            const vh = (root && root.innerHeight) || (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
                            if (vw > 300 && vh > 300) {
                                fb.fw = Math.max(320, vw - (vw > 768 ? 360 : 0));
                                fb.fh = Math.max(420, Math.floor(vh * 0.62));
                            }
                        } catch (e) {}
                    }
                    done(fb);
                    return;
                }
                schedule(poll);
            }

            function schedule(fn) {
                if (typeof requestAnimationFrame === 'function') {
                    rafId = requestAnimationFrame(fn);
                } else {
                    setTimeout(fn, LAYOUT_POLL_FALLBACK_MS);
                }
            }

            try {
                const doc = getDoc();
                const RO = (root && root.ResizeObserver) || (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
                const target = doc ? doc.getElementById('chart-container') : null;
                if (RO && target && typeof target === 'object') {
                    observer = new RO(function () {
                        if (!settled) poll();
                    });
                    observer.observe(target);
                }
            } catch (e) { /* observer optional; polling covers it */ }

            schedule(poll);
        });
    }

    /**
     * Kode kegagalan spesifik untuk telemetri + pesan UI, supaya log server
     * langsung menyebut penyebabnya (LIB_MISSING_CDN_BLOCKED / NODES_MISSING /
     * SERIES_INCOMPLETE / CREATE_EXCEPTION:<pesan>) bukan kode generik.
     * Prefix CHART_CREATE_FAILED dipertahankan agar monitor lama tetap match.
     */
    function chartCreateFailureName() {
        let cause = null;
        try {
            const getter = root ? root.getLastChartCreateError : null;
            if (typeof getter === 'function') cause = getter();
            else if (typeof getLastChartCreateError === 'function') cause = getLastChartCreateError();
        } catch (e) { cause = null; }
        try {
            if (!cause && root && root.__MASAKO_CHART_CREATE_ERROR__) {
                cause = String(root.__MASAKO_CHART_CREATE_ERROR__).slice(0, 160);
            }
        } catch (e) { /* noop */ }
        if (!cause) {
            try {
                if (!root || typeof root.LightweightCharts === 'undefined') cause = 'LIB_MISSING_CDN_BLOCKED';
                else if (!root.LightweightCharts.createChart) cause = 'LIB_NO_CREATE_FN';
            } catch (e) { cause = 'UNKNOWN'; }
        }
        return 'CHART_CREATE_FAILED:' + (cause || 'UNKNOWN');
    }

    function isChartReady() {
        try {
            if (!root) return false;
            // NOTE: `chart`, `rsiChart` and `series` are top-level `let`
            // bindings in chartSetup.js: visible as bare identifiers across
            // classic scripts, but NOT as window properties. Probe both.
            const chartRef = root.chart || (typeof chart !== 'undefined' ? chart : null);
            const rsiRef = root.rsiChart || (typeof rsiChart !== 'undefined' ? rsiChart : null);
            const seriesRef = root.series || (typeof series !== 'undefined' ? series : null);
            return !!(chartRef && rsiRef && seriesRef && seriesRef.candle && seriesRef.vol && seriesRef.rsi);
        } catch (e) {
            return false;
        }
    }

    function ensureChart(session) {
        if (!guard.isCurrent(session)) return false;
        if (isChartReady()) {
            try {
                if (root && typeof root.applyChartSize === 'function') root.applyChartSize();
            } catch (e) { /* noop */ }
            return true;
        }
        try {
            const setup = root ? root.setupChart : null;
            if (typeof setup !== 'function' && typeof setupChart === 'function') {
                const created = setupChart();
                return created !== false && isChartReady();
            }
            if (typeof setup === 'function') {
                const created = setup();
                return created !== false && isChartReady();
            }
        } catch (e) {
            state.lastError = e;
        }
        return isChartReady();
    }

    function setLoading(active, message) {
        try {
            if (root && typeof root.setChartLoading === 'function') {
                root.setChartLoading(active, message);
            } else if (typeof setChartLoading === 'function') {
                setChartLoading(active, message);
            }
        } catch (e) { /* noop */ }
    }

    function showBootError(message) {
        setLoading(true, message);
        try {
            const doc = getDoc();
            const retry = doc ? doc.getElementById('chart-retry') : null;
            if (retry && retry.classList) retry.classList.remove('is-hidden');
        } catch (e) { /* noop */ }
        try {
            if (root && typeof root.showToast === 'function') root.showToast(message, true);
        } catch (e) { /* noop */ }
    }

    function hideBootError() {
        try {
            const doc = getDoc();
            const retry = doc ? doc.getElementById('chart-retry') : null;
            if (retry && retry.classList) retry.classList.add('is-hidden');
        } catch (e) { /* noop */ }
    }

    function historyLoader() {
        if (root && root.HistoryLoader) return root.HistoryLoader;
        try {
            if (typeof require === 'function') return require('./historyLoader');
        } catch (e) { /* browser: global only */ }
        return null;
    }

    /**
     * First historical page. De-duplication, endpoint fallback (Binance
     * Futures -> Spot) and pagination all live in HistoryLoader so the engine
     * and the chart share one implementation.
     */
    function fetchHistoricalCandles(pair, tf, session, signal) {
        const HL = historyLoader();
        if (!HL) return Promise.reject(new Error('HISTORY_LOADER_MISSING'));
        const hlSession = HL.begin(pair, tf);
        state.historySession = hlSession;
        return HL.loadInitial(pair, tf, hlSession, signal).then(function (candles) {
            if (!guard.isCurrent(session)) throw new Error('SESSION_CHANGED');
            return { data: candles, historySession: hlSession };
        }, function (err) {
            const name = err && err.message ? err.message : 'UNKNOWN';
            try {
                if (root && typeof root.markFeedHttpError === 'function') {
                    root.markFeedHttpError('Candle Binance tidak tersedia (Futures + Spot gagal).');
                }
            } catch (e) { /* noop */ }
            // Preserve the specific failure so the UI can explain it; anything
            // else is reported as a fetch failure. Per-source detail
            // (FAPI:...|SPOT:...|BYBIT:...) ikut dibawa untuk telemetri/UI.
            const keep = (name === 'SESSION_CHANGED' || name === 'ABORTED' || name === 'CANDLE_VALIDATION_FAILED')
                ? name : 'CANDLE_FETCH_FAILED';
            const wrapped = new Error(keep);
            if (keep === 'CANDLE_FETCH_FAILED') {
                let fetchDetail = null;
                try {
                    const HL = historyLoader();
                    if (HL && typeof HL.getLastFetchDetail === 'function') fetchDetail = HL.getLastFetchDetail();
                } catch (e) { fetchDetail = null; }
                wrapped.details = fetchDetail || name;
            } else {
                wrapped.details = name;
            }
            throw wrapped;
        });
    }

    function clearSlowTimer() {
        if (state.slowTimer) {
            try { clearTimeout(state.slowTimer); } catch (e) {}
            state.slowTimer = null;
        }
    }

    function abort(reason) {
        guard.invalidate();
        clearSlowTimer();
        try {
            if (state.abortController && typeof state.abortController.abort === 'function') {
                state.abortController.abort(reason || 'lifecycle-abort');
            }
        } catch (e) { /* noop */ }
        state.abortController = null;
        state.bootPromise = null;
    }

    function currentConfig() {
        const AppState = getAppState();
        const doc = getDoc();
        let pair = AppState ? AppState.g_pair : null;
        let tf = AppState ? AppState.g_tf : null;
        if ((!pair || !tf) && doc && typeof doc.getElementById === 'function') {
            try {
                const pairEl = doc.getElementById('pair');
                const tfEl = doc.getElementById('tf');
                if (!pair && pairEl) pair = pairEl.value;
                if (!tf && tfEl) tf = tfEl.value;
            } catch (e) { /* noop */ }
        }
        return { pair: pair || 'BTCUSDT', tf: tf || '15m' };
    }

    function applyCandlesToState(pair, tf, session, candles) {
        const AppState = getAppState();
        if (!AppState) return false;
        if (!guard.isCurrent(session)) return false;
        if (AppState.g_pair !== pair || AppState.g_tf !== tf) return false;
        AppState.candles = candles;
        if (candles.length > 0) {
            const last = candles[candles.length - 1];
            AppState.price = last.close;
            AppState.lastPrices[pair] = last.close;
            if (AppState.feed) AppState.feed.lastUpdate = Date.now();
        }
        return true;
    }

    function runIndicators(session) {
        if (!guard.isCurrent(session)) return false;
        try {
            const calc = root ? root.calculateAllIndicators : null;
            const fn = (typeof calc === 'function') ? calc : (typeof calculateAllIndicators === 'function' ? calculateAllIndicators : null);
            if (typeof fn === 'function') fn();
            return true;
        } catch (e) {
            state.lastError = e;
            return false;
        }
    }

    function renderAndFit(session) {
        if (!guard.isCurrent(session)) return false;
        try {
            const render = root ? root.renderFullChart : null;
            const fn = (typeof render === 'function') ? render : (typeof renderFullChart === 'function' ? renderFullChart : null);
            if (typeof fn !== 'function') return false;
            const rendered = fn();
            if (rendered === false) return false;
            if (!guard.isCurrent(session)) return false;
            // fitContent ONLY after candles are inside the series.
            const chartRef = root.chart || (typeof chart !== 'undefined' ? chart : null);
            if (chartRef && chartRef.timeScale) {
                try { chartRef.timeScale().fitContent(); } catch (e) { /* non-fatal */ }
            }
            return true;
        } catch (e) {
            state.lastError = e;
            return false;
        }
    }

    function connectRealtime(session) {
        if (!guard.isCurrent(session)) return false;
        try {
            const connect = root ? root.connectWebSocket : null;
            const fn = (typeof connect === 'function') ? connect : (typeof connectWebSocket === 'function' ? connectWebSocket : null);
            if (typeof fn === 'function') fn();
            return true;
        } catch (e) {
            state.lastError = e;
            return false;
        }
    }

    /**
     * Optional hook: the chart is on screen and live, so background work such
     * as widening the historical context can start now without racing the
     * first paint.
     */
    function notifyLive() {
        try {
            const fn = root ? root.onChartLive : null;
            if (typeof fn === 'function') {
                fn({ pair: currentConfig().pair, tf: currentConfig().tf, historySession: state.historySession });
            }
        } catch (e) { /* background enrichment must never break the chart */ }
    }

    function markFeedError(message) {
        try {
            if (root && typeof root.markFeedHttpError === 'function') root.markFeedHttpError(message);
        } catch (e) { /* noop */ }
    }

    function scheduleSlowRetry(session) {
        clearSlowTimer();
        state.slowTimer = setTimeout(function () {
            if (!guard.isCurrent(session)) return;
            boot({ reason: 'slow-retry' });
        }, slowRetryMs());
    }

    function bootOnce(session, pair, tf, signal) {
        const CV = getCV();
        emitLifecycleEvent(PHASES.WAITING_LAYOUT, { pair: pair, tf: tf });
        return waitForLayoutReady(session).then(function (layout) {
            if (!guard.isCurrent(session)) throw new Error('SESSION_CHANGED');
            if (!layout.ok && !layout.fallback) throw new Error('LAYOUT_UNAVAILABLE');
            emitLifecycleEvent(PHASES.CREATING, { pair: pair, tf: tf, layout: layout });
            const created = ensureChart(session);
            if (!created) {
                throw new Error(chartCreateFailureName());
            }
            const AppState = getAppState();
            if (AppState && typeof root.applyChartSize === 'function') {
                try { root.applyChartSize(); } catch (e) {}
            }
            emitLifecycleEvent(PHASES.FETCHING, { pair: pair, tf: tf });
            return fetchHistoricalCandles(pair, tf, session, signal);
        }).then(function (found) {
            if (!guard.isCurrent(session)) throw new Error('SESSION_CHANGED');
            if (!CV) throw new Error('VALIDATOR_MISSING');
            // Defence in depth: HistoryLoader already normalizes, but the chart
            // never trusts an upstream producer blindly.
            const validated = CV.validateAndNormalizeCandles(found.data);
            if (!validated.valid) {
                const err = new Error('CANDLE_VALIDATION_FAILED');
                err.details = validated;
                throw err;
            }
            emitLifecycleEvent(PHASES.RENDERING, {
                pair: pair, tf: tf, count: validated.count, dropped: validated.dropped
            });
            const applied = applyCandlesToState(pair, tf, session, validated.candles);
            if (!applied) throw new Error('SESSION_CHANGED');
            // Offline TP/SL hits must resolve against the fresh history before live ticks.
            try {
                const FE = (root && root.FuturesEngine) ||
                    (typeof FuturesEngine !== 'undefined' ? FuturesEngine : null);
                if (FE && typeof FE.checkOfflineHits === 'function') FE.checkOfflineHits();
            } catch (e) { /* non-fatal */ }
            runIndicators(session);
            // Exchange/orderflow snapshot is best-effort and must not block the chart.
            try {
                const EE = (root && root.ExchangeEngine) ||
                    (typeof ExchangeEngine !== 'undefined' ? ExchangeEngine : null);
                if (EE && typeof EE.fetchAll === 'function') {
                    EE.fetchAll().catch(function () { /* handled inside */ });
                }
            } catch (e) { /* non-fatal */ }
            const rendered = renderAndFit(session);
            if (!rendered) throw new Error('RENDER_FAILED');
            if (!guard.isCurrent(session)) throw new Error('SESSION_CHANGED');
            setLoading(false);
            hideBootError();
            emitLifecycleEvent(PHASES.LIVE, {
                pair: pair, tf: tf, count: validated.count, historySession: state.historySession
            });
            connectRealtime(session);
            notifyLive();
            return { ok: true, count: validated.count };
        });
    }

    function boot(options) {
        options = options || {};
        const AppState = getAppState();
        const cfg = currentConfig();
        const session = guard.next();
        state.session = session;
        clearSlowTimer();
        try {
            if (state.abortController && typeof state.abortController.abort === 'function') {
                state.abortController.abort('superseded');
            }
        } catch (e) { /* noop */ }

        const AC = (root && root.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : null);
        state.abortController = AC ? new AC() : null;
        const signal = state.abortController ? state.abortController.signal : null;

        if (AppState) {
            AppState.retryCount = 0;
        }
        state.retryCount = 0;
        setLoading(true, options.loadingMessage || 'Memuat chart...');
        hideBootError();
        emitLifecycleEvent(PHASES.WAITING_LAYOUT, { pair: cfg.pair, tf: cfg.tf, reason: options.reason || 'boot' });

        state.bootPromise = bootOnce(session, cfg.pair, cfg.tf, signal).then(
            function (result) {
                if (guard.isCurrent(session)) {
                    try {
                        if (root && typeof root.resetPairFetchFailure === 'function') root.resetPairFetchFailure(cfg.pair);
                    } catch (e) { /* noop */ }
                }
                return result;
            },
            function (err) {
                if (!guard.isCurrent(session)) return { ok: false, superseded: true };
                return handleBootError(session, cfg.pair, cfg.tf, err, signal);
            }
        );
        return state.bootPromise;
    }

    function handleBootError(session, pair, tf, err, signal) {
        const name = (err && err.message) ? err.message : 'UNKNOWN_BOOT_ERROR';
        if (name === 'SESSION_CHANGED' || name === 'ABORTED') {
            return { ok: false, superseded: true };
        }
        state.lastError = err;
        state.retryCount += 1;
        const AppState = getAppState();
        if (AppState) AppState.retryCount = state.retryCount;
        // Detail per-sumber (FAPI:...|SPOT:...|BYBIT:...) hanya masuk ke
        // pesan telemetri + teks UI; error code `name` tidak berubah supaya
        // monitor/test yang match kode tetap jalan.
        let fetchDetail = null;
        try {
            if (err && typeof err.details === 'string' && err.details && err.details !== name) {
                fetchDetail = err.details.slice(0, 120);
            }
        } catch (e) { fetchDetail = null; }
        try {
            if (root && typeof root.recordPairFetchFailure === 'function') {
                root.recordPairFetchFailure(pair, fetchDetail ? name + ':' + fetchDetail : name);
            }
        } catch (e) { /* noop */ }

        const delay = retryDelayMs(state.retryCount);
        const maxRetries = maxFastRetries();

        if (state.retryCount <= maxRetries) {
            setLoading(true, 'Koneksi gagal, retry ' + Math.round(delay / 1000) + 's... (' + state.retryCount + '/' + maxRetries + ')');
            markFeedError('Market data sementara tidak tersedia; mencoba ulang otomatis.');
            return new Promise(function (resolve) {
                setTimeout(function () {
                    if (!guard.isCurrent(session)) {
                        resolve({ ok: false, superseded: true });
                        return;
                    }
                    bootOnce(session, pair, tf, signal).then(
                        function (result) { resolve(result); },
                        function (retryErr) { resolve(handleBootError(session, pair, tf, retryErr, signal)); }
                    );
                }, delay);
            });
        }

        // Bounded fast retries exhausted: show a clear, non-stuck error state.
        // Keep a slow background poll (30s) + manual retry button.
        const friendly = friendlyErrorMessage(name, fetchDetail);
        emitLifecycleEvent(PHASES.ERROR, { pair: pair, tf: tf, error: name });
        markFeedError(friendly);
        showBootError(friendly + ' (auto-retry 30s)');
        scheduleSlowRetry(session);
        return { ok: false, error: name };
    }

    function friendlyErrorMessage(name, detail) {
        const key = String(name || '');
        const extra = String(detail || '');
        // Nama kegagalan create membawa penyebab setelah ':' (lihat chartCreateFailureName).
        if (key === 'CHART_CREATE_FAILED' || key.indexOf('CHART_CREATE_FAILED:') === 0) {
            const cause = key.indexOf(':') >= 0 ? key.slice(key.indexOf(':') + 1) : '';
            if (cause.indexOf('LIB_MISSING') === 0 || cause.indexOf('LIB_NO_CREATE') === 0) {
                return 'Library chart gagal dimuat (file lokal/CDN diblokir adblock/antivirus/DNS). Matikan adblock untuk situs ini lalu tekan Coba Lagi.';
            }
            if (cause.indexOf('CREATE_EXCEPTION') === 0) {
                return 'Render chart gagal (' + cause.slice(0, 100) + '). Coba lagi; bila berulang, kirim pesan ini ke developer.';
            }
            return 'Library chart gagal dimuat.';
        }
        switch (key) {
            case 'CANDLE_FETCH_FAILED': {
                if (/GEO_451|HTTP_451|restricted/i.test(extra)) {
                    return 'Binance dibatasi di wilayah/jaringan ini (HTTP 451). Fallback Bybit dicoba otomatis; bila tetap gagal, coba jaringan lain/VPN lalu Coba Lagi.';
                }
                if (/DNS_BLOCKED|ENOTFOUND/i.test(extra)) {
                    return 'Domain exchange diblokir (adblock/antivirus/DNS). Whitelist binance.com + bybit.com lalu Coba Lagi.';
                }
                if (extra) return 'Candle tidak tersedia (' + extra.slice(0, 80) + '). Mencoba ulang otomatis.';
                return 'Candle Binance tidak tersedia (Futures + Spot gagal).';
            }
            case 'CANDLE_VALIDATION_FAILED':
                return 'Data candle tidak valid dari exchange.';
            case 'LAYOUT_UNAVAILABLE':
                return 'Layout chart belum siap.';
            case 'RENDER_FAILED':
                return 'Render chart gagal; mencoba ulang.';
            default:
                return 'Market data sementara tidak tersedia.';
        }
    }

    function retryNow() {
        const AppState = getAppState();
        if (AppState) AppState.retryCount = 0;
        state.retryCount = 0;
        return boot({ reason: 'manual-retry', loadingMessage: 'Memuat ulang chart...' });
    }

    function getState() {
        return {
            phase: state.phase,
            session: state.session,
            retryCount: state.retryCount,
            lastError: state.lastError ? String(state.lastError && state.lastError.message ? state.lastError.message : state.lastError) : null
        };
    }

    // Manual retry button (wired lazily; index.html owns the markup).
    try {
        const doc = getDoc();
        if (doc && typeof doc.addEventListener === 'function') {
            doc.addEventListener('click', function (ev) {
                try {
                    if (ev && ev.target && ev.target.id === 'chart-retry') retryNow();
                } catch (e) { /* noop */ }
            });
        }
    } catch (e) { /* node: no document */ }

    return {
        PHASES: PHASES,
        LAYOUT_TIMEOUT_MS: LAYOUT_TIMEOUT_MS,
        FETCH_TIMEOUT_MS: FETCH_TIMEOUT_MS,
        MAX_FAST_RETRIES: MAX_FAST_RETRIES,
        SLOW_RETRY_MS: SLOW_RETRY_MS,
        boot: boot,
        retryNow: retryNow,
        abort: abort,
        onPhase: onPhase,
        getState: getState,
        getHistorySession: function () { return state.historySession; },
        waitForLayoutReady: waitForLayoutReady,
        isChartReady: isChartReady,
        currentConfig: currentConfig,
        // exposed for tests
        _guard: guard,
        _readLayout: readLayout,
        _chartCreateFailureName: chartCreateFailureName,
        _setTestTiming: function (override) { state.timingOverride = override || null; }
    };
});
