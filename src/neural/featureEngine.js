/* featureEngine.js — market-derived neural input features.
 * Uses ONLY real project data (OHLCV, computed indicators, MTF state).
 * No synthetic sentiment, no fictional data. Deterministic + node-testable.
 * UMD: window.NeuralFeatureEngine in browsers, module.exports in Node.
 */
(function FeatureEngineUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.NeuralFeatureEngine = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildFeatureEngine(root) {
    'use strict';

    const MIN_CANDLES = 30;    // minimum for a degraded/partial read
    const FULL_CANDLES = 200;  // full indicator coverage (EMA200 etc.)

    function core() {
        if (root && root.NeuralCore) return root.NeuralCore;
        if (typeof NeuralCore !== 'undefined') return NeuralCore;
        try {
            if (typeof require === 'function') return require('./neuralCore');
        } catch (e) { /* browser without core yet */ }
        return null;
    }

    function marketPhysics() {
        if (root && root.MarketPhysics) return root.MarketPhysics;
        if (typeof MarketPhysics !== 'undefined') return MarketPhysics;
        try {
            if (typeof require === 'function') return require('./marketPhysics');
        } catch (e) { /* optional bounded risk model */ }
        return null;
    }

    function num(value, fallback) {
        const fb = Number.isFinite(fallback) ? fallback : 0;
        return Number.isFinite(value) ? value : fb;
    }

    function clamp01(x) {
        if (!Number.isFinite(x)) return 0;
        if (x < 0) return 0;
        if (x > 1) return 1;
        return x;
    }

    function clamp11(x) {
        if (!Number.isFinite(x)) return 0;
        if (x < -1) return -1;
        if (x > 1) return 1;
        return x;
    }

    function soft(x) {
        if (!Number.isFinite(x)) return 0;
        return x / (1 + Math.abs(x));
    }

    function mtfToNum(v) {
        if (v === 'UP') return 1;
        if (v === 'DOWN') return -1;
        return 0;
    }

    function indValue(series, idx) {
        if (!Array.isArray(series) || idx < 0 || idx >= series.length) return NaN;
        const p = series[idx];
        if (p === null || p === undefined) return NaN;
        if (typeof p === 'number') return p;
        if (typeof p.value === 'number') return p.value;
        return NaN;
    }

    /**
     * Extract normalized features ending at candle `index` (default: last).
     * snapshot: { candles, indicators, volSMA, atrSMA, swings, mtf, index }
     */
    function extract(snapshot) {
        const missing = [];
        const snap = snapshot || {};
        const candles = Array.isArray(snap.candles) ? snap.candles : [];
        const ind = snap.indicators || {};
        const volSMA = Array.isArray(snap.volSMA) ? snap.volSMA : [];
        const atrSMA = Array.isArray(snap.atrSMA) ? snap.atrSMA : [];
        const swings = snap.swings || { highs: [], lows: [] };
        const mtf = snap.mtf || {};
        // Wide-context pattern features (patternMemory.js). They are optional:
        // without a corpus every key degrades to 0, which is exactly the
        // "no evidence" value the agents expect.
        const patternFeatures = snap.patternFeatures || null;
        function patNum(key) {
            if (!patternFeatures) return 0;
            const v = patternFeatures[key];
            return Number.isFinite(v) ? v : 0;
        }

        const n = candles.length;
        if (n < MIN_CANDLES) {
            return { ok: false, reason: 'INSUFFICIENT_DATA', count: n, minRequired: MIN_CANDLES, coverage: n / FULL_CANDLES, features: null, missing: ['candles'] };
        }

        let idx = Number.isFinite(snap.index) ? Math.floor(snap.index) : n - 1;
        if (idx < 0) idx = 0;
        if (idx >= n) idx = n - 1;
        if (idx < MIN_CANDLES - 1) {
            return { ok: false, reason: 'INDEX_TOO_EARLY', count: n, minRequired: MIN_CANDLES, coverage: n / FULL_CANDLES, features: null, missing: ['index'] };
        }

        const c = candles[idx];
        if (!c || !Number.isFinite(c.close) || c.close <= 0) {
            return { ok: false, reason: 'BAD_LAST_CANDLE', count: n, coverage: n / FULL_CANDLES, features: null, missing: ['close'] };
        }

        const atr = num(atrSMA[idx], Math.max(c.high - c.low, c.close * 0.0005));
        const atrSafe = atr > 0 ? atr : c.close * 0.001;
        const volAvg = num(volSMA[idx], c.vol);

        function closeAt(offset) {
            const j = idx - offset;
            if (j < 0) return NaN;
            const cc = candles[j];
            return cc && Number.isFinite(cc.close) ? cc.close : NaN;
        }

        function ret(offset) {
            const a = closeAt(0);
            const b = closeAt(offset);
            if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return 0;
            return (a - b) / atrSafe;
        }

        const range = Math.max(c.high - c.low, 1e-12);
        const body = (c.close - c.open) / range;
        const upperWick = (c.high - Math.max(c.open, c.close)) / range;
        const lowerWick = (Math.min(c.open, c.close) - c.low) / range;

        let bodySum = 0;
        let bodyN = 0;
        for (let k = 0; k < 5 && idx - k >= 0; k++) {
            const cc = candles[idx - k];
            const r = Math.max(cc.high - cc.low, 1e-12);
            if (Number.isFinite(cc.close) && Number.isFinite(cc.open)) {
                bodySum += (cc.close - cc.open) / r;
                bodyN++;
            }
        }

        const v = num(c.vol, 0);
        const volChange = volAvg > 0 ? (v / volAvg - 1) : 0;
        const volAnomaly = volAvg > 0 ? v / volAvg : 1;
        const takerVol = num(c.takerVol, v * 0.5);
        const takerImb = v > 0 ? clamp11((takerVol / v - 0.5) * 2) : 0;

        const rsi14 = indValue(ind.rsi, idx);
        const rsi21 = indValue(ind.rsi21, idx);
        const e21 = indValue(ind.e21, idx);
        const e55 = indValue(ind.e55, idx);
        const e200 = indValue(ind.e200, idx);
        const stochK = indValue(ind.stochK, idx);
        const stochD = indValue(ind.stochD, idx);
        const wr = indValue(ind.wr, idx);
        const adx = indValue(ind.adx, idx);
        const mfi = indValue(ind.mfi, idx);
        const volosc = indValue(ind.volosc, idx);

        let macdHist = NaN;
        let macdLine = NaN;
        let macdSignal = NaN;
        if (Array.isArray(ind.macd) && ind.macd[idx]) {
            macdHist = num(ind.macd[idx].value, NaN);
            macdLine = num(ind.macd[idx].macd, NaN);
            macdSignal = num(ind.macd[idx].signal, NaN);
        }

        let stTrend = 0;
        if (Array.isArray(ind.st) && ind.st[idx] && Number.isFinite(ind.st[idx].trend)) {
            stTrend = ind.st[idx].trend >= 0 ? 1 : -1;
        }

        let bbPos = 0.5;
        let bbWidth = 0;
        if (Array.isArray(ind.bb) && ind.bb[idx]) {
            const upper = num(ind.bb[idx].upper, NaN);
            const lower = num(ind.bb[idx].lower, NaN);
            if (Number.isFinite(upper) && Number.isFinite(lower) && upper > lower) {
                bbPos = clamp01((c.close - lower) / (upper - lower));
                bbWidth = (upper - lower) / Math.max(c.close, 1e-12);
            } else {
                missing.push('bb');
            }
        } else {
            missing.push('bb');
        }

        let linregSlope = 0;
        if (Array.isArray(ind.linreg) && ind.linreg[idx]) {
            linregSlope = num(ind.linreg[idx].slope, 0);
        }

        let obvSlope = 0;
        if (Array.isArray(ind.obv) && idx >= 5) {
            const a = indValue(ind.obv, idx);
            const b = indValue(ind.obv, idx - 5);
            if (Number.isFinite(a) && Number.isFinite(b)) obvSlope = soft((a - b) / Math.max(v * 5, 1e-9));
        }
        let cvdImb = 0;
        if (Array.isArray(ind.cvd) && idx >= 5) {
            const a = indValue(ind.cvd, idx);
            const b = indValue(ind.cvd, idx - 5);
            if (Number.isFinite(a) && Number.isFinite(b)) cvdImb = clamp11(soft((a - b) / Math.max(v * 5, 1e-9)) * 3);
        }

        let psarSide = 0;
        if (Array.isArray(ind.psar) && ind.psar[idx] && Number.isFinite(ind.psar[idx].value)) {
            psarSide = c.close >= ind.psar[idx].value ? 1 : -1;
        }

        // Swing distances from most recent confirmed swing before/at idx.
        let distHigh = 0;
        let distLow = 0;
        if (Array.isArray(swings.highs)) {
            for (let i = swings.highs.length - 1; i >= 0; i--) {
                const s = swings.highs[i];
                if (s && Number.isFinite(s.time) && s.time <= c.time && Number.isFinite(s.val)) {
                    distHigh = (s.val - c.close) / atrSafe;
                    break;
                }
            }
        }
        if (Array.isArray(swings.lows)) {
            for (let i = swings.lows.length - 1; i >= 0; i--) {
                const s = swings.lows[i];
                if (s && Number.isFinite(s.time) && s.time <= c.time && Number.isFinite(s.val)) {
                    distLow = (c.close - s.val) / atrSafe;
                    break;
                }
            }
        }

        const mom10 = ret(10);
        const mom5 = ret(5);
        const momentum = soft(mom10 / 4);
        const acceleration = soft((mom10 - ret(15)) / 4 - 0);

        // Physics-derived features are deliberately bounded and optional. The
        // model only reads candles through `idx`; if it is unavailable or has
        // too little history every value degrades to the neutral zero rather
        // than manufacturing confidence.
        let physics = null;
        try {
            const Physics = marketPhysics();
            if (Physics && typeof Physics.analyze === 'function') {
                physics = Physics.analyze({ candles: candles, index: idx });
            }
        } catch (e) { physics = null; }
        const physicsFeatures = physics && physics.ok && physics.features
            ? physics.features
            : {};
        function physicsNum(key) {
            return clamp11(Number.isFinite(physicsFeatures[key]) ? physicsFeatures[key] : 0);
        }

        const features = {
            ret1: soft(ret(1)),
            ret5: soft(ret(5) / 2),
            ret20: soft(ret(20) / 4),
            body: clamp11(body),
            bodyAvg5: bodyN > 0 ? clamp11(bodySum / bodyN) : 0,
            upperWick: clamp01(upperWick),
            lowerWick: clamp01(lowerWick),
            rangeAtr: clamp01((c.high - c.low) / (atrSafe * 4)),
            volChange: soft(volChange),
            volAnomaly: clamp01(volAnomaly / 3),
            volatility: clamp01(atrSafe / Math.max(c.close, 1e-12) * 60),
            takerImb: takerImb,
            rsi14n: Number.isFinite(rsi14) ? clamp11((rsi14 - 50) / 50) : 0,
            rsi21n: Number.isFinite(rsi21) ? clamp11((rsi21 - 50) / 50) : 0,
            emaD21: Number.isFinite(e21) ? soft((c.close - e21) / atrSafe / 3) : 0,
            emaD55: Number.isFinite(e55) ? soft((c.close - e55) / atrSafe / 3) : 0,
            emaD200: Number.isFinite(e200) ? soft((c.close - e200) / atrSafe / 3) : 0,
            macdHistN: Number.isFinite(macdHist) ? soft(macdHist / atrSafe * 2) : 0,
            macdBull: Number.isFinite(macdLine) && Number.isFinite(macdSignal) ? (macdLine >= macdSignal ? 1 : -1) : 0,
            momentum: momentum,
            acceleration: clamp11(acceleration),
            stochKn: Number.isFinite(stochK) ? clamp11((stochK - 50) / 50) : 0,
            stochDn: Number.isFinite(stochD) ? clamp11((stochD - 50) / 50) : 0,
            wrN: Number.isFinite(wr) ? clamp11((wr + 50) / 50) : 0,
            bbPos: clamp01(bbPos),
            bbWidth: clamp01(bbWidth * 25),
            supertrend: stTrend,
            adxN: Number.isFinite(adx) ? clamp01(adx / 50) : 0,
            mfiN: Number.isFinite(mfi) ? clamp11((mfi - 50) / 50) : 0,
            voloscN: Number.isFinite(volosc) ? soft(volosc / 50) : 0,
            linregSlopeN: soft(linregSlope / atrSafe * 10),
            obvSlopeN: clamp11(obvSlope),
            cvdImb: cvdImb,
            psarSide: psarSide,
            distSwingHigh: soft(distHigh / 3),
            distSwingLow: soft(distLow / 3),
            mtf15m: mtfToNum(mtf['15m']),
            mtf1h: mtfToNum(mtf['1h']),
            mtf1d: mtfToNum(mtf['1d']),
            // Bounded diffusion/jump/liquidity model from completed OHLCV.
            physicsDrift: physicsNum('physicsDrift'),
            physicsTrend: physicsNum('physicsTrend'),
            physicsMeanReversion: physicsNum('physicsMeanReversion'),
            physicsVolatility: physicsNum('physicsVolatility'),
            physicsJumpRisk: physicsNum('physicsJumpRisk'),
            physicsTailRisk: physicsNum('physicsTailRisk'),
            physicsLiquidity: physicsNum('physicsLiquidity'),
            physicsImpact: physicsNum('physicsImpact'),
            physicsConfidence: physicsNum('physicsConfidence'),
            // Wide-context pattern channels (days/weeks worth of history).
            patAnalogBias: clamp11(patNum('patAnalogBias')),
            patAnalogEdge: clamp01(patNum('patAnalogEdge')),
            patHourBias: clamp11(patNum('patHourBias')),
            patMinuteBias: clamp11(patNum('patMinuteBias')),
            patDayBias: clamp11(patNum('patDayBias')),
            patMotifBias: clamp11(patNum('patMotifBias')),
            patSamples: clamp01(patNum('patSamples')),
            patAlignment: clamp11(patNum('patAlignment'))
        };

        const coverage = Math.min(1, n / FULL_CANDLES);
        const hasCore = Number.isFinite(e21) && Number.isFinite(rsi14) && Number.isFinite(macdHist);
        if (!hasCore) missing.push('core-indicators');

        return {
            ok: true,
            reason: 'OK',
            count: n,
            index: idx,
            time: c.time,
            close: c.close,
            atr: atrSafe,
            coverage: coverage,
            degraded: coverage < 1 || missing.length > 0,
            patternCoverage: clamp01(patNum('patSamples')),
            patternAlignment: clamp11(patNum('patAlignment')),
            physics: physics && physics.ok ? physics : null,
            features: features,
            missing: missing
        };
    }

    // Compact vector for similarity/memory (stable key order).
    const MEMORY_KEYS = ['ret5', 'ret20', 'bodyAvg5', 'rsi14n', 'emaD55', 'macdHistN', 'momentum', 'volAnomaly', 'adxN', 'bbPos', 'mtf1h', 'mtf1d'];

    function toMemoryVector(features) {
        const f = features || {};
        return MEMORY_KEYS.map(function (k) { return num(f[k], 0); });
    }

    return {
        MIN_CANDLES: MIN_CANDLES,
        FULL_CANDLES: FULL_CANDLES,
        MEMORY_KEYS: MEMORY_KEYS,
        extract: extract,
        toMemoryVector: toMemoryVector
    };
});
