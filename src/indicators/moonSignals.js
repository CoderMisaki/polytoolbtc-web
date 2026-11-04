/* moonSignals.js — low-noise moon markers for confirmed AI signals.
 *
 * A moon is not drawn for every score change. The existing IntelligenceEngine
 * must first produce an EXECUTE signal; it must also clear a stronger display
 * gate (score, active neural consensus, confidence and risk gate), then stay
 * valid across two analysis samples. Only the two newest signals are retained.
 * UMD: window.MoonSignalIndicator in the browser, module.exports in Node.
 */
(function MoonSignalIndicatorUMD(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.MoonSignalIndicator = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildMoonSignalIndicator() {
    'use strict';

    const MAX_SIGNALS = 2;
    const MIN_SCORE = 55;
    const MIN_NEURAL_CONFIDENCE = 0.62;
    const REQUIRED_CONFIRMATIONS = 2;
    const MIN_CONFIRMATION_INTERVAL_MS = 1000;

    let markers = [];
    let pending = null;

    function directionOf(analysis) {
        if (!analysis || analysis.type !== 'EXECUTE') return null;
        if (Number(analysis.age) !== 0) return null;

        const direction = analysis.signal === 'STRONG BUY'
            ? 'LONG'
            : (analysis.signal === 'STRONG SELL' ? 'SHORT' : null);
        if (!direction) return null;

        const score = Number(analysis.score);
        if (!Number.isFinite(score) || Math.abs(score) < MIN_SCORE) return null;
        if ((direction === 'LONG' && score <= 0) || (direction === 'SHORT' && score >= 0)) return null;

        const neural = analysis.neural;
        if (!neural || neural.active !== true || neural.hardBlock === true || neural.gatePass !== true) return null;
        if (!Number.isFinite(Number(neural.confidence)) || Number(neural.confidence) < MIN_NEURAL_CONFIDENCE) return null;
        if (neural.decision !== direction) return null;

        return direction;
    }

    /**
     * Observe one fresh analysis sample. Returns a marker only after the same
     * direction remains qualified for two samples at least one second apart.
     */
    function observe(analysis, pair, candle, observedAt) {
        const pairKey = String(pair || '').trim().toUpperCase();
        const time = Number(candle && candle.time);
        const now = Number.isFinite(Number(observedAt)) ? Number(observedAt) : Date.now();
        const direction = directionOf(analysis);

        if (!pairKey || !Number.isFinite(time) || time <= 0 || !direction) {
            pending = null;
            return null;
        }

        // One signal per candle: a later flip within the same candle must not
        // place competing Long and Short moons on top of each other.
        if (markers.some((marker) => marker.pair === pairKey && marker.time === time)) {
            pending = null;
            return null;
        }

        const key = `${pairKey}:${time}:${direction}`;
        if (!pending || pending.key !== key) {
            pending = { key, pair: pairKey, time, direction, confirmations: 1, lastObservedAt: now };
            return null;
        }

        if (now - pending.lastObservedAt < MIN_CONFIRMATION_INTERVAL_MS) return null;
        pending.confirmations += 1;
        pending.lastObservedAt = now;
        if (pending.confirmations < REQUIRED_CONFIRMATIONS) return null;

        const marker = {
            pair: pairKey,
            time,
            position: direction === 'LONG' ? 'belowBar' : 'aboveBar',
            color: '#fbbf24',
            shape: 'circle',
            size: 1.5,
            text: `🌙 ${direction}`
        };
        markers = markers.concat(marker).slice(-MAX_SIGNALS);
        pending = null;
        return Object.assign({}, marker);
    }

    function getMarkers(pair) {
        const pairKey = pair === undefined || pair === null ? null : String(pair).trim().toUpperCase();
        const selected = pairKey ? markers.filter((marker) => marker.pair === pairKey) : markers;
        return selected.map((marker) => Object.assign({}, marker));
    }

    function reset() {
        markers = [];
        pending = null;
    }

    return {
        MAX_SIGNALS,
        MIN_SCORE,
        MIN_NEURAL_CONFIDENCE,
        REQUIRED_CONFIRMATIONS,
        MIN_CONFIRMATION_INTERVAL_MS,
        observe,
        getMarkers,
        reset
    };
});
