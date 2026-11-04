// arbitrageScanner.js
// Isolated module for Funding Rate Arbitrage Scanner.
//
// Fokus 3 exchange: Binance, OKX, Bybit. Funding rate diambil live dari API
// publik ketiganya (tanpa API key). Exchange lain (Gate, KuCoin, MEXC, Bitget,
// Hyperliquid, BingX, HTX) sudah dihapus supaya setiap angka yang tampil bisa
// diverifikasi di exchange yang benar-benar didukung terminal ini.
//
// Pos Size bebas diisi user (mis. 10 atau 50 USDT), bukan lagi pilihan tetap.

window.ArbitrageScanner = (function() {
    'use strict';

    const POLLING_INTERVAL = 10000; // 10 seconds
    const REQUEST_TIMEOUT_MS = 8000;

    // Satu-satunya exchange yang discan. Urutan ini juga dipakai untuk chip
    // status di modal, jadi jangan diubah sembarangan.
    const SUPPORTED_EXCHANGES = ['Binance', 'OKX', 'Bybit'];

    const ENDPOINTS = {
        Binance: 'https://fapi.binance.com/fapi/v1/premiumIndex',
        OKX: 'https://www.okx.com/api/v5/public/funding-rate?instId=ANY',
        Bybit: 'https://api.bybit.com/v5/market/tickers?category=linear'
    };

    // Taker fee standar (VIP 0) per leg untuk USDT perpetual. Dipakai menghitung
    // biaya nyata tiap rute long/short — di posisi kecil fee ini yang menentukan
    // apakah peluang masih profit atau tidak.
    // Tarif publik regular user (USDT perpetual): Binance 0.05%, OKX 0.05%, Bybit 0.055%.
    const TAKER_FEE = { Binance: 0.0005, OKX: 0.0005, Bybit: 0.00055 };

    // Interval funding standar bila venue tidak melaporkannya (industri: 8 jam).
    // Dipilih 8 jam (bukan angka yang lebih kecil) supaya income tidak pernah
    // dilebih-lebihkan saat data interval tidak tersedia.
    const DEFAULT_FUNDING_INTERVAL_HOURS = 8;
    const BINANCE_FUNDING_INFO_URL = 'https://fapi.binance.com/fapi/v1/fundingInfo';
    const BINANCE_FUNDING_INFO_TTL_MS = 10 * 60 * 1000;

    const POS_SIZE_STORAGE_KEY = 'masako_arb_pos_size_v1';
    const POS_SIZE_MIN = 10;
    const POS_SIZE_MAX = 100000000;
    const DEFAULT_POS_SIZE = 1000;

    // Mode universe. 'LOCAL' = LOCAL ARBITRAGE: hanya coin hasil dynamic
    // intersection MarketUniverse (Top N volume futures 24h ∩ Binance·OKX·Bybit
    // dengan harga+funding+liquidity valid). 'ALL' = perilaku lama: semua coin
    // yang punya funding di >= 2 venue.
    const UNIVERSE_MODE_STORAGE_KEY = 'masako_arb_universe_mode_v1';
    const UNIVERSE_MODES = ['LOCAL', 'ALL'];
    const DEFAULT_UNIVERSE_MODE = 'LOCAL';

    let pollingTimer = null;
    let isModalOpen = false;
    let isFetching = false;
    let lastFetchTime = 0;
    let demoMode = false;
    let universeMode = readStoredUniverseMode();
    let universeSubscribed = false;

    const exchangeData = { Binance: {}, OKX: {}, Bybit: {} };
    // coin -> interval funding (jam) hasil laporan venue; kosong = tidak diketahui.
    const fundingIntervals = { Binance: {}, OKX: {}, Bybit: {} };
    let binanceIntervalCache = { at: 0, map: null };
    const sourceStatus = { Binance: 'idle', OKX: 'idle', Bybit: 'idle' };
    const sourceErrors = { Binance: null, OKX: null, Bybit: null };

    let previousResultsMap = new Map(); // coin -> { rate, netProfit }
    let posSize = readStoredPosSize();

    function readStoredUniverseMode() {
        try {
            if (typeof safeLoad !== 'function') return DEFAULT_UNIVERSE_MODE;
            const stored = String(safeLoad(UNIVERSE_MODE_STORAGE_KEY, DEFAULT_UNIVERSE_MODE) || '').toUpperCase();
            return UNIVERSE_MODES.includes(stored) ? stored : DEFAULT_UNIVERSE_MODE;
        } catch (e) {
            return DEFAULT_UNIVERSE_MODE;
        }
    }

    /** Universe siap dipakai = mode LOCAL dan MarketUniverse sudah punya hasil. */
    function universeSnapshot() {
        if (typeof window === 'undefined' || !window.MarketUniverse) return null;
        try {
            const snapshot = window.MarketUniverse.getSnapshot();
            if (!snapshot || !Array.isArray(snapshot.coins)) return null;
            return snapshot;
        } catch (e) {
            return null;
        }
    }

    function isUniverseActive() {
        if (universeMode !== 'LOCAL') return false;
        const snapshot = universeSnapshot();
        return Boolean(snapshot && snapshot.coins.length > 0);
    }

    // ---------------------------------------------------------------- helpers

    // Normalization helper: ubah instId/symbol exchange jadi ticker dasar (BTC, ETH, ...)
    function normalizeSymbol(symbol, exchange) {
        if (!symbol) return null;
        const s = String(symbol).toUpperCase();

        if (exchange === 'OKX') return s.replace('-USDT-SWAP', '').replace('-USDT', '');
        // Binance & Bybit sama-sama memakai format <COIN>USDT untuk perpetual.
        return s.replace('USDT', '');
    }

    // A simple deterministic hash function for strings
    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) - hash + str.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash);
    }

    // Hanya ticker linear USDT perpetual: buang kontrak berjangka bertanggal
    // (BTC-27SEP24 / BTCUSDT_240628), pair inverse, dan pair non-USDT.
    function isUsdtPerpetual(rawSymbol) {
        const s = String(rawSymbol || '').toUpperCase();
        if (!s || s.includes('-') || s.includes('_')) return false;
        return /^[A-Z0-9]{2,20}USDT$/.test(s);
    }

    async function fetchJson(url) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
        try {
            const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
            if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no-response'}`);
            return await res.json();
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // ------------------------------------------------------------ venue feeds

    /** Interval funding masuk akal (0.5 - 24 jam), dibulatkan ke 0.25 jam. */
    function sanitizeIntervalHours(value) {
        const hours = Number(value);
        if (!Number.isFinite(hours) || hours < 0.5 || hours > 24) return null;
        return Math.round(hours * 4) / 4;
    }

    /**
     * Binance hanya mencantumkan symbol yang intervalnya BUKAN 8 jam di
     * /fundingInfo; symbol lain memang 8 jam. Di-cache 10 menit. Bila request
     * gagal, hasilnya null (interval Binance dianggap tidak diketahui).
     */
    async function loadBinanceIntervals() {
        const now = Date.now();
        if (binanceIntervalCache.map && now - binanceIntervalCache.at < BINANCE_FUNDING_INFO_TTL_MS) {
            return binanceIntervalCache.map;
        }
        try {
            const info = await fetchJson(BINANCE_FUNDING_INFO_URL);
            if (!Array.isArray(info)) throw new Error('format fundingInfo tidak valid');
            const map = {};
            info.forEach((row) => {
                if (!row || !row.symbol) return;
                const hours = sanitizeIntervalHours(row.fundingIntervalHours);
                if (hours !== null) map[String(row.symbol).toUpperCase()] = hours;
            });
            binanceIntervalCache = { at: now, map };
            return map;
        } catch (e) {
            return binanceIntervalCache.map;
        }
    }

    async function fetchBinance() {
        try {
            const [data, intervalMap] = await Promise.all([fetchJson(ENDPOINTS.Binance), loadBinanceIntervals()]);
            const rates = {};
            const intervals = {};
            if (Array.isArray(data)) {
                data.forEach((item) => {
                    if (!item || !item.symbol || !isUsdtPerpetual(item.symbol)) return;
                    const rate = parseFloat(item.lastFundingRate);
                    if (!Number.isFinite(rate)) return;
                    const coin = normalizeSymbol(item.symbol, 'Binance');
                    rates[coin] = rate;
                    if (intervalMap) {
                        intervals[coin] = intervalMap[String(item.symbol).toUpperCase()] || 8;
                    }
                });
            }
            if (Object.keys(rates).length === 0) throw new Error('tidak ada funding rate USDT perpetual');
            return { ok: true, rates, intervals };
        } catch (e) {
            console.warn('Binance Arb fetch error:', e.message);
            return { ok: false, rates: {}, error: e.message };
        }
    }

    async function fetchOKX() {
        try {
            // instId=ANY mengembalikan funding rate semua perpetual USDT dalam 1
            // request (rate limit OKX: 10 req / 2 detik per IP).
            const raw = await fetchJson(ENDPOINTS.OKX);
            const rates = {};
            const intervals = {};
            const rows = raw && Array.isArray(raw.data) ? raw.data : [];
            if (raw && raw.code && raw.code !== '0') throw new Error(raw.msg || `kode ${raw.code}`);
            rows.forEach((item) => {
                if (!item || !item.instId || !String(item.instId).endsWith('-USDT-SWAP')) return;
                const rate = parseFloat(item.fundingRate);
                if (!Number.isFinite(rate)) return;
                const coin = normalizeSymbol(item.instId, 'OKX');
                rates[coin] = rate;
                // Interval = jarak antara settlement ini dan settlement berikutnya.
                const hours = sanitizeIntervalHours((Number(item.nextFundingTime) - Number(item.fundingTime)) / 3600000);
                if (hours !== null) intervals[coin] = hours;
            });
            if (Object.keys(rates).length === 0) throw new Error('tidak ada funding rate USDT swap');
            return { ok: true, rates, intervals };
        } catch (e) {
            console.warn('OKX Arb fetch error:', e.message);
            return { ok: false, rates: {}, error: e.message };
        }
    }

    async function fetchBybit() {
        try {
            const raw = await fetchJson(ENDPOINTS.Bybit);
            const rates = {};
            const intervals = {};
            const list = raw && raw.result && Array.isArray(raw.result.list) ? raw.result.list : [];
            list.forEach((item) => {
                if (!item || !item.symbol || !isUsdtPerpetual(item.symbol)) return;
                const rate = parseFloat(item.fundingRate);
                if (!Number.isFinite(rate)) return;
                const coin = normalizeSymbol(item.symbol, 'Bybit');
                rates[coin] = rate;
                const hours = sanitizeIntervalHours(item.fundingIntervalHour);
                if (hours !== null) intervals[coin] = hours;
            });
            if (Object.keys(rates).length === 0) throw new Error('tidak ada funding rate linear USDT');
            return { ok: true, rates, intervals };
        } catch (e) {
            console.warn('Bybit Arb fetch error:', e.message);
            return { ok: false, rates: {}, error: e.message };
        }
    }

    const FETCHERS = { Binance: fetchBinance, OKX: fetchOKX, Bybit: fetchBybit };

    // Data demo deterministik — HANYA dipakai kalau ketiga API tidak terjangkau
    // (mis. diblokir jaringan lokal), dan selalu ditandai "SIMULASI" di UI
    // supaya tidak pernah terlihat seperti angka live.
    const DEMO_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'WIF',
        'PEPE', 'SHIB', 'OP', 'ARB', 'TIA', 'SUI', 'APT', 'SEI', 'LTC', 'BNB',
        'TON', 'NEAR', 'INJ', 'ATOM', 'FIL', 'TRX', 'ETC', 'BCH', 'UNI', 'AAVE'];

    function buildDemoData() {
        const result = { Binance: {}, OKX: {}, Bybit: {} };
        DEMO_COINS.forEach((coin) => {
            const h = hashString(coin);
            const base = ((h % 100) - 50) / 100000;              // -0.05% .. +0.05%
            result.Binance[coin] = base;
            result.OKX[coin] = base + (((h % 60) - 30) / 100000); // ±0.03%
            result.Bybit[coin] = base + ((((h >> 3) % 60) - 30) / 100000);
        });
        return result;
    }

    // -------------------------------------------------------------- pos size

    function clampPosSize(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return null;
        return Math.min(POS_SIZE_MAX, Math.max(POS_SIZE_MIN, numeric));
    }

    function readStoredPosSize() {
        try {
            if (typeof safeLoad !== 'function') return DEFAULT_POS_SIZE;
            return clampPosSize(safeLoad(POS_SIZE_STORAGE_KEY, DEFAULT_POS_SIZE)) || DEFAULT_POS_SIZE;
        } catch (e) {
            return DEFAULT_POS_SIZE;
        }
    }

    function persisPosSize(value) {
        try {
            if (typeof safeStore === 'function') safeStore(POS_SIZE_STORAGE_KEY, value);
        } catch (e) { /* localStorage penuh / diblokir: ukuran tetap dipakai di sesi ini */ }
    }

    function syncPosSizeInput() {
        // Dua modal punya input sendiri tapi satu sumber truth (posSize).
        const a = document.getElementById('arb-pos-size');
        if (a) a.value = String(posSize);
        const b = document.getElementById('local-pos-size');
        if (b) b.value = String(posSize);
    }

    // Format ringkas khusus label ukuran posisi (tanpa simbol desimal panjang).
    function formatSizeLabel(value) {
        return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    function updatePosSizeHint() {
        const text = `Aktif: ${formatSizeLabel(posSize)} · min $${POS_SIZE_MIN} — profit, fee & ROI di bawah mengikuti ukuran ini.`;
        ['arb-pos-hint', 'local-pos-hint'].forEach((id) => {
            const hint = document.getElementById(id);
            if (hint) hint.textContent = text;
        });
        ['arb-size-presets', 'local-size-presets'].forEach((pid) => {
            const presets = document.getElementById(pid);
            if (presets && typeof presets.querySelectorAll === 'function') {
                presets.querySelectorAll('[data-arb-size]').forEach((btn) => {
                    const active = Number(btn.getAttribute('data-arb-size')) === posSize;
                    if (btn.classList && typeof btn.classList.toggle === 'function') btn.classList.toggle('active', active);
                });
            }
        });
    }

    /** Simpan ukuran posisi baru (clamp ke batas aman) dan sinkronkan input. */
    function setPosSize(value, options = {}) {
        const clamped = clampPosSize(value);
        if (clamped === null) {
            if (options.syncInput !== false) syncPosSizeInput(); // pulihkan nilai valid terakhir
            return posSize;
        }
        posSize = clamped;
        if (options.syncInput !== false) syncPosSizeInput();
        if (options.persist !== false) persisPosSize(posSize);
        updatePosSizeHint();
        return posSize;
    }

    /**
     * Dipakai saat user sedang mengetik: pakai nilainya (di-clamp) untuk hitung
     * ulang, tapi kolom input tidak dirapikan supaya mengetik "50" tidak
     * langsung berubah jadi "10" di tengah jalan.
     * Mengembalikan null kalau isinya bukan angka positif (mis. kosong).
     */
    function previewPosSize(value) {
        const numeric = Number(value);
        if (String(value).trim() === '' || !Number.isFinite(numeric) || numeric <= 0) return null;
        posSize = clampPosSize(numeric);
        updatePosSizeHint();
        return posSize;
    }

    // -------------------------------------------------------------- lifecycle

    function setBadge(text, color) {
        const el = document.getElementById('arb-status-badge');
        if (!el) return;
        el.innerText = text;
        el.style.color = color;
    }

    function countLiveSources() {
        return SUPPORTED_EXCHANGES.filter((ex) => sourceStatus[ex] === 'live').length;
    }

    async function fetchData() {
        if (isFetching) return null;
        isFetching = true;
        setBadge('Updating...', 'var(--color-pending)');

        try {
            const responses = await Promise.all(
                SUPPORTED_EXCHANGES.map((ex) => FETCHERS[ex]().then((res) => [ex, res]))
            );

            responses.forEach(([exchange, res]) => {
                if (res && res.ok) {
                    exchangeData[exchange] = res.rates;
                    fundingIntervals[exchange] = res.intervals || {};
                    sourceStatus[exchange] = 'live';
                    sourceErrors[exchange] = null;
                } else {
                    exchangeData[exchange] = {};
                    fundingIntervals[exchange] = {};
                    sourceStatus[exchange] = 'error';
                    sourceErrors[exchange] = (res && res.error) || 'tidak diketahui';
                }
            });

            // Kalau ketiganya tidak terjangkau (geoblock/DNS), tampilkan data
            // simulasi yang jelas ditandai sebagai simulasi.
            demoMode = countLiveSources() === 0;
            if (demoMode) {
                const demo = buildDemoData();
                SUPPORTED_EXCHANGES.forEach((exchange) => {
                    exchangeData[exchange] = demo[exchange];
                    fundingIntervals[exchange] = {};
                    sourceStatus[exchange] = 'demo';
                });
            }

            lastFetchTime = Date.now();
            if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
            setBadge(demoMode ? 'SIMULASI' : 'Live',
                demoMode ? 'var(--color-warning)' : 'var(--color-correct)');
            return exchangeData;
        } finally {
            isFetching = false;
        }
    }

    function start() {
        isModalOpen = true;
        const storedPosSize = readStoredPosSize();
        if (storedPosSize !== posSize) {
            setPosSize(storedPosSize, { persist: false });
        } else {
            syncPosSizeInput();
        }
        syncUniverseModeInput();
        updatePosSizeHint();
        // LOCAL ARBITRAGE: pastikan universe hidup + segar sebelum scan pertama.
        if (window.MarketUniverse) {
            window.MarketUniverse.start();
            if (!universeSubscribed) {
                universeSubscribed = true;
                // Universe berubah (coin bertambah/hilang) -> hitung & render ulang.
                window.MarketUniverse.subscribe(() => {
                    if (isModalOpen && window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
                });
            }
            window.MarketUniverse.refresh();
        }
        fetchData();
        if (pollingTimer) clearInterval(pollingTimer);
        pollingTimer = setInterval(fetchData, POLLING_INTERVAL);
    }

    function stop() {
        isModalOpen = false;
        if (pollingTimer) clearInterval(pollingTimer);
        pollingTimer = null;
    }

    function syncUniverseModeInput() {
        const select = document.getElementById('arb-universe-mode');
        if (select && select.value !== universeMode) select.value = universeMode;
    }

    /** Ganti mode universe (LOCAL ARBITRAGE / ALL) dan simpan sebagai preferensi. */
    function setUniverseMode(mode) {
        const next = String(mode || '').toUpperCase();
        if (!UNIVERSE_MODES.includes(next)) return universeMode;
        universeMode = next;
        try {
            if (typeof safeStore === 'function') safeStore(UNIVERSE_MODE_STORAGE_KEY, universeMode);
        } catch (e) { /* preferensi gagal disimpan: mode tetap aktif di sesi ini */ }
        syncUniverseModeInput();
        return universeMode;
    }

    return {
        start, stop,
        refresh: fetchData,
        isRunning: () => isModalOpen,

        // Mode universe (LOCAL ARBITRAGE vs semua coin funding)
        getUniverseMode: () => universeMode,
        setUniverseMode,
        getUniverseModes: () => UNIVERSE_MODES.slice(),
        isUniverseActive,
        getUniverseSnapshot: universeSnapshot,

        // Data per exchange (hanya 3 exchange yang didukung)
        getSupportedExchanges: () => SUPPORTED_EXCHANGES.slice(),
        getExchangeData: (exchange) => exchangeData[exchange] || {},
        getBinanceData: () => exchangeData.Binance,
        getBybitData: () => exchangeData.Bybit,
        getOKXData: () => exchangeData.OKX,
        getSourceStatus: () => Object.assign({}, sourceStatus),
        getSourceErrors: () => Object.assign({}, sourceErrors),
        isDemoData: () => demoMode,
        getTakerFee: (exchange) => TAKER_FEE[exchange] || 0.0005,
        // Interval funding (jam) per venue/coin. live=false berarti diasumsikan.
        getFundingInterval: (exchange, coin) => {
            const hours = fundingIntervals[exchange] ? fundingIntervals[exchange][coin] : undefined;
            return Number.isFinite(hours)
                ? { hours, live: true }
                : { hours: DEFAULT_FUNDING_INTERVAL_HOURS, live: false };
        },

        getLastFetchTime: () => lastFetchTime,
        getPreviousResultsMap: () => previousResultsMap,
        setPreviousResultsMap: (m) => previousResultsMap = m,

        // Pos size bebas diisi
        getPosSize: () => posSize,
        setPosSize,
        previewPosSize,
        getPosSizeBounds: () => ({ min: POS_SIZE_MIN, max: POS_SIZE_MAX }),

        hashString,
        // Normalisasi symbol exchange -> key cache funding (dipakai universe
        // LOCAL ARBITRAGE supaya lookup funding selalu pakai key yang sama).
        normalizeSymbol
    };
})();

window.ArbitrageScannerRender = (function() {
    'use strict';

    const INTERVAL_HOURS = { '1H': 1, '4H': 4, '8H': 8 };

    function formatUsd(value) {
        const abs = Math.abs(value);
        if (abs >= 1000000) return '$' + value.toFixed(0);
        if (abs >= 1000) return '$' + value.toFixed(2);
        if (abs >= 1) return '$' + value.toFixed(2);
        if (abs >= 0.01) return '$' + value.toFixed(4);
        return '$' + value.toFixed(6);
    }

    function formatPosSize(value) {
        const abs = Math.abs(value);
        if (abs >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 2 });
        return '$' + value.toFixed(abs < 1 ? 2 : 0);
    }

    // Symbol datang dari API exchange: buang karakter apa pun yang bisa lolos
    // ke HTML, lalu escape sebagai lapisan kedua.
    function safeSymbol(symbol) {
        const clean = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (typeof escapeHTML === 'function') return escapeHTML(clean);
        return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** Escape untuk atribut title (escapeHTML bila tersedia, fallback manual). */
    function safeAttr(value) {
        const text = String(value ?? '');
        if (typeof escapeHTML === 'function') return escapeHTML(text);
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatHours(hours) {
        if (!Number.isFinite(hours)) return '-';
        return `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0+$/, '')}j`;
    }

    function formatSignedPct(val, digits = 2) {
        if (!Number.isFinite(val)) return '-';
        return `${val > 0 ? '+' : ''}${val.toFixed(digits)}%`;
    }

    function formatPct(val) {
        if (val === undefined || val === null || !Number.isFinite(val)) return '-';
        return (val * 100).toFixed(4) + '%';
    }

    function getPctColorClass(val) {
        if (val === undefined || val === null) return '';
        return val < 0 ? 'arb-funding-neg' : (val > 0 ? 'arb-funding-pos' : '');
    }

    // Risiko venue: tiga exchange terbesar, jadi bobotnya tetap dan tinggi.
    const EXCHANGE_RISK_SCORE = 95;

    function readDomValue(id, fallback) {
        try {
            const el = document.getElementById(id);
            if (el && typeof el.value === 'string' && el.value !== '') return el.value;
        } catch (e) {}
        return fallback;
    }

    // Asumsi model biaya/ROI (semua dapat dilacak ke rumus di estimateRoute).
    const DEFAULT_LEVERAGE = 3;          // leverage tiap leg untuk menghitung modal
    const MAX_LEVERAGE = 20;
    // Dipakai HANYA saat data book venue belum termuat; ditandai costBasis='fallback'.
    const FALLBACK_SPREAD_BPS = 5;       // 0.05% spread bid/ask
    const FALLBACK_TURNOVER = 25_000_000; // volume 24 jam konservatif (USDT)
    const IMPACT_FACTOR_FALLBACK = 10;   // sama dengan MarketUniverse

    /** Biaya per fill (%) = setengah spread + (ukuran / volume 24 jam) * faktor dampak. */
    function computeFillCostPct(universeApi, spreadBps, turnover, posSize) {
        if (universeApi && typeof universeApi.computeSlippagePct === 'function') {
            const v = universeApi.computeSlippagePct(spreadBps, turnover, posSize);
            if (Number.isFinite(v)) return v;
        }
        const half = (spreadBps / 10000 / 2) * 100;
        return half + (posSize / turnover) * IMPACT_FACTOR_FALLBACK * 100;
    }

    /**
     * Estimasi ekonomi satu rute funding-arbitrage delta-netral (fungsi murni).
     *
     *  N            = posSize (notional TIAP leg, USDT)
     *  Leg LONG di venue L, leg SHORT di venue S; rate r_i per interval T_i jam.
     *
     *  Funding per jam  h_i = r_i / T_i          (normalisasi antar interval)
     *  Income / jam     = N * (h_S - h_L)        (short menerima r>0, long membayar r>0)
     *  Income / hari    = 24 * Income/jam
     *  Income / periode = Income/jam * max(T_L, T_S)
     *
     *  Biaya sekali jalan (buka + tutup = 4 fill: long open/close, short open/close):
     *    Fee      = 2 * N * (fee_L + fee_S)                 (taker)
     *    Slippage = 4 * N * fillCostPct / 100               (setengah spread + dampak)
     *    Biaya    = Fee + Slippage
     *
     *  Modal (margin 2 leg) = 2 * N / leverage
     *
     *  Net 24 jam     = Income/hari - Biaya
     *  ROI/periode    = (Income/periode - Biaya) / Modal
     *  ROI/hari       = Net 24 jam / Modal
     *  ROI 7 hari     = (7 * Income/hari - Biaya) / Modal
     *  APR (funding)  = Income/hari * 365 / Modal      (bunga sederhana, sebelum biaya)
     *  Break-even     = Biaya / Income/jam  (jam)
     *
     * Asumsi: funding rate tetap sama selama ditahan (rate nyata berubah tiap
     * periode), harga dua venue konvergen saat ditutup, dan taker di semua fill.
     */
    function estimateRoute(params) {
        const N = Number(params.posSize);
        const leverage = Math.max(1, Number(params.leverage) || 1);
        const L = params.longLeg;
        const S = params.shortLeg;
        const hourlyLong = L.rate / L.hours;
        const hourlyShort = S.rate / S.hours;
        const incomePerHour = N * (hourlyShort - hourlyLong);
        const periodHours = Math.max(L.hours, S.hours);
        const estFunding = incomePerHour * periodHours;
        const dailyFunding = incomePerHour * 24;

        const estFees = 2 * N * (L.takerFee + S.takerFee);
        const estSlippageCost = 4 * N * (params.fillCostPct / 100);
        const estCosts = estFees + estSlippageCost;
        const capitalUsd = (2 * N) / leverage;

        const netProfit = estFunding - estCosts;
        const estDailyProfit = dailyFunding - estCosts;
        const roiPct = (netProfit / capitalUsd) * 100;
        const roiDailyPct = (estDailyProfit / capitalUsd) * 100;
        const roi7dPct = ((dailyFunding * 7 - estCosts) / capitalUsd) * 100;
        const aprPct = ((dailyFunding * 365) / capitalUsd) * 100;
        const breakevenHours = incomePerHour > 0 ? estCosts / incomePerHour : null;
        const breakevenPeriods = estFunding > 0 ? estCosts / estFunding : null;

        return {
            leverage,
            capitalUsd,
            incomePerHour,
            estFunding,
            dailyFunding,
            estFees,
            estSlippageCost,
            estCosts,
            netProfit,
            estDailyProfit,
            roiPct,
            roiDailyPct,
            roi7dPct,
            aprPct,
            breakevenHours,
            breakevenPeriods
        };
    }

    /**
     * Hitung peluang arbitrase.
     * options (opsional, untuk dua modal terpisah):
     *   { universe: 'LOCAL'|'ALL', filterMode, search, intervalPreset, posSize }
     * Tanpa options = perilaku lama (baca #arb-* + universeMode scanner) agar
     * unit test lama tetap valid.
     */
    function calculateData(options) {
        const opts = options || {};
        const exchanges = ArbitrageScanner.getSupportedExchanges();
        const datasets = {};
        exchanges.forEach((ex) => { datasets[ex] = ArbitrageScanner.getExchangeData(ex); });

        // LOCAL ARBITRAGE membatasi scan ke hasil dynamic intersection
        // MarketUniverse; mode ALL memakai semua coin yang punya data funding.
        // Modal strategi memaksa ALL, modal lokal memaksa LOCAL.
        let universeActive;
        let universe = null;
        if (opts.universe === 'ALL') {
            universeActive = false;
        } else if (opts.universe === 'LOCAL') {
            universeActive = ArbitrageScanner.isUniverseActive();
            universe = universeActive ? ArbitrageScanner.getUniverseSnapshot() : null;
            // Fallback: universe LOCAL belum siap -> jangan kosong total di modal
            // lokal; pakai scan ALL sementara (ditandai via meta.universeActive=false).
            if (!universeActive) universe = null;
        } else {
            universeActive = ArbitrageScanner.isUniverseActive();
            universe = universeActive ? ArbitrageScanner.getUniverseSnapshot() : null;
        }
        const universeApi = (typeof window !== 'undefined' && window.MarketUniverse) ? window.MarketUniverse : null;

        // Unit scan: LOCAL ARBITRAGE memakai entry universe (lengkap dengan
        // symbol mapping per venue); mode ALL memakai key cache funding apa adanya.
        const scanUnits = [];
        if (universeActive) {
            universe.coins.forEach((entry) => scanUnits.push({ coin: entry.base, local: entry }));
        } else {
            const allCoins = new Set();
            exchanges.forEach((ex) => Object.keys(datasets[ex]).forEach((coin) => allCoins.add(coin)));
            allCoins.forEach((coin) => scanUnits.push({ coin, local: null }));
        }

        const posSize = Number.isFinite(opts.posSize) && opts.posSize > 0
            ? opts.posSize : ArbitrageScanner.getPosSize();
        const leverageRaw = Number(opts.leverage !== undefined ? opts.leverage
            : (readDomValue('arb-leverage', null) || readDomValue('local-leverage', null) || DEFAULT_LEVERAGE));
        const leverage = Number.isFinite(leverageRaw) && leverageRaw >= 1 ? Math.min(MAX_LEVERAGE, leverageRaw) : DEFAULT_LEVERAGE;
        const intervalPreset = opts.intervalPreset
            || readDomValue('arb-interval-preset', null)
            || readDomValue('local-interval-preset', null)
            || '1H';
        const intervalHours = INTERVAL_HOURS[intervalPreset] || 1;
        const searchQuery = String(
            opts.search !== undefined ? opts.search
            : (readDomValue('arb-search', null) !== null ? readDomValue('arb-search', '')
                : readDomValue('local-search', ''))
        ).toUpperCase();
        const filterMode = opts.filterMode
            || readDomValue('arb-filter-mode', null)
            || readDomValue('local-filter-mode', null)
            || 'Aggressive';

        const results = [];

        // Define presets thresholds based on filter mode
        let minSpreadThreshold = 0.05, minVol = 0, minOI = 0, minStability = 0, maxBidAsk = 0.1, maxSlippage = 0.5, minScore = 0;

        if (filterMode === 'Conservative') {
            minSpreadThreshold = 0.20; minVol = 100_000_000; minOI = 30_000_000; minStability = 80; maxBidAsk = 0.02; maxSlippage = 0.05; minScore = 80;
        } else if (filterMode === 'Balanced') {
            minSpreadThreshold = 0.10; minVol = 50_000_000; minOI = 10_000_000; minStability = 60; maxBidAsk = 0.05; maxSlippage = 0.10; minScore = 60;
        } else {
            // Aggressive
            // Aggressive = tanpa gerbang biaya: coin tipis tetap tampil, dan ROI-nya
            // yang jujur menunjukkan negatif bila biaya spread/dampak melebihi funding.
            minSpreadThreshold = 0.02; minVol = 0; minOI = 0; minStability = 0; maxBidAsk = Infinity; maxSlippage = Infinity; minScore = 0;
        }

        // Adjust for interval if Conservative or Balanced
        if (filterMode !== 'Aggressive') {
            if (intervalPreset === '4H') {
                minSpreadThreshold *= 1.5; minVol *= 1.5; minScore += 5;
            } else if (intervalPreset === '8H') {
                minSpreadThreshold *= 2.0; minVol *= 2.0; minScore += 10;
            }
        }

        for (const unit of scanUnits) {
            const coin = unit.coin;
            const local = unit.local;
            if (searchQuery && !coin.includes(searchQuery)) continue;

            const rates = [];
            exchanges.forEach((ex) => {
                // Key cache funding mengikuti symbol venue (mis. Binance
                // `1000SHIBUSDT` -> `1000SHIB`, OKX `SHIB-USDT-SWAP` -> `SHIB`).
                const key = local ? ArbitrageScanner.normalizeSymbol(local.symbols[ex], ex) : coin;
                const rate = datasets[ex][key];
                if (!Number.isFinite(rate)) return;
                // Funding rate hanya sebanding bila dinormalisasi ke per-jam:
                // venue dengan interval 4 jam membayar 2x lebih sering daripada 8 jam.
                const interval = ArbitrageScanner.getFundingInterval(ex, key);
                rates.push({ ex, rate, hours: interval.hours, intervalLive: interval.live, hourly: rate / interval.hours });
            });

            if (universeActive) {
                // Rute LOCAL ARBITRAGE harus bisa dieksekusi di KETIGA venue:
                // coin lolos universe (mapping + liquidity) DAN funding rate
                // ketiganya sedang tersedia.
                if (!local || rates.length < exchanges.length) continue;
            } else if (rates.length < 2) {
                // Mode ALL: butuh minimal 2 exchange untuk membentuk rute long/short.
                continue;
            }

            // Rute dipilih dari rate per-jam: LONG di venue yang paling murah
            // (atau paling menguntungkan), SHORT di venue yang paling mahal.
            rates.sort((a, b) => a.hourly - b.hourly);
            const lowest = rates[0];
            const highest = rates[rates.length - 1];

            // Spread ditampilkan per periode funding rute (= interval terpanjang
            // dari dua leg). Bila kedua leg 8 jam, sama dengan selisih rate mentah.
            const fundingPeriodHours = Math.max(lowest.hours, highest.hours);
            const spreadPct = (highest.hourly - lowest.hourly) * fundingPeriodHours * 100;
            if (spreadPct < minSpreadThreshold) continue;

            // Data book NYATA untuk dua venue rute (bukan simulasi hash).
            const routeVenues = [lowest.ex, highest.ex];
            const stats = universeApi && typeof universeApi.getMarketStats === 'function'
                ? universeApi.getMarketStats(local ? local.base : coin, routeVenues) : null;
            const spreadKnown = Boolean(stats && Number.isFinite(stats.spreadBps));
            const volumeKnown = Boolean(stats && Number.isFinite(stats.minTurnover) && stats.minTurnover > 0);
            const spreadBps = spreadKnown ? stats.spreadBps : FALLBACK_SPREAD_BPS;
            const depth = volumeKnown ? stats.minTurnover : FALLBACK_TURNOVER;
            const costBasis = spreadKnown && volumeKnown ? 'live' : 'fallback';

            const volume = local ? (Number(local.minTurnover) || 0) : (volumeKnown ? stats.minTurnover : 0);
            const oi = local
                ? (Number.isFinite(local.openInterestUsd) ? local.openInterestUsd : null)
                : (stats && Number.isFinite(stats.openInterestUsd) ? stats.openInterestUsd : null);
            const bidAskSpreadPct = spreadBps / 100;
            // Biaya per SATU fill: setengah spread + dampak ukuran vs volume 24 jam.
            const slippagePct = computeFillCostPct(universeApi, spreadBps, depth, posSize);
            // Kualitas book: spread 0% -> 100, spread 1% -> 0.
            const stability = Math.max(0, Math.min(100, Math.round(100 - bidAskSpreadPct * 100)));
            const liquidityScore = volumeKnown && universeApi ? universeApi.liquidityScore(depth) : 50;
            const premiumTrend = null; // butuh riwayat funding; tidak disimulasikan

            if (volumeKnown && volume < minVol) continue;
            if (oi !== null && oi < minOI) continue;
            if (stability < minStability) continue;
            if (bidAskSpreadPct > maxBidAsk) continue;
            if (slippagePct > maxSlippage) continue;

            // AI Opportunity Score — semua input berasal dari data pasar nyata
            // (spread funding, liquidity, kualitas book, volume, OI). Input yang
            // tidak tersedia diberi nilai netral 50, bukan angka acak.
            // Spread 30%, Liquidity 25%, Book 20%, Volume 15%, OI 5%, Venue 5%.
            const spreadScore = Math.min(100, (spreadPct / 0.5) * 100);
            const volScore = volumeKnown ? Math.min(100, (volume / 1_000_000_000) * 100) : 50;
            const oiScore = oi === null ? liquidityScore : Math.min(100, (oi / 200_000_000) * 100);
            const aiScore = Math.round(
                (spreadScore * 0.30) +
                (liquidityScore * 0.25) +
                (stability * 0.20) +
                (volScore * 0.15) +
                (oiScore * 0.05) +
                (EXCHANGE_RISK_SCORE * 0.05)
            );

            if (aiScore < minScore) continue;

            // Grading
            let grade = 'Avoid';
            let gradeClass = 'arb-grade-avoid';
            if (aiScore >= 95) { grade = 'A+'; gradeClass = 'arb-grade-a-plus'; }
            else if (aiScore >= 90) { grade = 'A'; gradeClass = 'arb-grade-a'; }
            else if (aiScore >= 80) { grade = 'B+'; gradeClass = 'arb-grade-b-plus'; }
            else if (aiScore >= 70) { grade = 'B'; gradeClass = 'arb-grade-b'; }

            const economics = estimateRoute({
                posSize,
                leverage,
                longLeg: { ex: lowest.ex, rate: lowest.rate, hours: lowest.hours, takerFee: ArbitrageScanner.getTakerFee(lowest.ex) },
                shortLeg: { ex: highest.ex, rate: highest.rate, hours: highest.hours, takerFee: ArbitrageScanner.getTakerFee(highest.ex) },
                fillCostPct: slippagePct
            });

            results.push(Object.assign({
                coin,
                ratesObj: Object.fromEntries(rates.map((r) => [r.ex, r.rate])),
                ratesAsc: rates.slice(),
                longEx: lowest.ex,
                shortEx: highest.ex,
                neutralEx: rates.length > 2 ? rates[1].ex : null,
                spreadPct,
                fundingPeriodHours,
                intervalAssumed: !(lowest.intervalLive && highest.intervalLive),
                costBasis,
                aiScore,
                grade,
                gradeClass,
                stability,
                liquidityScore,
                slippagePct,
                volume,
                openInterest: oi,
                bidAskSpreadPct,
                premiumTrend,
                local: Boolean(local),
                pair: local ? local.pair : `${coin}USDT`,
                symbols: local ? Object.assign({}, local.symbols) : null,
                minTurnover: local ? local.minTurnover : null,
                confidence: aiScore
            }, economics));
        }

        // Sort priority: Net Profit > AI Score > Volume 24h > Spread > Stability > Liquidity
        // Users want to see the highest profit opportunities first; volume futures
        // 24h dipakai sebagai pemecah seri supaya coin paling likuid naik duluan.
        results.sort((a, b) => {
            if (b.netProfit !== a.netProfit) return b.netProfit - a.netProfit;
            if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
            if (b.volume !== a.volume) return b.volume - a.volume;
            if (b.spreadPct !== a.spreadPct) return b.spreadPct - a.spreadPct;
            if (b.stability !== a.stability) return b.stability - a.stability;
            return b.liquidityScore - a.liquidityScore;
        });

        return {
            rows: results,
            meta: {
                filterMode,
                intervalPreset,
                intervalHours,
                posSize,
                leverage,
                liveSources: ArbitrageScanner.getSupportedExchanges()
                    .filter((ex) => ArbitrageScanner.getSourceStatus()[ex] === 'live').length,
                demoMode: ArbitrageScanner.isDemoData(),
                universeMode: opts.universe || ArbitrageScanner.getUniverseMode(),
                universeActive,
                universe
            }
        };
    }

    function strategyControls() {
        return {
            universe: 'ALL',
            filterMode: readDomValue('arb-filter-mode', 'Aggressive'),
            search: readDomValue('arb-search', ''),
            intervalPreset: readDomValue('arb-interval-preset', '1H'),
            leverage: Number(readDomValue('arb-leverage', DEFAULT_LEVERAGE))
        };
    }

    function localControls() {
        return {
            universe: 'LOCAL',
            filterMode: readDomValue('local-filter-mode', null) || readDomValue('arb-filter-mode', 'Aggressive'),
            search: readDomValue('local-search', null) !== null ? readDomValue('local-search', '') : readDomValue('arb-search', ''),
            intervalPreset: readDomValue('local-interval-preset', null) || readDomValue('arb-interval-preset', '1H'),
            leverage: Number(readDomValue('local-leverage', null) || readDomValue('arb-leverage', DEFAULT_LEVERAGE))
        };
    }

    function renderSources() {
        const status = ArbitrageScanner.getSourceStatus();
        const html = ArbitrageScanner.getSupportedExchanges().map((ex) => {
            const state = status[ex] || 'idle';
            const pairs = Object.keys(ArbitrageScanner.getExchangeData(ex)).length;
            const detail = state === 'live' ? `${pairs} pair`
                : state === 'demo' ? 'simulasi'
                    : state === 'error' ? 'offline' : 'menunggu';
            const label = state === 'error' ? `API ${ex} tidak terjangkau` : `${ex} — ${detail}`;
            return `<span class="arb-source arb-source-${state}" title="${label}">` +
                `<span class="arb-source-dot"></span>` +
                `<span class="arb-source-name">${ex}</span>` +
                `<span class="arb-source-count">${detail}</span>` +
                `</span>`;
        }).join('');

        // Dua modal punya chip sendiri — isi keduanya dari status yang sama.
        ['arb-sources', 'local-sources'].forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.innerHTML !== html) el.innerHTML = html;
        });

        const demoTitle = ArbitrageScanner.isDemoData()
            ? ArbitrageScanner.getSupportedExchanges()
                .map((ex) => `${ex}: ${ArbitrageScanner.getSourceErrors()[ex] || 'tidak terjangkau'}`)
                .join(' | ')
            : '';
        ['arb-demo-flag', 'local-demo-flag'].forEach((id) => {
            const demoFlag = document.getElementById(id);
            if (demoFlag) {
                demoFlag.hidden = !ArbitrageScanner.isDemoData();
                if (ArbitrageScanner.isDemoData()) demoFlag.title = demoTitle;
            }
        });
    }

    // Format ringkas untuk angka besar (volume/turnover 24 jam).
    function formatCompactUsd(value) {
        const abs = Math.abs(Number(value) || 0);
        if (abs >= 1e9) return '$' + (abs / 1e9).toFixed(2) + 'B';
        if (abs >= 1e6) return '$' + (abs / 1e6).toFixed(1) + 'M';
        if (abs >= 1e3) return '$' + (abs / 1e3).toFixed(1) + 'K';
        return '$' + abs.toFixed(0);
    }

    function formatAge(ms) {
        if (!Number.isFinite(ms) || ms < 0) return '—';
        const secs = Math.floor(ms / 1000);
        if (secs < 60) return `${secs}s lalu`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ${secs % 60}s lalu`;
        return `${Math.floor(mins / 60)}j ${mins % 60}m lalu`;
    }

    /**
     * Panel LOCAL ARBITRAGE: jumlah + funnel + daftar coin hasil dynamic
     * intersection, supaya hasilnya bisa diverifikasi langsung (bukan angka gaib).
     */
    function renderUniverse(meta) {
        const panel = document.getElementById('arb-universe-panel');
        if (!panel) return;
        panel.hidden = false;

        const summaryEl = document.getElementById('arb-universe-summary');
        const funnelEl = document.getElementById('arb-universe-funnel');
        const coinsEl = document.getElementById('arb-universe-coins');
        const warnEl = document.getElementById('arb-universe-warning');
        const toggleBtn = document.getElementById('arb-universe-toggle');

        const mode = meta.universeMode || 'LOCAL';
        if (mode !== 'LOCAL') {
            if (summaryEl) {
                summaryEl.textContent = 'Mode ALL — semua coin yang punya funding rate di minimal 2 venue '
                    + '(universe LOCAL ARBITRAGE dinonaktifkan).';
            }
            if (funnelEl) funnelEl.textContent = '';
            if (coinsEl) coinsEl.innerHTML = '';
            if (warnEl) { warnEl.hidden = true; warnEl.textContent = ''; }
            if (toggleBtn) toggleBtn.hidden = true;
            return;
        }

        const snapshot = meta.universe;
        if (!snapshot) {
            if (summaryEl) {
                summaryEl.textContent = 'LOCAL ARBITRAGE — universe sedang dimuat dari Binance · OKX · Bybit. '
                    + 'Sementara itu scan memakai semua coin funding (fallback).';
            }
            if (funnelEl) funnelEl.textContent = '';
            if (coinsEl) coinsEl.innerHTML = '';
            if (toggleBtn) toggleBtn.hidden = true;
            if (warnEl) {
                const universeApi = typeof window !== 'undefined' ? window.MarketUniverse : null;
                const error = universeApi ? universeApi.getSnapshot().error : null;
                warnEl.hidden = !error;
                warnEl.textContent = error ? `Universe: ${error}` : '';
            }
            return;
        }

        const c = snapshot.counts || {};
        const rejected = c.rejected || {};
        const coinCount = (snapshot.coins || []).length;

        if (summaryEl) {
            summaryEl.textContent = `LOCAL ARBITRAGE — ${coinCount} coin hasil intersection `
                + `Top ${snapshot.universeMax} volume futures 24h ∩ Binance·OKX·Bybit `
                + `(min vol ${formatCompactUsd(snapshot.minTurnover)}/venue, `
                + `max spread ${snapshot.maxSpreadBps} bps) · refresh ${formatAge(snapshot.ageMs)} `
                + `· auto tiap ${Math.round(snapshot.refreshIntervalMs / 60000)} menit`;
        }
        if (funnelEl) {
            funnelEl.textContent = `Funnel: kandidat ${c.candidates || 0} → Top ${snapshot.universeMax} ${c.topUniverse || 0} `
                + `→ 3 venue ${c.inAllVenues || 0} → harga ${c.withPrice || 0} → funding ${c.withFunding || 0} `
                + `→ mapping benar ${c.symbolAligned || 0} → lolos liquidity ${coinCount} `
                + `(spot chart ${c.spotChart || 0}) · ditolak: venue ${rejected.missingVenue || 0}, `
                + `harga ${rejected.noPrice || 0}, funding ${rejected.noFunding || 0}, `
                + `mapping ${rejected.symbolMismatch || 0}, volume ${rejected.lowLiquidity || 0}, `
                + `spread ${rejected.wideSpread || 0}`;
        }
        if (warnEl) {
            const warn = snapshot.error || (snapshot.phase === 'error' ? 'Universe gagal dimuat dari exchange.' : '');
            warnEl.hidden = !warn;
            warnEl.textContent = warn ? `Universe: ${warn}` : '';
        }
        if (toggleBtn) {
            toggleBtn.hidden = coinCount === 0;
            const expanded = coinsEl && !coinsEl.hidden;
            toggleBtn.textContent = expanded
                ? `Sembunyikan daftar ${coinCount} coin`
                : `Tampilkan daftar ${coinCount} coin`;
        }
        if (coinsEl && !coinsEl.hidden) {
            const html = (snapshot.coins || []).map((entry) => {
                const symbolTitle = `Binance ${entry.symbols.Binance} · OKX ${entry.symbols.OKX} · Bybit ${entry.symbols.Bybit}`
                    + ` · funding ${Object.keys(entry.funding).map((venue) => `${venue} ${(entry.funding[venue] * 100).toFixed(4)}%`).join(' | ')}`
                    + `${entry.spotChart ? '' : ' · chart spot tidak tersedia'}`;
                return `<span class="arb-universe-coin" title="${safeAttr(symbolTitle)}">`
                    + `<b>${safeSymbol(entry.base)}</b>`
                    + `<span class="arb-universe-coin-vol">${formatCompactUsd(entry.minTurnover)}</span>`
                    + `</span>`;
            }).join('');
            if (coinsEl.innerHTML !== html) coinsEl.innerHTML = html;
        }
    }

    function buildEmptyState(meta) {
        if (meta.universeMode === 'LOCAL' && meta.universe && meta.universe.coins.length === 0) {
            const rejected = (meta.universe.counts || {}).rejected || {};
            return `<div class="arb-empty-state">LOCAL ARBITRAGE: belum ada coin yang lolos intersection.
                Universe Top ${meta.universe.universeMax} ∩ Binance·OKX·Bybit menghasilkan 0 coin
                (ditolak: venue ${rejected.missingVenue || 0}, harga ${rejected.noPrice || 0},
                funding ${rejected.noFunding || 0}, mapping ${rejected.symbolMismatch || 0},
                volume ${rejected.lowLiquidity || 0}, spread ${rejected.wideSpread || 0}).
                Turunkan <b>Min Vol 24h</b>/<b>Max Spread</b> atau naikkan <b>Top N</b>.</div>`;
        }
        if (meta.liveSources < 2 && !meta.demoMode) {
            return `<div class="arb-empty-state">Butuh data live dari minimal 2 exchange.
                Live sekarang: ${meta.liveSources}/3 (Binance, OKX, Bybit) — API exchange tertentu bisa diblokir oleh jaringan/region kamu.</div>`;
        }
        const prefix = meta.demoMode ? 'Data simulasi — ' : '';
        const scope = meta.universeActive
            ? ` dari ${meta.universe ? meta.universe.coins.length : 0} coin universe LOCAL ARBITRAGE`
            : '';
        return `<div class="arb-empty-state">${prefix}Tidak ada peluang${scope} yang lolos filter <b>${meta.filterMode}</b>
            untuk posisi ${formatPosSize(meta.posSize)} (interval ${meta.intervalPreset}).
            Coba perkecil pos size, pilih mode <b>Aggressive</b>, atau longgarkan filter.</div>`;
    }

    function renderRates(row) {
        // Selalu tampilkan 3 venue (bila tersedia) supaya terlihat mana yang
        // di-long, mana yang di-short, dan venue netral ikut terpantau.
        return row.ratesAsc.map((entry) => {
            const role = entry.ex === row.longEx ? 'long' : (entry.ex === row.shortEx ? 'short' : 'neutral');
            const roleTag = role === 'long' ? 'LONG' : role === 'short' ? 'SHORT' : '—';
            return `<div class="arb-rate arb-rate-${role}">
                    <span class="arb-ex">${entry.ex.substring(0, 3).toUpperCase()}</span>
                    <span class="${getPctColorClass(entry.rate)}">${formatPct(entry.rate)}</span>
                    <span class="arb-rate-int" title="${entry.intervalLive ? 'Interval funding dari exchange' : 'Interval tidak dilaporkan exchange — diasumsikan 8 jam'}">/${formatHours(entry.hours)}${entry.intervalLive ? '' : '*'}</span>
                    <span class="arb-rate-tag">${roleTag}</span>
                </div>`;
        }).join('');
    }

    /** Grid metrik kartu. LOCAL ARBITRAGE menampilkan angka nyata (Vol/Book). */
    function renderMetrics(row) {
        const profitClass = (value) => (value > 0 ? 'arb-profit-pos' : 'arb-profit-neg');
        const metrics = [
            { label: `Spread / ${formatHours(row.fundingPeriodHours)}`, value: `${row.spreadPct.toFixed(4)}%`, cls: 'arb-spread-val' },
            { label: 'Funding / hari', value: formatUsd(row.dailyFunding), cls: profitClass(row.dailyFunding) },
            { label: 'Biaya buka+tutup', value: formatUsd(row.estCosts) },
            { label: 'Net / funding', value: formatUsd(row.netProfit), cls: profitClass(row.netProfit) },
            { label: 'Net 24 jam', value: formatUsd(row.estDailyProfit), cls: profitClass(row.estDailyProfit) },
            { label: 'ROI / funding', value: formatSignedPct(row.roiPct, 3), cls: profitClass(row.roiPct) },
            { label: 'ROI 24 jam', value: formatSignedPct(row.roiDailyPct, 3), cls: profitClass(row.roiDailyPct) },
            { label: 'ROI 7 hari', value: formatSignedPct(row.roi7dPct, 2), cls: profitClass(row.roi7dPct) },
            { label: 'APR funding', value: `${row.aprPct.toFixed(1)}%`, cls: profitClass(row.aprPct) },
            { label: `Modal (2 leg @${row.leverage}x)`, value: formatUsd(row.capitalUsd) },
            {
                label: 'Break-even',
                value: row.breakevenHours === null ? '&infin;' : `${row.breakevenHours.toFixed(1)} jam`
            },
            { label: 'Fees (taker, PP)', value: formatUsd(row.estFees) },
            { label: 'Slippage / fill', value: `${row.slippagePct.toFixed(3)}%` }
        ];

        if (row.local) {
            // Angka nyata dari universe: volume 24 jam venue terkecil, spread
            // bid/ask terlebar, dan kualitas book (bukan nilai simulasi).
            metrics.push(
                { label: 'Vol 24h (min venue)', value: formatCompactUsd(row.minTurnover) },
                { label: 'Book spread', value: `${row.bidAskSpreadPct.toFixed(4)}%` },
                { label: 'Book quality', value: `${row.stability}/100` },
                { label: 'Liquidity', value: `${row.liquidityScore}/100` },
                { label: 'Open interest', value: row.openInterest === null ? '—' : formatCompactUsd(row.openInterest) }
            );
        } else {
            metrics.push(
                { label: 'Stability', value: `${row.stability}` },
                { label: 'Liquidity', value: `${row.liquidityScore}` }
            );
        }

        return metrics.map((metric) => `<div class="arb-metric-item">
                <span class="arb-metric-label">${metric.label}</span>
                <span class="arb-metric-val ${metric.cls || ''}">${metric.value}</span>
            </div>`).join('');
    }

    /** Catatan jujur soal asumsi/data yang dipakai perhitungan ROI. */
    function renderAssumptionNote(row) {
        const notes = [];
        if (row.intervalAssumed) notes.push('interval funding (*) diasumsikan 8 jam');
        if (row.costBasis === 'fallback') notes.push('data book belum termuat: biaya memakai perkiraan konservatif');
        if (notes.length === 0) return '';
        return `<div class="arb-assumption-note">⚠ ${notes.join(' · ')}</div>`;
    }

    function buildCardsHtml(rows, meta, showLimitRaw) {
        const currentResultsMap = new Map();
        if (rows.length === 0) {
            return { html: buildEmptyState(meta), map: currentResultsMap };
        }
        // Apply Show limit
        const showLimit = showLimitRaw || 'all';
        let renderData = rows;
        if (showLimit !== 'all') {
            const limit = parseInt(showLimit, 10);
            if (!isNaN(limit)) renderData = rows.slice(0, limit);
        }

        const prevMap = ArbitrageScanner.getPreviousResultsMap();
        let html = '';

        renderData.forEach((row) => {
            currentResultsMap.set(row.coin, { rate: row.spreadPct, netProfit: row.netProfit });

            // Compare with previous state
            let indicatorHtml = '';
            const prev = prevMap.get(row.coin);
            if (!prev) {
                indicatorHtml = '<span class="arb-indicator arb-indicator-new">🟢 NEW</span>';
            } else if (Math.abs(prev.netProfit) > 0.000001 && row.netProfit > prev.netProfit + 0.1) {
                const diff = (((row.netProfit - prev.netProfit) / Math.abs(prev.netProfit)) * 100).toFixed(1);
                indicatorHtml = `<span class="arb-indicator arb-indicator-up">🔺 Profit +${diff}%</span>`;
            } else if (Math.abs(prev.netProfit) > 0.000001 && row.netProfit < prev.netProfit - 0.1) {
                const diff = (((prev.netProfit - row.netProfit) / Math.abs(prev.netProfit)) * 100).toFixed(1);
                indicatorHtml = `<span class="arb-indicator arb-indicator-down">🔻 Profit -${diff}%</span>`;
            }

            const coinLabel = safeSymbol(row.coin);
            const pairLabel = safeSymbol(row.pair);
            html += `
                <div class="arb-card">
                    <div class="arb-card-header">
                        <div>
                            <strong>${coinLabel}</strong>
                            <span class="arb-grade-badge ${row.gradeClass}">${row.grade}</span>
                            ${indicatorHtml}
                        </div>
                        <div class="arb-score-container">
                            <span class="arb-score-label">AI Score</span>
                            <span class="arb-score-val">${row.aiScore}/100</span>
                        </div>
                    </div>

                    <div class="arb-card-rates arb-card-rates-multi">
                        ${renderRates(row)}
                    </div>

                    ${row.local ? `<div class="arb-card-symbols" title="Symbol mapping hasil dynamic intersection">`
                        + `BIN ${safeSymbol(row.symbols.Binance)} · OKX ${safeSymbol(row.symbols.OKX)} · BYB ${safeSymbol(row.symbols.Bybit)}`
                        + `</div>` : ''}

                    <div class="arb-card-actions">
                        <div class="arb-action">LONG <span class="arb-badge arb-badge-${row.longEx.toLowerCase()}">${row.longEx}</span></div>
                        <div class="arb-action">SHORT <span class="arb-badge arb-badge-${row.shortEx.toLowerCase()}">${row.shortEx}</span></div>
                        <button type="button" class="arb-open-pair" data-arb-pair="${pairLabel}">Buka chart ${pairLabel}</button>
                    </div>

                    <div class="arb-metric-grid">
                        ${renderMetrics(row)}
                    </div>
                    ${renderAssumptionNote(row)}
                </div>
            `;
        });
        return { html: html, map: currentResultsMap };
    }

    /**
     * Top 3 rekomendasi harian: return tertinggi hari itu (estDailyProfit)
     * dari baris yang SUDAH lolos filter mode aktif (Aggressive / Balanced /
     * Conservative) + universe aktif (ALL / LOCAL). Setiap kartu membawa
     * tombol Buka chart -> openArbitragePair -> user bisa langsung open posisi
     * dari panel Futures Execution.
     */
    function roiTooltip(row) {
        return `ROI dihitung atas modal 2 leg (${formatUsd(row.capitalUsd)} @${row.leverage}x): `
            + `funding/hari ${formatUsd(row.dailyFunding)} (interval ${formatHours(row.fundingPeriodHours)}) `
            + `- biaya buka+tutup ${formatUsd(row.estCosts)} (fee taker ${formatUsd(row.estFees)} + slippage 4 fill). `
            + 'Asumsi: rate funding tetap, harga dua venue konvergen saat ditutup.'
            + (row.intervalAssumed ? ' Interval funding diasumsikan 8 jam.' : '')
            + (row.costBasis === 'fallback' ? ' Biaya book memakai perkiraan konservatif.' : '');
    }

    function buildRecommendationsHtml(rows, meta) {
        const scope = meta.universeActive ? 'Local' : meta.filterMode;
        const title = `Top 3 Rekomendasi Hari Ini · ${scope} · ${meta.intervalPreset}`;
        if (!rows || rows.length === 0) {
            return `<div class="arb-rec-panel"><div class="arb-rec-title">${title}</div>`
                + `<div class="arb-empty-state">Belum ada peluang yang lolos filter — longgarkan mode atau perkecil pos size.</div></div>`;
        }
        const top = rows.slice()
            .sort((a, b) => b.estDailyProfit - a.estDailyProfit)
            .slice(0, 3);
        const medals = ['🥇', '🥈', '🥉'];
        const items = top.map((row, i) => {
            const coinLabel = safeSymbol(row.coin);
            const pairLabel = safeSymbol(row.pair);
            const profitClass = row.estDailyProfit > 0 ? 'arb-profit-pos' : 'arb-profit-neg';
            return `<div class="arb-rec-card">`
                + `<div class="arb-rec-rank">${medals[i] || ('#' + (i + 1))}</div>`
                + `<div class="arb-rec-main">`
                + `<div class="arb-rec-coin"><strong>${coinLabel}</strong>`
                + `<span class="arb-grade-badge ${row.gradeClass}">${row.grade}</span></div>`
                + `<div class="arb-rec-route">LONG <span class="arb-badge arb-badge-${row.longEx.toLowerCase()}">${row.longEx}</span>`
                + ` SHORT <span class="arb-badge arb-badge-${row.shortEx.toLowerCase()}">${row.shortEx}</span></div>`
                + `<div class="arb-rec-numbers"><span class="${profitClass}">${formatUsd(row.estDailyProfit)}/hari</span>`
                + `<span class="arb-metric-label" title="${safeAttr(roiTooltip(row))}">ROI 24j ${formatSignedPct(row.roiDailyPct, 3)}`
                + ` · 7h ${formatSignedPct(row.roi7dPct, 2)} · APR ${row.aprPct.toFixed(0)}% · Skor ${row.aiScore}</span></div>`
                + `</div>`
                + `<button type="button" class="arb-open-pair arb-rec-open" data-arb-pair="${pairLabel}">Buka chart</button>`
                + `</div>`;
        }).join('');
        return `<div class="arb-rec-panel"><div class="arb-rec-title">${title}</div>`
            + `<div class="arb-rec-list">${items}</div></div>`;
    }

    function paintContainer(containerId, html) {
        const container = document.getElementById(containerId);
        if (!container) return;
        if (container.innerHTML !== html) {
            // Test harness: FakeElement tidak punya rAF yang mem-flush sinkron,
            // jadi tulis langsung bila rAF tidak tersedia. Browser tetap pakai rAF.
            if (typeof requestAnimationFrame === 'function' && typeof window !== 'undefined' && window.requestAnimationFrame) {
                requestAnimationFrame(() => {
                    container.innerHTML = html;
                });
            } else {
                try { container.innerHTML = html; } catch (e) {}
                if (typeof requestAnimationFrame === 'function') {
                    try { requestAnimationFrame(() => { container.innerHTML = html; }); } catch (e) {}
                }
            }
        }
    }

    /** Modal 1 — Strategi (Aggressive/Balanced/Conservative, universe ALL). */
    function renderStrategy() {
        const ctrl = strategyControls();
        const found = calculateData(ctrl);
        // Panel universe tinggal di modal lokal; di sini paksa pesan ALL agar
        // tidak ada angka LOCAL yang membingungkan di modal strategi.
        const showLimit = readDomValue('arb-show-limit', 'all');
        const built = buildCardsHtml(found.rows, Object.assign({}, found.meta, { universeMode: 'ALL' }), showLimit);
        paintContainer('arb-cards-container', built.html);
        paintContainer('arb-recommendations', buildRecommendationsHtml(found.rows, found.meta));
        return { rows: found.rows, meta: found.meta, map: built.map };
    }

    /** Modal 2 — Local (universe LOCAL hasil intersection). */
    function renderLocal() {
        const ctrl = localControls();
        const found = calculateData(ctrl);
        renderUniverse(found.meta);
        const showLimit = readDomValue('local-show-limit', 'all');
        const built = buildCardsHtml(found.rows, found.meta, showLimit);
        paintContainer('local-cards-container', built.html);
        paintContainer('local-recommendations', buildRecommendationsHtml(found.rows, found.meta));
        return { rows: found.rows, meta: found.meta, map: built.map };
    }

    function render() {
        renderSources();
        // Render keduanya supaya polling 10 detik menghidupkan dua modal
        // sekaligus; masing-masing modal hanya dibaca saat dibuka.
        // calculateData() tanpa argumen (dipakai unit test) tetap memakai
        // perilaku lama via getUniverseMode, jadi panggil default sekali untuk
        // menjaga previousResultsMap konsisten dengan test.
        let def = null;
        try { def = calculateData(); } catch (e) { def = null; }
        if (def) renderUniverse(def.meta);

        const s = renderStrategy();
        const l = renderLocal();

        // Gabung peta NEW/naik/turun dari kedua modal.
        const merged = new Map();
        if (def) def.rows.forEach((r) => merged.set(r.coin, { rate: r.spreadPct, netProfit: r.netProfit }));
        s.map.forEach((v, k) => merged.set(k, v));
        l.map.forEach((v, k) => merged.set(k, v));
        ArbitrageScanner.setPreviousResultsMap(merged);
        updateCountdown();
    }

    function updateCountdown() {
        const now = new Date();
        const intervalPreset = readDomValue('arb-interval-preset', null)
            || readDomValue('local-interval-preset', null) || '1H';
        const nextFunding = new Date(now);
        nextFunding.setUTCMinutes(0, 0, 0);
        const h = now.getUTCHours();
        if (intervalPreset === '1H') {
            nextFunding.setUTCHours(h + 1);
        } else if (intervalPreset === '4H') {
            nextFunding.setUTCHours(Math.floor(h / 4) * 4 + 4);
        } else {
            // 8H
            if (h < 8) nextFunding.setUTCHours(8);
            else if (h < 16) nextFunding.setUTCHours(16);
            else { nextFunding.setUTCDate(nextFunding.getUTCDate() + 1); nextFunding.setUTCHours(0); }
        }

        const diffMs = nextFunding - now;
        if (diffMs > 0) {
            const hrs = Math.floor(diffMs / 3600000).toString().padStart(2, '0');
            const mins = Math.floor((diffMs % 3600000) / 60000).toString().padStart(2, '0');
            const secs = Math.floor((diffMs % 60000) / 1000).toString().padStart(2, '0');
            ['arb-countdown', 'local-countdown'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.innerText = `Next Funding: ${hrs}:${mins}:${secs}`;
            });
        }

        // Update Data Age
        const lastTime = ArbitrageScanner.getLastFetchTime();
        if (lastTime > 0) {
            const ageSecs = Math.floor((Date.now() - lastTime) / 1000);
            let badgeText = '';
            let badgeColor = '';
            if (ArbitrageScanner.isDemoData()) {
                badgeText = `SIMULASI (${ageSecs}s)`;
                badgeColor = 'var(--color-warning)';
            } else if (ageSecs > 30) {
                badgeText = 'STALE';
                badgeColor = 'var(--color-wrong)';
            } else {
                const live = ArbitrageScanner.getSupportedExchanges()
                    .filter((ex) => ArbitrageScanner.getSourceStatus()[ex] === 'live').length;
                badgeText = live === 3 ? `Live (${ageSecs}s ago)` : `Live ${live}/3 (${ageSecs}s ago)`;
                badgeColor = 'var(--color-correct)';
            }
            ['arb-status-badge', 'local-status-badge'].forEach((id) => {
                const badge = document.getElementById(id);
                if (badge) {
                    badge.innerText = badgeText;
                    badge.style.color = badgeColor;
                }
            });
        }
    }

    setInterval(updateCountdown, 1000);

    return { render, renderStrategy, renderLocal, calculateData, updateCountdown, buildRecommendationsHtml, estimateRoute };
})();
