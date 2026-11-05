/* src/engines/walletTracker.js — Klien browser untuk fitur Wallet Tracker (Smart Money).
 *
 * Semua data berat (leaderboard 39MB, ranking, window math) dikerjakan oleh
 * /api/hl-wallet di server. Modul ini: fetch + cache lokal + format tampilan.
 * Pure helpers diekspor juga untuk node --test.
 */
(function () {
    'use strict';

    var API_BASE = '/api/hl-wallet';
    var MEM_CACHE = new Map(); // key -> {at, ttl, value}
    var LS_PREFIX = 'masako_wt_';

    var WINDOW_LABELS = {
        '7d': '7 Hari',
        '14d': '14 Hari',
        '1m': '1 Bulan',
        '3m': '3 Bulan',
        '6m': '6 Bulan'
    };
    var WINDOW_ORDER = ['7d', '14d', '1m', '3m', '6m'];

    function memGet(key, ttlMs) {
        var e = MEM_CACHE.get(key);
        if (!e) return null;
        if (Date.now() - e.at > ttlMs) { MEM_CACHE.delete(key); return null; }
        return e.value;
    }
    function memSet(key, value, ttlMs) {
        MEM_CACHE.set(key, { at: Date.now(), value: value });
        if (MEM_CACHE.size > 200) MEM_CACHE.delete(MEM_CACHE.keys().next().value);
    }

    function lsGet(key) {
        try {
            var raw = localStorage.getItem(LS_PREFIX + key);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (!o || (Date.now() - o.at) > o.ttl) return null;
            return o.value;
        } catch (_) { return null; }
    }
    function lsSet(key, value, ttlMs) {
        try { localStorage.setItem(LS_PREFIX + key, JSON.stringify({ at: Date.now(), ttl: ttlMs, value: value })); }
        catch (_) { /* storage penuh / privat: abaikan */ }
    }

    // Parser query minimal untuk fallback (tanpa URLSearchParams agar
    // konsisten dengan gaya ES5 file ini).
    function parseFallbackQuery(url) {
        var q = String(url || '').split('?')[1] || '';
        var params = {};
        q.split('&').forEach(function (pair) {
            if (!pair) return;
            var eq = pair.indexOf('=');
            var k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
            var v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : '';
            params[k] = v;
        });
        if (!params.action) return null;
        return { action: params.action, params: params };
    }

    async function fetchJson(url, timeoutMs) {
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
        var originalErr = null;
        try {
            var res = await fetch(url, { signal: ctrl.signal });
            var body = null;
            try { body = await res.json(); } catch (_) { /* non-JSON */ }
            if (!res.ok) {
                var msg = (body && (body.error || body.detail)) || ('HTTP ' + res.status);
                throw new Error(msg);
            }
            if (!body || body.ok !== true) throw new Error((body && body.error) || 'Respons API tidak valid');
            return body.data;
        } catch (e) {
            originalErr = e;
        } finally { clearTimeout(t); }
        // Fallback 2026-11-05: backend /api tidak ada di host statis
        // (GitHub Pages) sehingga fetch di atas 404 — hitung langsung dari
        // upstream Hyperliquid publik via WalletTrackerFallback. Di Vercel
        // blok ini tidak pernah tersentuh (/api selalu ada). Bila fallback
        // ikut gagal, error asli tetap yang dilempar (jujur, bukan
        // disamarkan).
        //
        // Jalur cepat 2026-11-05 (GitHub Pages, sebelum live fallback):
        // snapshot precomputed untuk aksi berat (recommend semua window,
        // leaderboard default) yang diperbarui tiap 10 menit oleh GitHub
        // Actions — satu JSON kecil dari origin yang sama, tanpa unduhan
        // stats 40MB dari HP (itu yang bikin tracker stuck loading di 4G).
        try {
            var parsedSnap = parseFallbackQuery(url);
            var snapUrl = null;
            if (parsedSnap) {
                var p = parsedSnap.params;
                if (parsedSnap.action === 'recommend' && p.window) {
                    snapUrl = 'data/tracker-recommend-' + p.window + '.json';
                } else if (parsedSnap.action === 'leaderboard' && p.window) {
                    var sortBy = p.sortBy || 'score';
                    var limit = p.limit || '50';
                    var noFilter = !p.minEquity && !p.maxEquity && !p.minWinRate;
                    if (sortBy === 'score' && limit === '50' && noFilter) {
                        snapUrl = 'data/tracker-leaderboard-' + p.window + '.json';
                    }
                }
            }
            if (snapUrl) {
                var snapRes = await fetch(snapUrl, { cache: 'no-store', headers: { 'Accept': 'application/json' } });
                if (snapRes.ok) {
                    var snap = await snapRes.json();
                    // Snapshot kosong (0 wallet — mis. builder gagal
                    // enrichment) TIDAK dipakai; jatuh ke live fallback
                    // supaya tab tidak tampil kosong padahal ada datanya.
                    if (snap && Array.isArray(snap.wallets) && snap.wallets.length > 0) return snap;
                }
            }
        } catch (_) { /* jatuh ke live fallback di bawah */ }
        try {
            var fb = (typeof window !== 'undefined' && window.WalletTrackerFallback) || null;
            var parsed = parseFallbackQuery(url);
            if (fb && typeof fb.request === 'function' && parsed) {
                return await fb.request(parsed.action, parsed.params);
            }
        } catch (_) { /* jatuh ke error asli di bawah */ }
        throw originalErr;
    }

    async function getRecommendations(windowKey) {
        windowKey = WINDOW_LABELS[windowKey] ? windowKey : '7d';
        var key = 'reco:' + windowKey;
        var hit = memGet(key, 5 * 60 * 1000) || lsGet(key);
        if (hit) { memSet(key, hit); return hit; }
        var data = await fetchJson(API_BASE + '?action=recommend&window=' + encodeURIComponent(windowKey), 60000);
        memSet(key, data); lsSet(key, data, 5 * 60 * 1000);
        return data;
    }

    async function getWalletDetail(address) {
        address = String(address || '').trim();
        var key = 'wallet:' + address.toLowerCase();
        var hit = memGet(key, 45 * 1000);
        if (hit) return hit;
        var data = await fetchJson(API_BASE + '?action=wallet&address=' + encodeURIComponent(address), 30000);
        memSet(key, data);
        return data;
    }

    async function getFills(address) {
        address = String(address || '').trim();
        var key = 'fills:' + address.toLowerCase();
        var hit = memGet(key, 20 * 1000);
        if (hit) return hit;
        var data = await fetchJson(API_BASE + '?action=fills&address=' + encodeURIComponent(address), 30000);
        memSet(key, data);
        return data;
    }

    async function getMids() {
        var hit = memGet('mids', 30 * 1000);
        if (hit) return hit;
        var data = await fetchJson(API_BASE + '?action=mids', 15000);
        memSet('mids', data);
        return data;
    }

    async function getLeaderboard(windowKey, opts) {
        windowKey = WINDOW_LABELS[windowKey] ? windowKey : '7d';
        opts = opts || {};
        var qs = 'action=leaderboard&window=' + encodeURIComponent(windowKey);
        if (opts.limit) qs += '&limit=' + encodeURIComponent(opts.limit);
        if (opts.minEquity) qs += '&minEquity=' + encodeURIComponent(opts.minEquity);
        if (opts.maxEquity) qs += '&maxEquity=' + encodeURIComponent(opts.maxEquity);
        if (opts.minWinRate) qs += '&minWinRate=' + encodeURIComponent(opts.minWinRate);
        if (opts.sortBy) qs += '&sortBy=' + encodeURIComponent(opts.sortBy);
        var key = 'lb:' + windowKey + ':' + qs;
        var hit = memGet(key, 5 * 60 * 1000);
        if (hit) return hit;
        var data = await fetchJson(API_BASE + '?' + qs, 60000);
        memSet(key, data, 5 * 60 * 1000);
        return data;
    }

    // Ambil candles mini (200 candle terakhir) untuk preview entry chart.
    // Primer: Binance. Fallback: Hyperliquid candleSnapshot — SEMUA koin perps
    // Hyperliquid pasti tersedia di sini, jadi tidak perlu hardcode daftar koin.
    async function fetchMiniCandles(pair, tf) {
        pair = String(pair || '').toUpperCase();
        tf = tf || '15m';
        var key = 'klines:' + pair + ':' + tf;
        var hit = memGet(key, 30 * 1000);
        if (hit) return hit;
        var urls = [
            'https://fapi.binance.com/fapi/v1/klines?symbol=' + encodeURIComponent(pair) + '&interval=' + tf + '&limit=200',
            'https://data-api.binance.vision/api/v3/klines?symbol=' + encodeURIComponent(pair) + '&interval=' + tf + '&limit=200',
            'https://api.binance.com/api/v3/klines?symbol=' + encodeURIComponent(pair) + '&interval=' + tf + '&limit=200'
        ];
        var lastErr = null;
        var symbolNotFound = false; // Binance 400/404 = simbol memang tidak listing
        for (var i = 0; i < urls.length; i++) {
            var ctrl = new AbortController();
            var t = setTimeout(function () { ctrl.abort(); }, 10000);
            try {
                var res = await fetch(urls[i], { signal: ctrl.signal });
                clearTimeout(t);
                if (!res.ok) {
                    if (res.status === 400 || res.status === 404) symbolNotFound = true;
                    lastErr = 'HTTP ' + res.status; continue;
                }
                var raw = await res.json();
                if (!Array.isArray(raw) || raw.length === 0) { lastErr = 'empty'; continue; }
                var out = [];
                for (var j = 0; j < raw.length; j++) {
                    var r = raw[j];
                    if (!Array.isArray(r) || r.length < 6) continue;
                    out.push({
                        time: Math.floor(Number(r[0]) / 1000),
                        open: Number(r[1]), high: Number(r[2]),
                        low: Number(r[3]), close: Number(r[4])
                    });
                }
                memSet(key, out, 30 * 1000);
                return out;
            } catch (e) {
                clearTimeout(t);
                lastErr = e.message || 'fetch error';
            }
        }
        // Binance gagal (mis. 400: simbol belum listing) -> coba Hyperliquid.
        var hlErr = null;
        try {
            var hl = await fetchHyperliquidCandles(pair, tf);
            memSet(key, hl, 30 * 1000);
            return hl;
        } catch (e) { hlErr = e; }
        // Simbol memang tidak ada di mana-mana -> pesan ramah, bukan "HTTP 400".
        if (symbolNotFound) {
            var coinName = String(pair || '').toUpperCase().replace(/USDT$/, '').replace(/USD$/, '') || pair;
            throw new Error('Koin ' + coinName + ' tidak tersedia di Binance maupun Hyperliquid');
        }
        throw new Error('Gagal memuat candles: ' + ((hlErr && hlErr.message) || lastErr));
    }

    // Candles dari Hyperliquid (public, tanpa API key). Format interval HL:
    // '15m' | '1h' | '1d' — sama dengan yang dipakai UI.
    async function fetchHyperliquidCandles(pair, tf) {
        var coin = String(pair || '').toUpperCase().replace(/USDT$/, '').replace(/USD$/, '');
        if (!coin) throw new Error('simbol kosong');
        var msPer = tf === '1d' ? 86400000 : tf === '1h' ? 3600000 : 900000;
        var endTime = Date.now();
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, 12000);
        try {
            var res = await fetch('https://api.hyperliquid.xyz/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'candleSnapshot',
                    req: { coin: coin, interval: tf, startTime: endTime - 200 * msPer, endTime: endTime }
                }),
                signal: ctrl.signal
            });
            clearTimeout(t);
            if (!res.ok) throw new Error('Hyperliquid HTTP ' + res.status);
            var raw = await res.json();
            if (!Array.isArray(raw) || raw.length === 0) {
                throw new Error('koin ' + coin + ' tidak ditemukan di Binance maupun Hyperliquid');
            }
            var out = [];
            for (var i = 0; i < raw.length; i++) {
                var r = raw[i] || {};
                var ts = Math.floor(Number(r.t || r.T || 0) / 1000);
                if (!ts) continue;
                out.push({
                    time: ts,
                    open: Number(r.o), high: Number(r.h),
                    low: Number(r.l), close: Number(r.c)
                });
            }
            if (!out.length) throw new Error('koin ' + coin + ' tidak ditemukan di Binance maupun Hyperliquid');
            return out;
        } catch (e) {
            clearTimeout(t);
            throw e;
        }
    }

    /* ---------- format helpers (id-ID) ---------- */
    function fmtUsd(v, digits) {
        var n = Number(v);
        if (!Number.isFinite(n)) return '—';
        var d = (digits === undefined) ? 2 : digits;
        var sign = n < 0 ? '-' : '';
        var abs = Math.abs(n);
        var str;
        if (abs >= 1e9) str = (abs / 1e9).toFixed(2) + 'B';
        else if (abs >= 1e6) str = (abs / 1e6).toFixed(2) + 'M';
        else if (abs >= 1e3) str = (abs / 1e3).toFixed(2) + 'K';
        else str = abs.toFixed(d);
        return sign + '$' + str;
    }

    function fmtPct(v, digits) {
        var n = Number(v);
        if (!Number.isFinite(n)) return '—';
        var d = (digits === undefined) ? 2 : digits;
        return (n >= 0 ? '+' : '') + (n * 100).toFixed(d) + '%';
    }

    function fmtTime(ts) {
        var n = Number(ts);
        if (!n) return '—';
        try {
            return new Date(n).toLocaleString('id-ID', {
                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
            });
        } catch (_) { return '—'; }
    }

    function fmtAgo(ts) {
        var n = Number(ts);
        if (!n) return '—';
        var s = Math.max(0, Math.floor((Date.now() - n) / 1000));
        if (s < 60) return s + ' dtk lalu';
        var m = Math.floor(s / 60);
        if (m < 60) return m + ' mnt lalu';
        var h = Math.floor(m / 60);
        if (h < 24) return h + ' jam lalu';
        var d = Math.floor(h / 24);
        return d + ' hari lalu';
    }

    function shortAddr(a) {
        a = String(a || '');
        return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
    }

    function isValidAddress(a) {
        return /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());
    }

    // "BTC" -> "BTCUSDT" (pair terminal). Koin non-USDT perp di-skip oleh copy engine.
    function coinToPair(coin) {
        coin = String(coin || '').toUpperCase().trim();
        if (!coin || /[^A-Z0-9]/.test(coin)) return null;
        if (coin === 'USDC' || coin === 'USDT') return null;
        return coin + 'USDT';
    }

    var WalletTracker = {
        getRecommendations: getRecommendations,
        getWalletDetail: getWalletDetail,
        getFills: getFills,
        getMids: getMids,
        getLeaderboard: getLeaderboard,
        fetchMiniCandles: fetchMiniCandles,
        WINDOW_LABELS: WINDOW_LABELS,
        WINDOW_ORDER: WINDOW_ORDER,
        fmtUsd: fmtUsd,
        fmtPct: fmtPct,
        fmtTime: fmtTime,
        fmtAgo: fmtAgo,
        shortAddr: shortAddr,
        isValidAddress: isValidAddress,
        coinToPair: coinToPair,
        clearCache: function () { MEM_CACHE.clear(); }
    };

    if (typeof window !== 'undefined') window.WalletTracker = WalletTracker;
    if (typeof module !== 'undefined' && module.exports) module.exports = WalletTracker;
})();
