/* deepHistory.js — WIDE multi-timeframe history corpus.
 *
 * The animal brains are not limited to the candles currently rendered on the
 * chart. This module is the "wide eyes" of the neural layer: it pulls several
 * thousand closed candles per timeframe (1m / 5m / 15m / 1h / 4h / 1d) from the
 * public Binance kline endpoint, so pattern work can span months of daily
 * structure and weeks of intraday structure instead of a single screen.
 *
 * Design rules (mirrors the rest of the codebase):
 *   - NO network work on load: fetching only happens when explicitly asked.
 *   - Every request has a timeout, is abortable, and failures degrade to a
 *     partial corpus instead of throwing into the chart boot path.
 *   - Requests are queued (bounded concurrency) so a cold page load never
 *     floods the exchange with a burst of 12 parallel calls.
 *   - Result is cached per pair with a TTL; repeated calls reuse the cache.
 *   - The LAST (still-forming) candle of every timeframe is dropped so no
 *     downstream pattern analysis can look into the future.
 *
 * Classic script: window.DeepHistory in browsers, module.exports in Node.
 */
(function DeepHistoryUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.DeepHistory = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildDeepHistory(root) {
    'use strict';

    const API_BASE = 'https://api.binance.com/api/v3/klines';
    // Mirror anti-blokir (shape identik, CORS *): dicoba bila API_BASE mati
    // (DNS-hijack/geoblock). Array agar mudah ditambah tanpa ubah pemanggil.
    const API_MIRRORS = ['https://data-api.binance.vision/api/v3/klines'];
    const PAGE_LIMIT = 1000;
    const REQUEST_TIMEOUT_MS = 9000;
    const CACHE_TTL_MS = 10 * 60 * 1000;   // reuse a corpus for 10 minutes
    const MAX_CONCURRENCY = 2;             // gentle on the public endpoint
    const MAX_TOTAL_CANDLES = 12000;       // hard ceiling on memory
    const MAX_CACHE_ENTRIES = 3;

    const INTERVAL_MS = {
        '1m': 60 * 1000,
        '5m': 5 * 60 * 1000,
        '15m': 15 * 60 * 1000,
        '30m': 30 * 60 * 1000,
        '1h': 60 * 60 * 1000,
        '2h': 2 * 60 * 60 * 1000,
        '4h': 4 * 60 * 60 * 1000,
        '6h': 6 * 60 * 60 * 1000,
        '8h': 8 * 60 * 60 * 1000,
        '12h': 12 * 60 * 60 * 1000,
        '1d': 24 * 60 * 60 * 1000,
        '3d': 3 * 24 * 60 * 60 * 1000,
        '1w': 7 * 24 * 60 * 60 * 1000,
        '1M': 30 * 24 * 60 * 60 * 1000,
        '1y': 365 * 24 * 60 * 60 * 1000
    };

    // Depth plan: 1d ~2.7y, 4h ~166d, 1h ~125d, 15m ~20d, 5m ~3.5d, 1m ~17h.
    // `deep: true` doubles the intraday span without touching the 1m feed.
    const PLAN = Object.freeze([
        { tf: '1d', pages: 1, label: '1 hari' },
        { tf: '4h', pages: 1, label: '4 jam' },
        { tf: '1h', pages: 3, label: '1 jam' },
        { tf: '15m', pages: 2, label: '15 menit' },
        { tf: '5m', pages: 1, label: '5 menit' },
        { tf: '1m', pages: 1, label: '1 menit' }
    ]);

    const DEEP_PLAN = Object.freeze([
        { tf: '1d', pages: 2, label: '1 hari' },
        { tf: '4h', pages: 2, label: '4 jam' },
        { tf: '1h', pages: 5, label: '1 jam' },
        { tf: '15m', pages: 4, label: '15 menit' },
        { tf: '5m', pages: 2, label: '5 menit' },
        { tf: '1m', pages: 1, label: '1 menit' }
    ]);

    const S = {
        cache: {},          // pair -> { corpus, at }
        inflight: {},       // pair -> Promise (dedupes concurrent calls)
        aborters: {},       // pair -> AbortController
        lastError: null
    };

    function nowMs() { return Date.now(); }

    function fetchImpl(explicit) {
        if (typeof explicit === 'function') return explicit;
        if (root && typeof root.fetch === 'function') return root.fetch.bind(root);
        if (typeof fetch === 'function') return fetch;
        return null;
    }

    function toNum(value, fallback) {
        const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        return Number.isFinite(n) ? n : fallback;
    }

    /** Binance kline row -> project candle shape (seconds timestamps). */
    function parseRow(row) {
        if (!Array.isArray(row) || row.length < 6) return null;
        const timeMs = toNum(row[0], NaN);
        if (!Number.isFinite(timeMs)) return null;
        const open = toNum(row[1], NaN);
        const high = toNum(row[2], NaN);
        const low = toNum(row[3], NaN);
        const close = toNum(row[4], NaN);
        const vol = toNum(row[5], 0);
        const closeTimeRaw = toNum(row[6], NaN);
        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
        if (!(close > 0)) return null;
        const closeTimeMs = Number.isFinite(closeTimeRaw) && closeTimeRaw > 0
            ? closeTimeRaw
            : timeMs + 1;
        return {
            time: Math.floor(timeMs / 1000),
            open: open,
            high: high,
            low: low,
            close: close,
            vol: vol,
            takerVol: toNum(row[9], vol * 0.5),
            closeTime: Math.floor(closeTimeMs / 1000)
        };
    }

    /**
     * Drop rows that are duplicated, unusable, or still forming.
     *
     * Pages arrive newest-first while the rows inside a page are ascending, so
     * the merge is sorted before de-duplicating: order in the response is never
     * trusted.
     */
    function normalizeCandles(rows, tf, clockMs) {
        const intervalMs = INTERVAL_MS[tf] || 0;
        const cutoff = (Number.isFinite(clockMs) ? clockMs : nowMs()) / 1000;
        const parsed = [];
        for (let i = 0; i < rows.length; i++) {
            const c = parseRow(rows[i]);
            if (!c) continue;
            // A candle whose close time has not passed yet is still forming:
            // its outcome is unknown, so pattern work must never see it.
            if (intervalMs > 0 && c.closeTime >= cutoff) continue;
            parsed.push(c);
        }
        parsed.sort(function (a, b) { return a.time - b.time; });
        const out = [];
        let lastTime = -Infinity;
        for (let i = 0; i < parsed.length; i++) {
            if (parsed[i].time === lastTime) continue;
            lastTime = parsed[i].time;
            out.push(parsed[i]);
        }
        return out;
    }

    function normalizePair(pair) {
        const p = String(pair || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        return p || 'BTCUSDT';
    }

    function buildUrl(base, pair, tf, endTimeMs) {
        let url = base + '?symbol=' + encodeURIComponent(pair) + '&interval=' + encodeURIComponent(tf) +
            '&limit=' + PAGE_LIMIT;
        if (Number.isFinite(endTimeMs) && endTimeMs > 0) {
            url += '&endTime=' + Math.floor(endTimeMs);
        }
        return url;
    }

    function attemptUrl(doFetch, url, options, controller) {
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : REQUEST_TIMEOUT_MS;
        let timer = null;
        const timeout = new Promise(function (_resolve, reject) {
            timer = setTimeout(function () {
                if (controller) { try { controller.abort(); } catch (e) { /* noop */ } }
                reject(new Error('timeout'));
            }, timeoutMs);
        });
        const request = doFetch(url, controller ? { signal: controller.signal } : undefined)
            .then(function (res) {
                if (res && res.ok === false) throw new Error('http-' + (res.status || 0));
                return typeof res.json === 'function' ? res.json() : res;
            })
            .then(function (body) {
                return Array.isArray(body) ? body : [];
            });
        return Promise.race([request, timeout]).then(function (rows) {
            if (timer) clearTimeout(timer);
            return rows;
        }, function (err) {
            if (timer) clearTimeout(timer);
            throw err;
        });
    }

    function requestPage(pair, tf, endTimeMs, options) {
        const doFetch = fetchImpl(options.fetchImpl);
        if (!doFetch) return Promise.reject(new Error('fetch-unavailable'));
        if (options.signal && options.signal.aborted) return Promise.reject(new Error('aborted'));
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const bases = [API_BASE].concat(API_MIRRORS);
        let chain = Promise.reject(new Error('no-base'));
        bases.forEach(function (base) {
            chain = chain.catch(function () {
                if (options.signal && options.signal.aborted) throw new Error('aborted');
                return attemptUrl(doFetch, buildUrl(base, pair, tf, endTimeMs), options, controller);
            });
        });
        return chain;
    }

    function fetchTimeframe(pair, entry, options) {
        const tf = entry.tf;
        const pages = Math.max(1, Math.min(6, entry.pages || 1));
        const collected = [];
        let endTimeMs = Number.isFinite(options.untilMs) ? options.untilMs : undefined;
        let requests = 0;
        let partial = false;
        let errorMessage = null;

        function nextPage(pageIndex) {
            if (pageIndex >= pages) return Promise.resolve();
            if (options.signal && options.signal.aborted) return Promise.resolve();
            return requestPage(pair, tf, endTimeMs, options).then(function (rows) {
                requests++;
                if (rows.length === 0) return;
                const oldest = toNum(Array.isArray(rows[0]) ? rows[0][0] : NaN, NaN);
                for (let i = 0; i < rows.length; i++) collected.push(rows[i]);
                if (!Number.isFinite(oldest)) return;
                endTimeMs = oldest - 1;
                if (rows.length < PAGE_LIMIT) return;
                return nextPage(pageIndex + 1);
            }).catch(function (err) {
                partial = true;
                errorMessage = err && err.message ? err.message : String(err);
                S.lastError = errorMessage;
            });
        }

        return nextPage(0).then(function () {
            const candles = normalizeCandles(collected, tf, options.clockMs);
            return {
                tf: tf,
                label: entry.label,
                candles: candles,
                requests: requests,
                partial: partial,
                errorMessage: errorMessage
            };
        });
    }

    /** Bounded-concurrency queue so we never fire 12 requests at once. */
    function runQueue(tasks, limit) {
        const results = new Array(tasks.length);
        let cursor = 0;
        const width = Math.max(1, Math.min(limit || MAX_CONCURRENCY, tasks.length || 1));

        function worker() {
            const index = cursor++;
            if (index >= tasks.length) return Promise.resolve();
            return Promise.resolve()
                .then(tasks[index])
                .then(function (value) { results[index] = value; })
                .catch(function (err) {
                    results[index] = { error: err && err.message ? err.message : String(err) };
                })
                .then(worker);
        }

        const workers = [];
        for (let i = 0; i < width; i++) workers.push(worker());
        return Promise.all(workers).then(function () { return results; });
    }

    function pruneCache() {
        const keys = Object.keys(S.cache);
        if (keys.length <= MAX_CACHE_ENTRIES) return;
        const sorted = keys.map(function (k) { return { k: k, at: S.cache[k].at }; })
            .sort(function (a, b) { return a.at - b.at; });
        while (sorted.length > MAX_CACHE_ENTRIES) {
            const drop = sorted.shift();
            delete S.cache[drop.k];
        }
    }

    function describe(corpus) {
        if (!corpus || !corpus.series) return 'Data pola: belum dimuat';
        const parts = [];
        let total = 0;
        PLAN.forEach(function (entry) {
            const arr = corpus.series[entry.tf];
            if (Array.isArray(arr) && arr.length > 0) {
                parts.push(entry.tf + ' × ' + arr.length);
                total += arr.length;
            }
        });
        return total > 0
            ? ('Data pola: ' + parts.join(' · ') + ' candle (total ' + total + ')')
            : 'Data pola: belum dimuat';
    }

    /**
     * Fetch (or reuse) the wide corpus for a pair.
     * options: { deep, fetchImpl, timeoutMs, signal, clockMs, untilMs, force }
     */
    function fetchCorpus(pair, options) {
        const opts = options || {};
        const symbol = normalizePair(pair);
        const clock = Number.isFinite(opts.clockMs) ? opts.clockMs : nowMs();
        const cached = S.cache[symbol];
        if (!opts.force && cached && (clock - cached.at) < CACHE_TTL_MS) {
            return Promise.resolve(cached.corpus);
        }
        if (S.inflight[symbol]) return S.inflight[symbol];

        const plan = opts.deep ? DEEP_PLAN : PLAN;
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        S.aborters[symbol] = controller;
        const requestOptions = {
            deep: !!opts.deep,
            fetchImpl: opts.fetchImpl,
            timeoutMs: opts.timeoutMs,
            signal: opts.signal || (controller ? controller.signal : undefined),
            clockMs: clock,
            untilMs: opts.untilMs
        };

        const tasks = plan.map(function (entry) {
            return function () { return fetchTimeframe(symbol, entry, requestOptions); };
        });

        const promise = runQueue(tasks, MAX_CONCURRENCY).then(function (results) {
            const series = {};
            const meta = [];
            let total = 0;
            let partial = false;
            let requests = 0;
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const planEntry = plan[i];
                if (!result || result.error) {
                    partial = true;
                    meta.push({ tf: planEntry.tf, label: planEntry.label, candles: 0, requests: 0, error: result ? result.error : 'unknown' });
                    continue;
                }
                const candles = result.candles.length > MAX_TOTAL_CANDLES
                    ? result.candles.slice(result.candles.length - MAX_TOTAL_CANDLES)
                    : result.candles;
                series[planEntry.tf] = candles;
                total += candles.length;
                requests += result.requests;
                if (result.partial) partial = true;
                meta.push({
                    tf: planEntry.tf,
                    label: planEntry.label,
                    candles: candles.length,
                    requests: result.requests,
                    error: result.errorMessage || null
                });
            }

            const corpus = {
                ok: total > 0,
                pair: symbol,
                fetchedAt: clock,
                deep: !!opts.deep,
                series: series,
                frames: meta,
                totals: { candles: total, requests: requests },
                partial: partial
            };
            S.cache[symbol] = { corpus: corpus, at: clock };
            pruneCache();
            delete S.aborters[symbol];
            delete S.inflight[symbol];
            return corpus;
        }).catch(function (err) {
            delete S.aborters[symbol];
            delete S.inflight[symbol];
            S.lastError = err && err.message ? err.message : String(err);
            return { ok: false, pair: symbol, fetchedAt: clock, series: {}, frames: [], totals: { candles: 0, requests: 0 }, partial: true, error: S.lastError };
        });

        S.inflight[symbol] = promise;
        return promise;
    }

    function getCached(pair) {
        const cached = S.cache[normalizePair(pair)];
        return cached ? cached.corpus : null;
    }

    function isFresh(pair, clockMs) {
        const cached = S.cache[normalizePair(pair)];
        if (!cached) return false;
        const clock = Number.isFinite(clockMs) ? clockMs : nowMs();
        return (clock - cached.at) < CACHE_TTL_MS;
    }

    function abort(pair) {
        const key = pair ? normalizePair(pair) : null;
        const keys = key ? [key] : Object.keys(S.aborters);
        keys.forEach(function (k) {
            const controller = S.aborters[k];
            if (controller) { try { controller.abort(); } catch (e) { /* noop */ } }
            delete S.aborters[k];
            delete S.inflight[k];
        });
    }

    function clearCache() {
        S.cache = {};
        S.inflight = {};
    }

    return {
        INTERVAL_MS: INTERVAL_MS,
        PLAN: PLAN,
        DEEP_PLAN: DEEP_PLAN,
        PAGE_LIMIT: PAGE_LIMIT,
        CACHE_TTL_MS: CACHE_TTL_MS,
        parseRow: parseRow,
        normalizeCandles: normalizeCandles,
        describe: describe,
        fetchCorpus: fetchCorpus,
        getCached: getCached,
        isFresh: isFresh,
        abort: abort,
        clearCache: clearCache,
        lastError: function () { return S.lastError; }
    };
});
