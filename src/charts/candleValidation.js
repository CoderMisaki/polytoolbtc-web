/* candleValidation.js — pure, DOM-free helpers for the chart boot pipeline.
 * UMD: exposes window.CandleValidation in browsers and module.exports in Node.
 * No dependencies, no randomness, no network. Safe to unit test. */
(function CandleValidationUMD(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.CandleValidation = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildCandleValidation() {
    'use strict';

    const MIN_VALID_CANDLES = 5;
    const MAX_CANDLES = 1500;

    const TF_SECONDS = {
        '1m': 60,
        '5m': 300,
        '15m': 900,
        '30m': 1800,
        '1h': 3600,
        '2h': 7200,
        '4h': 14400,
        '6h': 21600,
        '8h': 28800,
        '12h': 43200,
        '1d': 86400,
        '3d': 259200,
        '1w': 604800,
        '1M': 2592000,
        '1y': 31536000
    };

    function toFiniteNumber(value) {
        const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
        return typeof n === 'number' && Number.isFinite(n) ? n : NaN;
    }

    function coerceTimeToSeconds(raw) {
        const n = toFiniteNumber(raw);
        if (!Number.isFinite(n) || n <= 0) return NaN;
        // Binance klines return open time in ms; lightweight-charts wants seconds.
        const seconds = n > 1e12 ? n / 1000 : (n > 1e10 ? n / 1000 : n);
        return Math.floor(seconds);
    }

    function normalizeRow(row) {
        let timeRaw, openRaw, highRaw, lowRaw, closeRaw, volRaw, takerRaw;
        if (Array.isArray(row)) {
            timeRaw = row[0]; openRaw = row[1]; highRaw = row[2];
            lowRaw = row[3]; closeRaw = row[4]; volRaw = row[5]; takerRaw = row[9];
        } else if (row && typeof row === 'object') {
            timeRaw = row.time !== undefined ? row.time : row.t;
            openRaw = row.open !== undefined ? row.open : row.o;
            highRaw = row.high !== undefined ? row.high : row.h;
            lowRaw = row.low !== undefined ? row.low : row.l;
            closeRaw = row.close !== undefined ? row.close : row.c;
            volRaw = row.vol !== undefined ? row.vol : (row.v !== undefined ? row.v : row.volume);
            takerRaw = row.takerVol !== undefined ? row.takerVol : row.takerBuyVol;
        } else {
            return { ok: false, reason: 'row-not-object' };
        }

        const time = coerceTimeToSeconds(timeRaw);
        const open = toFiniteNumber(openRaw);
        const high = toFiniteNumber(highRaw);
        const low = toFiniteNumber(lowRaw);
        const close = toFiniteNumber(closeRaw);
        let vol = toFiniteNumber(volRaw);
        let takerVol = toFiniteNumber(takerRaw);

        if (!Number.isFinite(time) || time <= 0) return { ok: false, reason: 'bad-time' };
        if (!Number.isFinite(open) || !Number.isFinite(high) ||
            !Number.isFinite(low) || !Number.isFinite(close)) {
            return { ok: false, reason: 'bad-ohlc' };
        }
        if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
            return { ok: false, reason: 'non-positive-price' };
        }
        if (!Number.isFinite(vol) || vol < 0) vol = 0;
        if (!Number.isFinite(takerVol) || takerVol < 0) takerVol = 0;
        // Clamp taker-buy volume: it can never exceed total volume.
        if (takerVol > vol) takerVol = vol;

        let hi = high;
        let lo = low;
        if (hi < lo) { const tmp = hi; hi = lo; lo = tmp; }
        // Enforce OHLC consistency so downstream math never sees inverted ranges.
        hi = Math.max(hi, open, close);
        lo = Math.min(lo, open, close);

        return {
            ok: true,
            candle: { time: time, open: open, high: hi, low: lo, close: close, vol: vol, takerVol: takerVol }
        };
    }

    /**
     * Validate + normalize raw klines into lightweight-charts-ready candles.
     * - drops invalid rows (counts reasons)
     * - dedupes duplicate timestamps (keeps LAST occurrence)
     * - sorts ascending by time
     * - bounds total length
     */
    function validateAndNormalizeCandles(raw) {
        const issues = { dropped: 0, duplicates: 0, reasons: {} };
        const byTime = new Map();
        const input = Array.isArray(raw) ? raw : [];

        for (let i = 0; i < input.length; i++) {
            const out = normalizeRow(input[i]);
            if (!out.ok) {
                issues.dropped++;
                issues.reasons[out.reason] = (issues.reasons[out.reason] || 0) + 1;
                continue;
            }
            if (byTime.has(out.candle.time)) issues.duplicates++;
            byTime.set(out.candle.time, out.candle);
        }

        let candles = Array.from(byTime.values()).sort(function (a, b) { return a.time - b.time; });
        if (candles.length > MAX_CANDLES) {
            const overflow = candles.length - MAX_CANDLES;
            issues.dropped += overflow;
            issues.reasons['overflow-trim'] = overflow;
            candles = candles.slice(-MAX_CANDLES);
        }

        const valid = candles.length >= MIN_VALID_CANDLES;
        return {
            valid: valid,
            candles: candles,
            count: candles.length,
            dropped: issues.dropped,
            duplicates: issues.duplicates,
            reasons: issues.reasons,
            minRequired: MIN_VALID_CANDLES
        };
    }

    function tfToSeconds(tf) {
        return TF_SECONDS[tf] || 900;
    }

    /**
     * Freshness check: the most recent candle must not be too stale.
     * Allows `toleranceCandles` worth of drift (default 3) plus a fixed margin.
     */
    function checkDataFreshness(candles, tf, nowMs, toleranceCandles) {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        if (!Array.isArray(candles) || candles.length === 0) {
            return { fresh: false, stale: true, reason: 'NO_DATA', ageMs: Infinity, lastTime: 0 };
        }
        const last = candles[candles.length - 1];
        const intervalMs = tfToSeconds(tf) * 1000;
        const tolerance = (Number.isFinite(toleranceCandles) ? toleranceCandles : 3) * intervalMs + 60 * 1000;
        const ageMs = now - last.time * 1000;
        const stale = !(ageMs >= -5 * 60 * 1000) || ageMs > tolerance;
        return {
            fresh: !stale,
            stale: stale,
            reason: stale ? 'STALE' : 'FRESH',
            ageMs: ageMs,
            lastTime: last.time,
            toleranceMs: tolerance
        };
    }

    function isValidLayoutSize(w, h) {
        return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
    }

    /**
     * Monotonic session guard: prevents stale async responses from a previous
     * pair/timeframe/boot from overwriting the current state.
     */
    function createSessionGuard() {
        let current = 0;
        return {
            next: function () { current += 1; return current; },
            current: function () { return current; },
            isCurrent: function (token) { return token === current; },
            invalidate: function () { current += 1; return current; }
        };
    }

    function computeRetryDelayMs(retryCount) {
        const n = Math.max(1, Math.floor(retryCount) || 1);
        return Math.min(3000 * n, 15000);
    }

    return {
        MIN_VALID_CANDLES: MIN_VALID_CANDLES,
        MAX_CANDLES: MAX_CANDLES,
        validateAndNormalizeCandles: validateAndNormalizeCandles,
        checkDataFreshness: checkDataFreshness,
        isValidLayoutSize: isValidLayoutSize,
        createSessionGuard: createSessionGuard,
        computeRetryDelayMs: computeRetryDelayMs,
        tfToSeconds: tfToSeconds
    };
});
