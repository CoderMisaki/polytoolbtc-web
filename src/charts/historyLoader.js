/* historyLoader.js — paginated historical candle loading.
 *
 * The engine gets a WIDE context while the chart only renders a window:
 *
 *   exchange  ->  HistoryLoader (paginated, de-duplicated, chronological)
 *             ->  AppState.candles        (engine history, up to MAX_CANDLES)
 *             ->  chart window slice      (what the chart series actually holds)
 *
 * Rules implemented here:
 *   - pagination via `endTime`, so there is no artificial single-request cap;
 *   - every page is de-duplicated by candle time and merged chronologically;
 *   - a session token makes a slow page from a previous pair/timeframe unable
 *     to touch the current state;
 *   - pages are fetched progressively and the loader yields to the browser
 *     between them, so the chart stays responsive while context is filled in;
 *   - loading stops when the exchange runs out of data or MAX_CANDLES is hit.
 *
 * UMD: window.HistoryLoader in browsers, module.exports in Node.
 */
(function HistoryLoaderUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.HistoryLoader = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildHistoryLoader(root) {
    'use strict';

    // Binance caps a single /klines request at 1500 rows.
    const PAGE_SIZE = 1500;
    // Engine context. Chosen so ONE full indicator rebuild stays ~0.6s and the
    // retained indicator arrays stay in the tens of MB, not hundreds.
    const MAX_CANDLES = 5000;
    // Rows fetched on the very first (blocking) request.
    const INITIAL_PAGE = 1000;
    const FETCH_TIMEOUT_MS = 10000;
    const MAX_PAGES_PER_RUN = 12;
    const YIELD_MS = 0;
    // Bybit public kline (no key, CORS-open): fallback ketiga bila KEDUA
    // endpoint Binance gagal (adblock/DNS/geoblock 451 di jaringan user).
    // Interval Bybit dalam menit; format list: [startMs,o,h,l,c,vol,turnover].
    // Bybit tidak punya 8h/3d/1y — untuk tf itu kunci tidak ada dan fallback
    // Bybit dilewati (rantai sumber Binance/VISION yang menjawab).
    const BYBIT_INTERVAL = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M' };
    const TF_STEP_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '8h': 28800000, '12h': 43200000, '1d': 86400000, '3d': 259200000, '1w': 604800000, '1M': 2592000000 };

    const S = {
        pair: null,
        tf: null,
        session: 0,
        loading: false,
        hasMore: true,
        pages: 0,
        rowsLoaded: 0,
        lastError: null,
        oldestTime: null,
        lastFetchDetail: null
    };

    /** Baris klines shape-Binance (dipakai FAPI, SPOT, dan mirror VISION). */
    function binanceRows(data) {
        if (Array.isArray(data) && data.length > 0) return data;
        return null;
    }

    function endpoints(pair, tf, limit, endTime) {
        // 1y tidak didukung exchange mana pun: tarik candle bulanan (1M) lalu
        // agregasi ke tahunan setelah normalize (loadInitial/loadOlder).
        // Pagination tetap benar: candle tahunan tertua mulai 1 Jan, jadi
        // endTime halaman berikut (= 1 Jan - 1 mdtk) tepat memotong di
        // Desember tahun sebelumnya tanpa duplikat maupun gap.
        const fetchTf = tf === '1y' ? '1M' : tf;
        const tail = '&limit=' + limit + (Number.isFinite(endTime) ? '&endTime=' + endTime : '');
        const list = [
            {
                // Same-origin proxy (api/klines.js): kebal terhadap DNS-hijack
                // ISP, adblock/antivirus, dan geo-block 451 di jaringan user —
                // browser hanya bicara ke domain app sendiri. Dicoba PERTAMA
                // supaya jaringan yang memblokir semua host exchange langsung
                // dapat data tanpa menunggu 4x timeout (±40 dtk) yang terasa
                // seperti "stuck di loading".
                name: 'PROXY',
                url: '/api/klines?symbol=' + pair + '&interval=' + fetchTf + tail,
                parse: function (data) {
                    const rows = data && data.ok && Array.isArray(data.rows) ? data.rows : null;
                    return binanceRows(rows);
                }
            },
            {
                name: 'FAPI',
                url: 'https://fapi.binance.com/fapi/v1/klines?symbol=' + pair + '&interval=' + fetchTf + tail,
                parse: binanceRows
            },
            {
                name: 'SPOT',
                url: 'https://api.binance.com/api/v3/klines?symbol=' + pair + '&interval=' + fetchTf + tail,
                parse: binanceRows
            },
            {
                // Mirror data publik Binance (CORS *, tanpa geoblock 451):
                // satu-satunya host yang lolos DNS-hijack di jaringan yang
                // memblokir *.binance.com / *.bybit.com (terbukti di lapangan).
                name: 'VISION',
                url: 'https://data-api.binance.vision/api/v3/klines?symbol=' + pair + '&interval=' + fetchTf + tail,
                parse: binanceRows
            }
        ];
        // Bybit linear perpetual sebagai fallback terakhir (shape dipetakan ke
        // format baris Binance supaya normalizeRows tidak berubah).
        const bybitInterval = BYBIT_INTERVAL[tf];
        if (bybitInterval) {
            const step = TF_STEP_MS[tf] || 900000;
            let bybitUrl = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=' + pair
                + '&interval=' + bybitInterval + '&limit=' + Math.min(limit, 1000);
            if (Number.isFinite(endTime)) bybitUrl += '&end=' + endTime;
            list.push({
                name: 'BYBIT',
                url: bybitUrl,
                parse: function (data) {
                    const rows = data && data.result && Array.isArray(data.result.list) ? data.result.list : null;
                    if (!rows || rows.length === 0) return null;
                    if (data.retCode !== 0 && data.retCode !== '0') return null;
                    const out = [];
                    for (let i = 0; i < rows.length; i++) {
                        const e = rows[i];
                        if (!Array.isArray(e) || e.length < 7) continue;
                        const startMs = Number(e[0]);
                        if (!Number.isFinite(startMs) || startMs <= 0) continue;
                        out.push([startMs, String(e[1]), String(e[2]), String(e[3]), String(e[4]),
                            String(e[5]), startMs + step - 1, String(e[6] || '0'), '0', '0', '0', '0']);
                    }
                    if (out.length === 0) return null;
                    // Bybit mengembalikan newest-first; normalizer butuh ascending.
                    out.sort(function (a, b) { return a[0] - b[0]; });
                    return out;
                }
            });
        }
        return list;
    }

    /** Tag pendek kegagalan terakhir per sumber, untuk telemetri (tanpa URL/key). */
    function shortTag(name, err) {
        const raw = err && (err.message || err.details || err) ? String(err.message || err.details || err) : 'UNKNOWN';
        const m = /HTTP_(\d+)|HTTP (\d+)/.exec(raw);
        if (m) return name + ':HTTP_' + (m[1] || m[2]);
        if (/abort|timeout|timed out/i.test(raw)) return name + ':TIMEOUT';
        if (/ENOTFOUND|EAI_AGAIN|NXDOMAIN|getaddrinfo/i.test(raw)) return name + ':DNS_BLOCKED';
        if (/451|restricted location|restricted/i.test(raw)) return name + ':GEO_451';
        if (/EMPTY_RESPONSE/i.test(raw)) return name + ':EMPTY';
        return (name + ':ERR_' + raw.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 24)).slice(0, 40);
    }

    function getLastFetchDetail() {
        return S.lastFetchDetail || null;
    }

    function fetchWithAbort(url, timeoutMs, signal) {
        const impl = root ? root.fetchWithTimeout : null;
        if (typeof impl === 'function') return impl(url, {}, timeoutMs, signal);
        if (typeof fetch !== 'function') return Promise.reject(new Error('FETCH_UNAVAILABLE'));
        const AC = (root && root.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : null);
        const local = AC ? new AC() : null;
        const timer = setTimeout(function () { if (local) { try { local.abort(); } catch (e) { /* noop */ } } }, timeoutMs);
        return fetch(url, local ? { signal: local.signal } : undefined).then(
            function (res) { clearTimeout(timer); return res; },
            function (err) { clearTimeout(timer); throw err; }
        );
    }

    /** Raw Binance kline rows -> normalized candle objects. */
    function normalizeRows(rows) {
        const out = [];
        if (!Array.isArray(rows)) return out;
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            if (!Array.isArray(r) || r.length < 10) continue;
            const time = Math.floor(Number(r[0]) / 1000);
            const open = Number(r[1]);
            const high = Number(r[2]);
            const low = Number(r[3]);
            const close = Number(r[4]);
            const vol = Number(r[5]);
            const takerVol = Number(r[9]);
            if (!Number.isFinite(time) || time <= 0) continue;
            if (!Number.isFinite(open) || !Number.isFinite(high) ||
                !Number.isFinite(low) || !Number.isFinite(close)) continue;
            if (!(close > 0) || !(high > 0) || !(low > 0)) continue;
            out.push({
                time: time,
                open: open,
                high: high,
                low: low,
                close: close,
                vol: Number.isFinite(vol) ? vol : 0,
                takerVol: Number.isFinite(takerVol) ? takerVol : 0
            });
        }
        return out;
    }

    /**
     * Agregasi candle bulanan -> tahunan (bucket = tahun kalender UTC).
     * Aturan: open = open bulan pertama, high = max, low = min,
     * close = close bulan terakhir, vol/takerVol = jumlah. Input harus
     * ascending (dijamin normalizeRows + sort pengaman di sini).
     * Dipakai untuk tf '1y' yang tidak dimiliki exchange mana pun.
     */
    function aggregateYearly(candles) {
        if (!Array.isArray(candles) || candles.length === 0) return [];
        const sorted = candles.slice().sort(function (a, b) { return a.time - b.time; });
        const out = [];
        let cur = null;
        for (let i = 0; i < sorted.length; i++) {
            const c = sorted[i];
            const year = new Date(c.time * 1000).getUTCFullYear();
            if (!cur || cur.year !== year) {
                cur = {
                    year: year,
                    time: Math.floor(Date.UTC(year, 0, 1) / 1000),
                    open: c.open, high: c.high, low: c.low, close: c.close,
                    vol: c.vol || 0, takerVol: c.takerVol || 0
                };
                out.push(cur);
            } else {
                cur.high = Math.max(cur.high, c.high);
                cur.low = Math.min(cur.low, c.low);
                cur.close = c.close;
                cur.vol += c.vol || 0;
                cur.takerVol += c.takerVol || 0;
            }
        }
        return out.map(function (y) {
            return { time: y.time, open: y.open, high: y.high, low: y.low, close: y.close, vol: y.vol, takerVol: y.takerVol };
        });
    }

    /**
     * Varian baris-shape-Binance dari aggregateYearly (dipakai jalur legacy
     * main.js dan poller marketFeed.js): [openTime,o,h,l,c,vol,closeTime,
     * quoteVol,trades,takerBase,takerQuote,ignore]. Baris di-sort ascending
     * dulu supaya open/close tahunan benar apa pun urutan sumbernya.
     */
    function aggregateYearlyRows(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return [];
        const sorted = rows.slice().sort(function (a, b) { return Number(a[0]) - Number(b[0]); });
        const byYear = new Map();
        for (let i = 0; i < sorted.length; i++) {
            const r = sorted[i];
            if (!Array.isArray(r) || r.length < 8) continue;
            const startMs = Number(r[0]);
            if (!Number.isFinite(startMs) || startMs <= 0) continue;
            const open = Number(r[1]), high = Number(r[2]), low = Number(r[3]), close = Number(r[4]);
            if (![open, high, low, close].every(Number.isFinite)) continue;
            const year = new Date(startMs).getUTCFullYear();
            const cur = byYear.get(year);
            if (!cur) {
                byYear.set(year, {
                    startMs: Date.UTC(year, 0, 1), open: open, high: high, low: low, close: close,
                    vol: Number(r[5]) || 0, endMs: Number(r[6]) || startMs, quoteVol: Number(r[7]) || 0
                });
            } else {
                cur.high = Math.max(cur.high, high);
                cur.low = Math.min(cur.low, low);
                cur.close = close;
                cur.vol += Number(r[5]) || 0;
                cur.quoteVol += Number(r[7]) || 0;
                cur.endMs = Number(r[6]) || cur.endMs;
            }
        }
        return Array.from(byYear.values()).sort(function (a, b) { return a.startMs - b.startMs; })
            .map(function (y) {
                return [y.startMs, String(y.open), String(y.high), String(y.low), String(y.close),
                    String(y.vol), y.endMs, String(y.quoteVol), '0', '0', '0', '0'];
            });
    }

    /**
     * Merge `incoming` into `existing` keeping chronological order and no
     * duplicate times. Returns { candles, added } where `candles` is a NEW
     * array (callers may keep the old reference safely).
     */
    function mergeCandles(existing, incoming) {
        const base = Array.isArray(existing) ? existing : [];
        const add = Array.isArray(incoming) ? incoming : [];
        if (add.length === 0) return { candles: base, added: 0 };

        const seen = new Set();
        for (let i = 0; i < base.length; i++) seen.add(base[i].time);

        const merged = base.slice();
        let added = 0;
        // Older pages go to the front; keep them ordered among themselves.
        const older = [];
        const newer = [];
        const oldestExisting = base.length > 0 ? base[0].time : Infinity;
        for (let i = 0; i < add.length; i++) {
            const c = add[i];
            if (seen.has(c.time)) continue;
            seen.add(c.time);
            if (c.time < oldestExisting) older.push(c);
            else newer.push(c);
            added++;
        }
        older.sort(function (a, b) { return a.time - b.time; });
        newer.sort(function (a, b) { return a.time - b.time; });

        const out = older.concat(merged, newer);
        // One final safety pass: strictly increasing times.
        for (let i = 1; i < out.length; i++) {
            if (out[i].time <= out[i - 1].time) {
                out.splice(i, 1);
                i--;
                added = Math.max(0, added - 1);
            }
        }
        return { candles: out, added: added };
    }

    function trimToMax(candles) {
        if (candles.length <= MAX_CANDLES) return { candles: candles, dropped: 0 };
        const dropped = candles.length - MAX_CANDLES;
        return { candles: candles.slice(dropped), dropped: dropped };
    }

    function fetchPage(pair, tf, limit, endTime, signal) {
        const sources = endpoints(pair, tf, limit, endTime);
        const tags = [];
        let chain = Promise.resolve(null);
        sources.forEach(function (source) {
            chain = chain.then(function (found) {
                if (found) return found;
                return fetchWithAbort(source.url, FETCH_TIMEOUT_MS, signal).then(function (res) {
                    if (!res || res.ok === false) throw new Error('HTTP_' + (res ? res.status : 'NO_RESPONSE'));
                    return res.json();
                }).then(function (data) {
                    const parsed = source.parse(data);
                    if (parsed && parsed.length > 0) return { source: source.name, rows: parsed };
                    throw new Error('EMPTY_RESPONSE');
                }).catch(function (err) {
                    tags.push(shortTag(source.name, err));
                    return null;
                });
            });
        });
        return chain.then(function (found) {
            if (found) {
                S.lastFetchDetail = null;
                return found.rows;
            }
            // Semua sumber gagal: simpan ringkasan sebab untuk telemetri/UI.
            S.lastFetchDetail = tags.join('|').slice(0, 160) || 'ALL_SOURCES_FAILED';
            return null;
        });
    }

    function yieldToBrowser() {
        return new Promise(function (resolve) {
            const ric = (root && root.requestIdleCallback) || (typeof requestIdleCallback === 'function' ? requestIdleCallback : null);
            if (ric) {
                ric(function () { resolve(); }, { timeout: 200 });
                return;
            }
            setTimeout(resolve, YIELD_MS);
        });
    }

    /** Start (or re-target) a loading session. Returns the new session token. */
    function begin(pair, tf) {
        S.session += 1;
        S.pair = pair;
        S.tf = tf;
        S.loading = false;
        S.hasMore = true;
        S.pages = 0;
        S.rowsLoaded = 0;
        S.lastError = null;
        S.oldestTime = null;
        S.lastFetchDetail = null;
        return S.session;
    }

    function isCurrent(session) {
        return session === S.session;
    }

    /**
     * First (blocking) page. Returns normalized candles or throws.
     */
    async function loadInitial(pair, tf, session, signal) {
        const raw = await fetchPage(pair, tf, INITIAL_PAGE, null, signal);
        if (!isCurrent(session)) throw new Error('SESSION_CHANGED');
        if (!raw) throw new Error('CANDLE_FETCH_FAILED');
        const candles = tf === '1y' ? aggregateYearly(normalizeRows(raw)) : normalizeRows(raw);
        if (candles.length === 0) throw new Error('CANDLE_VALIDATION_FAILED');
        S.pages = 1;
        S.rowsLoaded = candles.length;
        S.oldestTime = candles[0].time;
        // Keputusan hasMore memakai hitungan baris mentah: untuk 1y,
        // candles sudah diagregasi (jauh lebih sedikit) dan tidak boleh
        // dipakai sebagai sinyal "exchange kehabisan data".
        if (raw.length < INITIAL_PAGE) S.hasMore = false;
        return candles;
    }

    /**
     * Fetch older pages until `target` candles are held (or the exchange runs
     * out). Yields between pages so the UI thread is never starved.
     *
     * onBatch(mergedCandles, meta) is called after every page so the caller can
     * refresh the engine/chart without waiting for the whole run.
     */
    async function loadOlder(getCurrentCandles, onBatch, options) {
        const opts = options || {};
        const session = Number.isFinite(opts.session) ? opts.session : S.session;
        const pair = opts.pair || S.pair;
        const tf = opts.tf || S.tf;
        const target = Number.isFinite(opts.target) ? Math.min(opts.target, MAX_CANDLES) : MAX_CANDLES;
        const signal = opts.signal || null;

        if (S.loading) return { ok: false, reason: 'ALREADY_LOADING' };
        if (!pair || !tf) return { ok: false, reason: 'NO_CONFIG' };
        if (!S.hasMore) return { ok: false, reason: 'EXHAUSTED' };

        S.loading = true;
        let lastMerged = null;
        try {
            for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
                if (!isCurrent(session)) return { ok: false, reason: 'SESSION_CHANGED' };
                const current = getCurrentCandles() || [];
                if (current.length >= target) { S.hasMore = false; break; }
                const oldest = current.length > 0 ? current[0].time : null;
                if (oldest === null) break;

                const raw = await fetchPage(pair, tf, PAGE_SIZE, oldest * 1000 - 1, signal);
                if (!isCurrent(session)) return { ok: false, reason: 'SESSION_CHANGED' };

                if (!raw || raw.length === 0) { S.hasMore = false; break; }

                const incoming = tf === '1y' ? aggregateYearly(normalizeRows(raw)) : normalizeRows(raw);
                const mergedAll = mergeCandles(current, incoming);
                if (mergedAll.added === 0) { S.hasMore = false; break; }

                const trimmed = trimToMax(mergedAll.candles);
                lastMerged = trimmed.candles;
                S.pages += 1;
                S.rowsLoaded = trimmed.candles.length;
                S.oldestTime = trimmed.candles[0].time;
                if (raw.length < PAGE_SIZE) S.hasMore = false;

                if (typeof onBatch === 'function') {
                    try {
                        onBatch(trimmed.candles, {
                            added: mergedAll.added,
                            dropped: trimmed.dropped,
                            total: trimmed.candles.length,
                            hasMore: S.hasMore,
                            pages: S.pages
                        });
                    } catch (e) { /* caller handles its own errors */ }
                }

                if (!S.hasMore || trimmed.candles.length >= target) break;
                await yieldToBrowser();
            }
            return {
                ok: true,
                total: S.rowsLoaded,
                hasMore: S.hasMore,
                pages: S.pages,
                candles: lastMerged
            };
        } catch (err) {
            S.lastError = err && err.message ? err.message : String(err);
            if (S.lastError === 'ABORTED' || S.lastError === 'SESSION_CHANGED') {
                return { ok: false, reason: S.lastError };
            }
            return { ok: false, reason: S.lastError };
        } finally {
            S.loading = false;
        }
    }

    function getState() {
        return {
            pair: S.pair,
            tf: S.tf,
            session: S.session,
            loading: S.loading,
            hasMore: S.hasMore,
            pages: S.pages,
            rowsLoaded: S.rowsLoaded,
            oldestTime: S.oldestTime,
            lastError: S.lastError,
            maxCandles: MAX_CANDLES
        };
    }

    return {
        PAGE_SIZE: PAGE_SIZE,
        MAX_CANDLES: MAX_CANDLES,
        INITIAL_PAGE: INITIAL_PAGE,
        begin: begin,
        isCurrent: isCurrent,
        loadInitial: loadInitial,
        loadOlder: loadOlder,
        normalizeRows: normalizeRows,
        aggregateYearly: aggregateYearly,
        aggregateYearlyRows: aggregateYearlyRows,
        mergeCandles: mergeCandles,
        trimToMax: trimToMax,
        getState: getState,
        getLastFetchDetail: getLastFetchDetail,
        abort: function () { S.session += 1; S.loading = false; }
    };
});
