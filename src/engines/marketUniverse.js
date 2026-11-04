// marketUniverse.js
// Universe coin untuk mode LOCAL ARBITRAGE.
//
// Tidak ada satu pun daftar coin yang di-hardcode di sini. Setiap refresh
// mengambil daftar market futures USDT *live* dari Binance, OKX, dan Bybit,
// lalu menyusun universe lewat dynamic intersection:
//
//   1. Kandidat  : Top N (default 200) coin berdasarkan volume futures 24 jam
//                  (quote volume USDT), diambil dari gabungan ketiga venue.
//   2. Venue     : coin harus benar-benar terdaftar sebagai USDT perpetual di
//                  KETIGA exchange (Binance ∩ OKX ∩ Bybit) pada saat refresh.
//   3. Mapping   : symbol mapping harus benar — base coin sama DAN harga per
//                  1 unit coin antar venue selisih <= PRICE_TOLERANCE. Ini
//                  yang menangkap kasus `1000SHIBUSDT` (Binance/Bybit) vs
//                  `SHIB-USDT-SWAP` (OKX) sekaligus menolak mapping ngawur.
//   4. Data      : harga DAN funding rate harus tersedia di ketiga venue.
//   5. Liquidity : volume 24 jam TERKECIL di antara tiga venue >= minTurnover
//                  dan spread bid/ask terlebar <= maxSpreadBps, supaya spread
//                  & slippage tidak menciptakan arbitrage palsu.
//
// Hasilnya di-refresh berkala (default 5 menit) sehingga coin otomatis
// bertambah/hilang mengikuti ketersediaan market di exchange. Setiap tahap
// funnel dihitung dan diekspos lewat getReport() supaya mudah diverifikasi.
//
// Classic script: window.MarketUniverse di browser, module.exports di Node.

window.MarketUniverse = (function () {
    'use strict';

    // ------------------------------------------------------------ konfigurasi
    const UNIVERSE_MAX_DEFAULT = 200;   // Top N by volume futures 24h
    const UNIVERSE_MIN_LIMIT = 5;
    const UNIVERSE_MAX_LIMIT = 500;
    const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    const REQUEST_TIMEOUT_MS = 10000;
    const MIN_TURNOVER_DEFAULT = 5_000_000;    // USDT, per venue (dipakai nilai terkecil)
    const MAX_SPREAD_BPS_DEFAULT = 50;         // 0.50% — book terlalu lebar = false arbitrage
    const PRICE_TOLERANCE = 0.02;              // 2% toleransi harga antar venue
    // Dampak harga: 10% dari rasio (ukuran posisi / volume 24 jam venue terkecil).
    const IMPACT_FACTOR = 10;
    const VENUES = ['Binance', 'OKX', 'Bybit'];

    const URLS = {
        binanceTickers: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
        binanceFunding: 'https://fapi.binance.com/fapi/v1/premiumIndex',
        binanceBook: 'https://fapi.binance.com/fapi/v1/ticker/bookTicker',
        binanceSpot: 'https://api.binance.com/api/v3/ticker/price',
        bybitTickers: 'https://api.bybit.com/v5/market/tickers?category=linear',
        okxTickers: 'https://www.okx.com/api/v5/market/tickers?instType=SWAP',
        okxFunding: 'https://www.okx.com/api/v5/public/funding-rate?instId=ANY'
    };

    const STORAGE_KEYS = {
        minTurnover: 'masako_arb_universe_min_vol_v1',
        universeMax: 'masako_arb_universe_top_v1',
        maxSpreadBps: 'masako_arb_universe_max_spread_v1'
    };

    // ------------------------------------------------------------------ state
    let universeMax = readStoredNumber(STORAGE_KEYS.universeMax, UNIVERSE_MAX_DEFAULT, UNIVERSE_MIN_LIMIT, UNIVERSE_MAX_LIMIT);
    let minTurnover = readStoredNumber(STORAGE_KEYS.minTurnover, MIN_TURNOVER_DEFAULT, 0, 1e12);
    let maxSpreadBps = readStoredNumber(STORAGE_KEYS.maxSpreadBps, MAX_SPREAD_BPS_DEFAULT, 1, 5000);

    let refreshTimer = null;
    let refreshing = false;
    let phase = 'idle';        // idle | refreshing | ready | error
    let lastError = null;
    let updatedAt = 0;
    let started = false;

    /** Map base coin -> entry. Diisi ulang penuh setiap refresh. */
    let entries = new Map();
    /** Semua market mentah per venue (bukan hanya universe) dari refresh terakhir. */
    let rawMarkets = { Binance: new Map(), OKX: new Map(), Bybit: new Map() };
    let venueStatus = { Binance: 'idle', OKX: 'idle', Bybit: 'idle', BinanceSpot: 'idle' };
    let venueErrors = { Binance: null, OKX: null, Bybit: null, BinanceSpot: null };
    let counts = emptyCounts();
    const listeners = new Set();

    // ---------------------------------------------------------------- helpers

    function readStoredNumber(key, fallback, min, max) {
        try {
            if (typeof safeLoad !== 'function') return fallback;
            const value = Number(safeLoad(key, fallback));
            if (!Number.isFinite(value)) return fallback;
            return Math.min(max, Math.max(min, value));
        } catch (e) {
            return fallback;
        }
    }

    function persist(key, value) {
        try {
            if (typeof safeStore === 'function') safeStore(key, value);
        } catch (e) { /* localStorage penuh/diblokir: nilai tetap dipakai sesi ini */ }
    }

    function num(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function positive(value) {
        const parsed = num(value);
        return parsed !== null && parsed > 0 ? parsed : null;
    }

    /** Hanya USDT perpetual murni: buang kontrak bertanggal, inverse, non-USDT. */
    function isUsdtPerpetualSymbol(rawSymbol) {
        const s = String(rawSymbol || '').toUpperCase();
        if (!s || s.includes('-') || s.includes('_')) return false;
        return /^[A-Z0-9]{2,20}USDT$/.test(s);
    }

    /**
     * Pisahkan prefiks pengali desimal dari ticker.
     * `1000SHIB` -> { base: 'SHIB', multiplier: 1000 }; `1INCH` tidak disentuh
     * karena pengali yang diakui hanya 10^3 ke atas.
     */
    function splitMultiplier(rawBase) {
        const match = /^(10{3,9})([A-Z0-9]+)$/.exec(String(rawBase || '').toUpperCase());
        if (!match) return { base: String(rawBase || '').toUpperCase(), multiplier: 1 };
        return { base: match[2], multiplier: Number(match[1]) };
    }

    /** Base coin dari symbol exchange (BTCUSDT / 1000SHIBUSDT / BTC-USDT-SWAP). */
    function canonicalBase(rawSymbol, exchange) {
        const s = String(rawSymbol || '').toUpperCase();
        const rawBase = exchange === 'OKX'
            ? s.replace('-USDT-SWAP', '').replace('-USDT', '')
            : s.replace(/USDT$/, '');
        return splitMultiplier(rawBase).base;
    }

    function emptyCounts() {
        return {
            binanceMarkets: 0,
            okxMarkets: 0,
            bybitMarkets: 0,
            candidates: 0,
            topUniverse: 0,
            inAllVenues: 0,
            withPrice: 0,
            withFunding: 0,
            symbolAligned: 0,
            liquid: 0,
            spotChart: 0,
            rejected: {
                missingVenue: 0,
                noPrice: 0,
                noFunding: 0,
                symbolMismatch: 0,
                lowLiquidity: 0,
                wideSpread: 0
            }
        };
    }

    async function fetchJson(url, label) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
        try {
            const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
            if (!res || !res.ok) throw new Error(`${label}: HTTP ${res ? res.status : 'tanpa respons'}`);
            return await res.json();
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** fetchJson yang tidak pernah melempar; dipakai untuk endpoint opsional. */
    async function safeJson(url, label) {
        try {
            return { ok: true, data: await fetchJson(url, label) };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    function emit() {
        listeners.forEach((fn) => {
            try { fn(getSnapshot()); } catch (e) { /* subscriber rusak tidak boleh mematikan universe */ }
        });
    }

    // --------------------------------------------------------- venue loaders

    /**
     * Binance USDT-M futures: volume + harga (ticker/24hr), funding
     * (premiumIndex), spread (bookTicker), dan ketersediaan symbol spot
     * (ticker/price) supaya pair selector tetap punya chart.
     */
    async function loadBinance() {
        const [tickers, funding, book, spot] = await Promise.all([
            safeJson(URLS.binanceTickers, 'binance-ticker24hr'),
            safeJson(URLS.binanceFunding, 'binance-premiumIndex'),
            safeJson(URLS.binanceBook, 'binance-bookTicker'),
            safeJson(URLS.binanceSpot, 'binance-spot-ticker')
        ]);
        if (!tickers.ok) throw new Error(tickers.error);

        const markets = new Map();
        (Array.isArray(tickers.data) ? tickers.data : []).forEach((row) => {
            if (!row || !isUsdtPerpetualSymbol(row.symbol)) return;
            const split = splitMultiplier(String(row.symbol).toUpperCase().replace(/USDT$/, ''));
            const turnover = positive(row.quoteVolume);
            const price = positive(row.lastPrice);
            if (turnover === null) return;
            const entry = {
                symbol: String(row.symbol).toUpperCase(),
                multiplier: split.multiplier,
                price,
                // Harga per 1 unit coin: `1000SHIBUSDT` dihargai per 1000 SHIB.
                unitPrice: price !== null ? price / split.multiplier : null,
                turnover
            };
            // Bila satu coin punya dua listing (mis. SHIBUSDT & 1000SHIBUSDT),
            // pakai yang paling likuid supaya mapping-nya deterministik.
            const existing = markets.get(split.base);
            if (!existing || turnover > existing.turnover) markets.set(split.base, entry);
        });
        if (markets.size === 0) throw new Error('binance: tidak ada market USDT perpetual');

        if (funding.ok && Array.isArray(funding.data)) {
            funding.data.forEach((row) => {
                if (!row || !isUsdtPerpetualSymbol(row.symbol)) return;
                const entry = markets.get(canonicalBase(row.symbol, 'Binance'));
                if (!entry) return;
                const rate = num(row.lastFundingRate);
                if (rate !== null) entry.funding = rate;
                const mark = positive(row.markPrice);
                if (mark !== null) entry.unitPrice = mark / entry.multiplier;
            });
        }
        if (book.ok && Array.isArray(book.data)) {
            book.data.forEach((row) => {
                if (!row || !isUsdtPerpetualSymbol(row.symbol)) return;
                const entry = markets.get(canonicalBase(row.symbol, 'Binance'));
                if (!entry) return;
                entry.spreadBps = spreadBps(row.bidPrice, row.askPrice);
            });
        }

        const spotSymbols = new Set();
        if (spot.ok && Array.isArray(spot.data)) {
            spot.data.forEach((row) => {
                if (row && typeof row.symbol === 'string') spotSymbols.add(row.symbol.toUpperCase());
            });
            venueStatus.BinanceSpot = spotSymbols.size > 0 ? 'live' : 'error';
            if (spotSymbols.size === 0) venueErrors.BinanceSpot = 'daftar symbol spot kosong';
        } else {
            venueStatus.BinanceSpot = 'error';
            venueErrors.BinanceSpot = spot.error || 'tidak terjangkau';
        }

        return { markets, spotSymbols, fundingLive: funding.ok, error: funding.ok ? null : funding.error };
    }

    function spreadBps(bidRaw, askRaw) {
        const bid = positive(bidRaw);
        const ask = positive(askRaw);
        if (bid === null || ask === null || ask <= bid) return null;
        const mid = (bid + ask) / 2;
        if (!(mid > 0)) return null;
        return ((ask - bid) / mid) * 10000;
    }

    /** Bybit linear USDT perpetual: harga, funding, turnover, OI, dan book. */
    async function loadBybit() {
        const raw = await fetchJson(URLS.bybitTickers, 'bybit-tickers');
        const list = raw && raw.result && Array.isArray(raw.result.list) ? raw.result.list : [];
        const markets = new Map();
        list.forEach((row) => {
            if (!row || !isUsdtPerpetualSymbol(row.symbol)) return;
            const split = splitMultiplier(String(row.symbol).toUpperCase().replace(/USDT$/, ''));
            const turnover = positive(row.turnover24h);
            const price = positive(row.lastPrice);
            markets.set(split.base, {
                symbol: String(row.symbol).toUpperCase(),
                multiplier: split.multiplier,
                price,
                unitPrice: price !== null ? price / split.multiplier : null,
                turnover: turnover === null ? 0 : turnover,
                funding: num(row.fundingRate),
                openInterestUsd: positive(row.openInterestValue),
                spreadBps: spreadBps(row.bid1Price, row.ask1Price)
            });
        });
        if (markets.size === 0) throw new Error('bybit: tidak ada market linear USDT');
        return { markets };
    }

    /**
     * OKX USDT swap: harga & volume (market/tickers) plus funding untuk semua
     * instrument dalam satu request (funding-rate?instId=ANY).
     * Turnover USDT = last * volCcy24h (volCcy24h sudah dalam base currency).
     */
    async function loadOkx() {
        const [tickers, funding] = await Promise.all([
            safeJson(URLS.okxTickers, 'okx-tickers'),
            safeJson(URLS.okxFunding, 'okx-funding')
        ]);
        if (!tickers.ok) throw new Error(tickers.error);
        const rows = tickers.data && Array.isArray(tickers.data.data) ? tickers.data.data : [];
        if (tickers.data && tickers.data.code && tickers.data.code !== '0') {
            throw new Error(`okx: ${tickers.data.msg || `kode ${tickers.data.code}`}`);
        }
        const markets = new Map();
        rows.forEach((row) => {
            if (!row || typeof row.instId !== 'string') return;
            const instId = row.instId.toUpperCase();
            if (!instId.endsWith('-USDT-SWAP')) return;
            const base = canonicalBase(instId, 'OKX');
            if (!base) return;
            const price = positive(row.last);
            const volBase = positive(row.volCcy24h);
            markets.set(base, {
                symbol: instId,
                multiplier: 1,
                price,
                // OKX mengutip harga per 1 base currency, bukan per kontrak.
                unitPrice: price,
                turnover: price !== null && volBase !== null ? price * volBase : 0,
                spreadBps: spreadBps(row.bidPx, row.askPx)
            });
        });
        if (markets.size === 0) throw new Error('okx: tidak ada swap USDT');

        if (funding.ok && funding.data && Array.isArray(funding.data.data)) {
            funding.data.data.forEach((row) => {
                if (!row || typeof row.instId !== 'string') return;
                const instId = row.instId.toUpperCase();
                if (!instId.endsWith('-USDT-SWAP')) return;
                const entry = markets.get(canonicalBase(instId, 'OKX'));
                if (!entry) return;
                const rate = num(row.fundingRate);
                if (rate !== null) entry.funding = rate;
            });
        }
        return { markets, fundingLive: funding.ok, error: funding.ok ? null : funding.error };
    }

    // ------------------------------------------------------- intersection

    /**
     * Susun universe dari data ketiga venue. Semua keputusan (dan alasan
     * penolakan) dicatat ke `counts` supaya bisa diverifikasi dari UI.
     */
    function buildUniverse(binance, okx, bybit) {
        const next = emptyCounts();
        next.binanceMarkets = binance.markets.size;
        next.okxMarkets = okx.markets.size;
        next.bybitMarkets = bybit.markets.size;

        // 1. Kandidat: gabungan base coin ketiga venue, diurutkan volume futures
        //    24 jam (Binance jadi acuan utama; venue lain dipakai bila tidak ada).
        const candidates = new Map();
        [['Binance', binance.markets], ['OKX', okx.markets], ['Bybit', bybit.markets]].forEach(([venue, map]) => {
            map.forEach((entry, base) => {
                const existing = candidates.get(base);
                const turnover = Number(entry.turnover) || 0;
                if (!existing) {
                    candidates.set(base, { base, bestTurnover: turnover, bestVenue: venue });
                } else if (turnover > existing.bestTurnover) {
                    existing.bestTurnover = turnover;
                    existing.bestVenue = venue;
                }
            });
        });
        next.candidates = candidates.size;

        const ranked = Array.from(candidates.values())
            .sort((a, b) => b.bestTurnover - a.bestTurnover || a.base.localeCompare(b.base));
        const top = ranked.slice(0, universeMax);
        next.topUniverse = top.length;

        const result = new Map();
        top.forEach((candidate) => {
            const base = candidate.base;
            const legs = {
                Binance: binance.markets.get(base) || null,
                OKX: okx.markets.get(base) || null,
                Bybit: bybit.markets.get(base) || null
            };

            // 2. Harus tersedia di ketiga exchange sekaligus.
            if (VENUES.some((venue) => !legs[venue])) {
                next.rejected.missingVenue += 1;
                return;
            }
            next.inAllVenues += 1;

            // 4a. Harga harus ada di ketiga venue.
            const unitPrices = VENUES.map((venue) => legs[venue].unitPrice);
            if (unitPrices.some((price) => !(price > 0))) {
                next.rejected.noPrice += 1;
                return;
            }
            next.withPrice += 1;

            // 4b. Funding rate harus ada di ketiga venue.
            const funding = {};
            let fundingComplete = true;
            VENUES.forEach((venue) => {
                const rate = legs[venue].funding;
                if (Number.isFinite(rate)) funding[venue] = rate;
                else fundingComplete = false;
            });
            if (!fundingComplete) {
                next.rejected.noFunding += 1;
                return;
            }
            next.withFunding += 1;

            // 3. Symbol mapping benar: harga per 1 unit coin antar venue harus
            //    sepakat (menangkap multiplier 1000x maupun mapping yang salah).
            const reference = unitPrices[0];
            const aligned = unitPrices.every((price) => Math.abs(price - reference) / reference <= PRICE_TOLERANCE);
            if (!aligned) {
                next.rejected.symbolMismatch += 1;
                return;
            }
            next.symbolAligned += 1;

            // 5. Liquidity gate: pakai venue TERKECIL (kapasitas rute 3 leg).
            const turnover = {
                Binance: Number(legs.Binance.turnover) || 0,
                OKX: Number(legs.OKX.turnover) || 0,
                Bybit: Number(legs.Bybit.turnover) || 0
            };
            const minVenueTurnover = Math.min(turnover.Binance, turnover.OKX, turnover.Bybit);
            if (minVenueTurnover < minTurnover) {
                next.rejected.lowLiquidity += 1;
                return;
            }

            const spreads = VENUES.map((venue) => legs[venue].spreadBps).filter((bps) => Number.isFinite(bps));
            const worstSpread = spreads.length > 0 ? Math.max(...spreads) : null;
            if (worstSpread !== null && worstSpread > maxSpreadBps) {
                next.rejected.wideSpread += 1;
                return;
            }

            const symbols = {
                Binance: legs.Binance.symbol,
                OKX: legs.OKX.symbol,
                Bybit: legs.Bybit.symbol
            };
            const spotChart = binance.spotSymbols.has(symbols.Binance)
                || binance.spotSymbols.has(base + 'USDT');

            result.set(base, {
                base,
                // Pair yang dipakai chart & futures engine = symbol Binance.
                pair: symbols.Binance,
                symbols,
                multipliers: {
                    Binance: legs.Binance.multiplier,
                    OKX: legs.OKX.multiplier,
                    Bybit: legs.Bybit.multiplier
                },
                unitPrice: reference,
                funding,
                turnover,
                minTurnover: minVenueTurnover,
                spreadBps: worstSpread,
                spreadCoverage: spreads.length,
                openInterestUsd: legs.Bybit.openInterestUsd || null,
                spotChart
            });
            if (spotChart) next.spotChart += 1;
            next.liquid += 1;
        });

        return { entries: result, counts: next };
    }

    // ------------------------------------------------------------- lifecycle

    async function refresh(options = {}) {
        const force = options.force === true;
        if (refreshing) return getSnapshot();
        if (!force && updatedAt > 0 && Date.now() - updatedAt < REFRESH_INTERVAL_MS) return getSnapshot();

        refreshing = true;
        phase = 'refreshing';
        emit();
        try {
            const results = await Promise.all([
                loadBinance().then((data) => ({ ok: true, data }), (error) => ({ ok: false, error: error.message })),
                loadOkx().then((data) => ({ ok: true, data }), (error) => ({ ok: false, error: error.message })),
                loadBybit().then((data) => ({ ok: true, data }), (error) => ({ ok: false, error: error.message }))
            ]);
            const [binanceRes, okxRes, bybitRes] = results;

            venueStatus.Binance = binanceRes.ok ? 'live' : 'error';
            venueStatus.OKX = okxRes.ok ? 'live' : 'error';
            venueStatus.Bybit = bybitRes.ok ? 'live' : 'error';
            venueErrors.Binance = binanceRes.ok ? (binanceRes.data.error || null) : binanceRes.error;
            venueErrors.OKX = okxRes.ok ? (okxRes.data.error || null) : okxRes.error;
            venueErrors.Bybit = bybitRes.ok ? null : bybitRes.error;

            const liveVenues = VENUES.filter((venue) => venueStatus[venue] === 'live').length;
            if (liveVenues < VENUES.length) {
                // Intersection butuh ketiganya; kalau ada venue mati, universe
                // terakhir tetap dipakai (tidak dikosongkan) tapi ditandai.
                const message = VENUES
                    .filter((venue) => venueStatus[venue] !== 'live')
                    .map((venue) => `${venue}: ${venueErrors[venue] || 'tidak tersedia'}`)
                    .join(' | ');
                lastError = `Universe tidak di-refresh penuh — ${message}`;
                if (liveVenues === 0) {
                    phase = entries.size > 0 ? 'ready' : 'error';
                    return getSnapshot();
                }
                // Universe terakhir tetap dipakai, tapi umurnya TIDAK direset:
                // badge umur data harus jujur soal kapan intersection terakhir
                // benar-benar diverifikasi terhadap ketiga exchange.
                phase = entries.size > 0 ? 'ready' : 'error';
                return getSnapshot();
            }

            const built = buildUniverse(binanceRes.data, okxRes.data, bybitRes.data);
            entries = built.entries;
            counts = built.counts;
            rawMarkets = { Binance: binanceRes.data.markets, OKX: okxRes.data.markets, Bybit: bybitRes.data.markets };
            lastError = null;
            phase = 'ready';
            updatedAt = Date.now();
            return getSnapshot();
        } catch (e) {
            lastError = e && e.message ? e.message : String(e);
            phase = entries.size > 0 ? 'ready' : 'error';
            return getSnapshot();
        } finally {
            refreshing = false;
            emit();
        }
    }

    function tick() {
        // Tab yang tidak terlihat tidak perlu menarik data exchange.
        try {
            if (typeof document !== 'undefined' && document.hidden) return;
        } catch (e) { /* noop */ }
        refresh();
    }

    function start() {
        if (started) return;
        started = true;
        refresh({ force: updatedAt === 0 });
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(tick, REFRESH_INTERVAL_MS);
    }

    function stop() {
        started = false;
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
    }

    // ---------------------------------------------------------------- output

    function sortedEntries() {
        // Prioritas: volume futures 24 jam venue terkecil (kapasitas rute).
        return Array.from(entries.values()).sort((a, b) => b.minTurnover - a.minTurnover || a.base.localeCompare(b.base));
    }

    function getSnapshot() {
        return {
            phase,
            refreshing,
            updatedAt,
            ageMs: updatedAt > 0 ? Date.now() - updatedAt : null,
            error: lastError,
            venueStatus: Object.assign({}, venueStatus),
            venueErrors: Object.assign({}, venueErrors),
            counts: JSON.parse(JSON.stringify(counts)),
            universeMax,
            minTurnover,
            maxSpreadBps,
            refreshIntervalMs: REFRESH_INTERVAL_MS,
            coins: sortedEntries()
        };
    }

    function getEntry(coinOrPair) {
        if (!coinOrPair) return null;
        const key = String(coinOrPair).toUpperCase();
        if (entries.has(key)) return entries.get(key);
        const base = canonicalBase(key, key.includes('-') ? 'OKX' : 'BINANCE');
        return entries.get(base) || null;
    }

    /** Base coin dari pair apa pun (BTCUSDT / 1000SHIBUSDT / SHIB-USDT-SWAP). */
    function getBase(coinOrPair) {
        if (!coinOrPair) return null;
        const key = String(coinOrPair).toUpperCase();
        if (entries.has(key)) return key;
        const entry = getEntry(key);
        if (entry) return entry.base;
        return canonicalBase(key, key.includes('-') ? 'OKX' : 'BINANCE');
    }

    function has(coinOrPair) {
        return getEntry(coinOrPair) !== null;
    }

    /**
     * Biaya eksekusi per SATU fill (%): setengah spread bid/ask (harus menyeberangi
     * book) + dampak harga = (ukuran / volume 24 jam) * IMPACT_FACTOR.
     * Fungsi murni supaya scanner dan test memakai rumus yang sama.
     */
    function computeSlippagePct(spreadBps, turnover, posSize) {
        const size = Number(posSize);
        if (!Number.isFinite(size) || size <= 0) return null;
        const halfSpreadPct = Number.isFinite(spreadBps) && spreadBps > 0 ? (spreadBps / 10000 / 2) * 100 : 0;
        const depth = Number(turnover) > 0 ? Number(turnover) : null;
        const impactPct = depth ? (size / depth) * IMPACT_FACTOR * 100 : 0;
        return halfSpreadPct + impactPct;
    }

    /**
     * Data book NYATA untuk sebuah coin pada venue tertentu (default: ketiganya),
     * dari refresh terakhir seluruh market venue — bukan hanya coin universe.
     * Volume = venue terkecil, spread = venue terlebar (konservatif untuk rute
     * yang benar-benar dipakai). null bila salah satu venue tidak punya market.
     */
    function getMarketStats(coinOrPair, venues) {
        if (!coinOrPair) return null;
        const list = Array.isArray(venues) && venues.length > 0 ? venues : VENUES;
        const raw = String(coinOrPair).toUpperCase();
        const base = raw.includes('-')
            ? canonicalBase(raw, 'OKX')
            : splitMultiplier(raw.replace(/USDT$/, '')).base;
        const legs = list.map((venue) => (rawMarkets[venue] ? rawMarkets[venue].get(base) : null));
        if (legs.some((leg) => !leg)) return null;
        const turnovers = legs.map((leg) => Number(leg.turnover)).filter((v) => Number.isFinite(v) && v > 0);
        const spreads = legs.map((leg) => leg.spreadBps).filter((v) => Number.isFinite(v));
        const bybitIdx = list.indexOf('Bybit');
        return {
            base,
            venues: list.slice(),
            minTurnover: turnovers.length === legs.length ? Math.min(...turnovers) : null,
            spreadBps: spreads.length === legs.length ? Math.max(...spreads) : null,
            openInterestUsd: bybitIdx >= 0 ? (legs[bybitIdx].openInterestUsd || null) : null
        };
    }

    /**
     * Estimasi slippage (%) per fill untuk ukuran posisi tertentu, dari spread
     * nyata dan volume 24 jam. `venues` (opsional) membatasi ke venue rute.
     */
    function estimateSlippagePct(coinOrPair, posSize, venues) {
        if (Array.isArray(venues) && venues.length > 0) {
            const stats = getMarketStats(coinOrPair, venues);
            if (stats) return computeSlippagePct(stats.spreadBps, stats.minTurnover, posSize);
        }
        const entry = getEntry(coinOrPair);
        if (!entry) return null;
        return computeSlippagePct(entry.spreadBps, entry.minTurnover, posSize);
    }

    /** Skor liquidity 0-100 dari volume 24 jam (log scale, mudah dijelaskan). */
    function liquidityScore(turnover) {
        const value = Number(turnover);
        if (!Number.isFinite(value) || value <= 0) return 0;
        return Math.max(0, Math.min(100, Math.round(60 + 20 * Math.log10(value / 1e6))));
    }

    return {
        // lifecycle
        start,
        stop,
        refresh,
        isRunning: () => started,
        isRefreshing: () => refreshing,

        // universe
        getSnapshot,
        getReport: getSnapshot,
        getEntries: sortedEntries,
        getCoins: () => sortedEntries().map((entry) => entry.base),
        getPairs: () => sortedEntries().map((entry) => entry.pair),
        getEntry,
        getSymbolMap: (coinOrPair) => {
            const entry = getEntry(coinOrPair);
            return entry ? Object.assign({}, entry.symbols) : null;
        },
        getFunding: (coinOrPair) => {
            const entry = getEntry(coinOrPair);
            return entry ? Object.assign({}, entry.funding) : null;
        },
        getLiquidity: (coinOrPair) => {
            const entry = getEntry(coinOrPair);
            if (!entry) return null;
            return {
                turnover: Object.assign({}, entry.turnover),
                minTurnover: entry.minTurnover,
                spreadBps: entry.spreadBps,
                openInterestUsd: entry.openInterestUsd
            };
        },
        has,
        getBase,
        size: () => entries.size,

        // konfigurasi
        getUniverseMax: () => universeMax,
        setUniverseMax(value) {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) return universeMax;
            universeMax = Math.min(UNIVERSE_MAX_LIMIT, Math.max(UNIVERSE_MIN_LIMIT, Math.round(parsed)));
            persist(STORAGE_KEYS.universeMax, universeMax);
            refresh({ force: true });
            return universeMax;
        },
        getMinTurnover: () => minTurnover,
        setMinTurnover(value) {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) return minTurnover;
            minTurnover = parsed;
            persist(STORAGE_KEYS.minTurnover, minTurnover);
            refresh({ force: true });
            return minTurnover;
        },
        getMaxSpreadBps: () => maxSpreadBps,
        setMaxSpreadBps(value) {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) return maxSpreadBps;
            maxSpreadBps = parsed;
            persist(STORAGE_KEYS.maxSpreadBps, maxSpreadBps);
            refresh({ force: true });
            return maxSpreadBps;
        },

        // helper perhitungan (dipakai scanner + test)
        estimateSlippagePct,
        computeSlippagePct,
        getMarketStats,
        liquidityScore,
        canonicalBase,
        splitMultiplier,
        isUsdtPerpetualSymbol,

        // subscriber
        subscribe(fn) {
            if (typeof fn !== 'function') return () => {};
            listeners.add(fn);
            return () => listeners.delete(fn);
        },

        CONFIG: Object.freeze({
            UNIVERSE_MAX_DEFAULT,
            UNIVERSE_MIN_LIMIT,
            UNIVERSE_MAX_LIMIT,
            REFRESH_INTERVAL_MS,
            MIN_TURNOVER_DEFAULT,
            MAX_SPREAD_BPS_DEFAULT,
            PRICE_TOLERANCE,
            IMPACT_FACTOR,
            VENUES: VENUES.slice()
        })
    };
})();
