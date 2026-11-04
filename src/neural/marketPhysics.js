/* marketPhysics.js — bounded market-physics feature model.
 *
 * This is a deterministic execution/risk model, not a claim of literal
 * biological neurons or a guarantee of market accuracy. It derives only from
 * completed OHLCV candles available at `index` and exposes compact features
 * for the animal agents:
 *
 *   - drift / diffusion (log-return process),
 *   - trend efficiency and short-lag return persistence,
 *   - jump and tail-risk pressure,
 *   - volume-backed liquidity and estimated market impact.
 *
 * A browser cannot truthfully execute billions of individual neurons per tick.
 * Keeping this calculation bounded (at most 96 observations) makes the
 * simulation auditable, repeatable, and safe to run alongside a live chart.
 * UMD: window.MarketPhysics in browsers, module.exports in Node.
 */
(function MarketPhysicsUMD(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.MarketPhysics = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildMarketPhysics() {
    'use strict';

    const MIN_SAMPLES = 24;
    const MAX_WINDOW = 96;

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) return 0;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    function clamp01(value) {
        return clamp(value, 0, 1);
    }

    function clamp11(value) {
        return clamp(value, -1, 1);
    }

    function soft(value) {
        if (!Number.isFinite(value)) return 0;
        return value / (1 + Math.abs(value));
    }

    function mean(values) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        let sum = 0;
        let count = 0;
        for (let i = 0; i < values.length; i++) {
            if (Number.isFinite(values[i])) {
                sum += values[i];
                count++;
            }
        }
        return count > 0 ? sum / count : 0;
    }

    function sampleStd(values, average) {
        if (!Array.isArray(values) || values.length < 2) return 0;
        const avg = Number.isFinite(average) ? average : mean(values);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (!Number.isFinite(value)) continue;
            const diff = value - avg;
            sum += diff * diff;
            count++;
        }
        return count > 1 ? Math.sqrt(sum / (count - 1)) : 0;
    }

    // Abramowitz-Stegun approximation. It is accurate enough for a bounded
    // probability feature and avoids a heavyweight statistics dependency.
    function normalCdf(value) {
        if (!Number.isFinite(value)) return 0.5;
        const x = Math.abs(value);
        const t = 1 / (1 + 0.2316419 * x);
        const density = 0.3989422804014327 * Math.exp(-x * x / 2);
        const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
        const probability = 1 - density * poly;
        return value >= 0 ? probability : 1 - probability;
    }

    function zeroFeatures() {
        return {
            physicsDrift: 0,
            physicsTrend: 0,
            physicsMeanReversion: 0,
            physicsVolatility: 0,
            physicsJumpRisk: 0,
            physicsTailRisk: 0,
            physicsLiquidity: 0,
            physicsImpact: 0,
            physicsConfidence: 0
        };
    }

    function validCandle(candle) {
        return candle
            && Number.isFinite(candle.close) && candle.close > 0
            && Number.isFinite(candle.high) && Number.isFinite(candle.low)
            && candle.high >= candle.low;
    }

    /**
     * Analyse candles through `index` only. Mutations after that index cannot
     * change this result, which keeps both live and historical simulations free
     * from look-ahead bias.
     */
    function analyze(snapshot) {
        const snap = snapshot || {};
        const candles = Array.isArray(snap.candles) ? snap.candles : [];
        let index = Number.isFinite(snap.index) ? Math.floor(snap.index) : candles.length - 1;
        index = Math.min(candles.length - 1, Math.max(0, index));
        // The live feed marks the still-forming kline explicitly. Excluding it
        // keeps statistical estimates based on completed observations while
        // preserving normal historical/API candles that have no `isClosed` key.
        if (candles[index] && candles[index].isClosed === false) index--;
        const empty = zeroFeatures();

        if (candles.length === 0 || index < 1 || !validCandle(candles[index])) {
            return { ok: false, reason: 'INSUFFICIENT_DATA', samples: 0, features: empty };
        }

        const start = Math.max(1, index - MAX_WINDOW + 1);
        const returns = [];
        const ranges = [];
        const volumes = [];
        for (let i = start; i <= index; i++) {
            const previous = candles[i - 1];
            const current = candles[i];
            if (!validCandle(previous) || !validCandle(current)) continue;
            const logReturn = Math.log(current.close / previous.close);
            if (!Number.isFinite(logReturn)) continue;
            returns.push(logReturn);
            ranges.push((current.high - current.low) / current.close);
            if (Number.isFinite(current.vol) && current.vol >= 0) volumes.push(current.vol);
        }

        if (returns.length < MIN_SAMPLES) {
            return { ok: false, reason: 'INSUFFICIENT_DATA', samples: returns.length, features: empty };
        }

        const drift = mean(returns);
        const sigma = sampleStd(returns, drift);
        const last = candles[index];
        const currentReturn = returns[returns.length - 1];
        const returnSum = returns.reduce(function (sum, value) { return sum + value; }, 0);
        const absolutePath = returns.reduce(function (sum, value) { return sum + Math.abs(value); }, 0);
        const trendEfficiency = absolutePath > 1e-12 ? returnSum / absolutePath : 0;

        let covariance = 0;
        let variance = 0;
        for (let i = 1; i < returns.length; i++) {
            covariance += (returns[i] - drift) * (returns[i - 1] - drift);
        }
        for (let i = 0; i < returns.length; i++) {
            const diff = returns[i] - drift;
            variance += diff * diff;
        }
        const autocorrelation = variance > 1e-18 ? covariance / variance : 0;

        const standardizedMove = sigma > 1e-12 ? Math.abs(currentReturn - drift) / sigma : 0;
        const maxStandardizedMove = sigma > 1e-12
            ? Math.max.apply(null, returns.map(function (value) { return Math.abs(value - drift) / sigma; }))
            : 0;
        // 2σ begins raising the risk; 5σ saturates it. This is deliberately
        // conservative and is a risk feature, not an entry signal.
        const jumpRisk = clamp01((standardizedMove - 2) / 3);
        const tailRisk = clamp01((maxStandardizedMove - 2.5) / 3.5);

        const averageRange = mean(ranges);
        const rangeNow = ranges.length ? ranges[ranges.length - 1] : 0;
        const hasVolumeEvidence = volumes.length >= Math.min(MIN_SAMPLES, returns.length);
        const averageVolume = mean(volumes);
        const volumeNow = Number.isFinite(last.vol) && last.vol >= 0 ? last.vol : averageVolume;
        const volumeRatio = hasVolumeEvidence && averageVolume > 0 ? volumeNow / averageVolume : 0;
        // A square-root volume law is a standard compact approximation for
        // impact. Larger candles with thinner than average volume imply more
        // adverse execution pressure. Without volume we return neutral risk
        // values and lower confidence instead of inventing book liquidity.
        const impact = hasVolumeEvidence
            ? clamp01((rangeNow / Math.max(averageRange, 1e-9)) / Math.sqrt(Math.max(volumeRatio, 0.05)) / 3)
            : 0;
        const liquidity = hasVolumeEvidence
            ? clamp01(Math.sqrt(Math.max(volumeRatio, 0)) / (1 + impact))
            : 0;

        const horizon = Math.min(16, returns.length);
        const driftZ = sigma > 1e-12 ? (drift / sigma) * Math.sqrt(horizon) : 0;
        const upProbability = normalCdf(clamp(driftZ, -6, 6));
        const directionalDrift = clamp11((upProbability - 0.5) * 2);
        const diffusion = clamp01(sigma * 180); // normalised log-return spread
        const confidence = clamp01(
            ((returns.length / MAX_WINDOW) * 0.35 +
            Math.abs(directionalDrift) * 0.35 +
            Math.abs(trendEfficiency) * 0.2 -
            jumpRisk * 0.2 - tailRisk * 0.15) *
            (hasVolumeEvidence ? 1 : 0.75)
        );

        const features = {
            physicsDrift: directionalDrift,
            physicsTrend: clamp11(trendEfficiency),
            // Negative autocorrelation is the observable mean-reversion case.
            physicsMeanReversion: clamp11(-autocorrelation),
            physicsVolatility: diffusion,
            physicsJumpRisk: jumpRisk,
            physicsTailRisk: tailRisk,
            physicsLiquidity: liquidity,
            physicsImpact: impact,
            physicsConfidence: confidence
        };

        return {
            ok: true,
            reason: null,
            samples: returns.length,
            windowStart: start,
            index: index,
            drift: drift,
            sigma: sigma,
            autocorrelation: clamp11(autocorrelation),
            trendEfficiency: clamp11(trendEfficiency),
            upProbability: upProbability,
            jumpRisk: jumpRisk,
            tailRisk: tailRisk,
            liquidity: liquidity,
            impact: impact,
            features: features
        };
    }

    return {
        MIN_SAMPLES: MIN_SAMPLES,
        MAX_WINDOW: MAX_WINDOW,
        zeroFeatures: zeroFeatures,
        analyze: analyze
    };
});
