/* agentDolphin.js — DOLPHIN BRAIN: Social / Market Behavior Intelligence.
 * Market sentiment, crowd behavior, momentum synchronization, buy/sell
 * pressure, herd behavior, regime change. Sentiment is derived ONLY from
 * market observables (volume, volatility, acceleration, imbalance, candle
 * structure, momentum) — never from fictional data.
 * UMD: registers window.AnimalAgents.Dolphin, module.exports for tests.
 */
(function DolphinUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Dolphin = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildDolphin(root) {
    'use strict';

    function core() {
        if (root && root.NeuralCore) return root.NeuralCore;
        if (typeof NeuralCore !== 'undefined') return NeuralCore;
        try {
            if (typeof require === 'function') return require('./neuralCore');
        } catch (e) { /* unreachable in browser when ordered */ }
        return null;
    }

    function build() {
        const C = core();
        if (!C) throw new Error('NeuralCore missing for Dolphin');
        return C.createAgent({
            id: 'dolphin',
            name: 'DOLPHIN',
            icon: '🐬',
            role: 'Market Behavior',
            reliability: 0.66,
            neurons: {
                // Sentiment from observables: imbalance, momentum, acceleration.
                sentiment: {
                    inputs: ['takerImb', 'cvdImb', 'momentum', 'acceleration', 'bodyAvg5', 'ret5'],
                    weights: [0.5, 0.45, 0.5, 0.3, 0.4, 0.3],
                    bias: 0.0, threshold: 0.05, decay: 0.1, recurrentWeight: 0.4
                },
                // Crowd/herd: participation expanding with the move?
                crowd: {
                    inputs: ['volChange', 'volAnomaly', 'bodyAvg5', 'momentum', 'obvSlopeN'],
                    weights: [0.45, 0.35, 0.4, 0.4, 0.35],
                    bias: -0.1, threshold: 0.08, decay: 0.12, recurrentWeight: 0.35
                },
                // Directional pressure gauge.
                pressure: {
                    inputs: ['takerImb', 'cvdImb', 'obvSlopeN', 'volChange', 'body'],
                    weights: [0.55, 0.5, 0.35, 0.25, 0.3],
                    bias: 0.0, threshold: 0.05, decay: 0.12, recurrentWeight: 0.35
                },
                // Synchronization: timeframes + indicators aligned?
                sync: {
                    inputs: ['mtf15m', 'mtf1h', 'mtf1d', 'macdBull', 'supertrend', 'psarSide', 'patHourBias', 'patAlignment'],
                    weights: [0.3, 0.4, 0.35, 0.25, 0.3, 0.2, 0.3, 0.25],
                    bias: 0.0, threshold: 0.04, decay: 0.08, recurrentWeight: 0.4
                },
                // Regime: risk-on participation vs fearful chop.
                regime: {
                    inputs: ['volatility', 'volAnomaly', 'adxN', 'bbWidth', 'momentum', 'mfiN'],
                    weights: [-0.3, 0.3, 0.4, -0.25, 0.35, 0.2],
                    bias: 0.05, threshold: 0.06, decay: 0.1, recurrentWeight: 0.4
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const N = agent.neurons;
                const sentiment = N.sentiment.forward(f);
                const crowd = N.crowd.forward(f);
                const pressure = N.pressure.forward(f);
                const sync = N.sync.forward(f);
                const regimeN = N.regime.forward(f);

                const crowdBias = C.clamp(sentiment.activation * 0.45 + pressure.activation * 0.35 + crowd.activation * 0.2, -1, 1);
                const buyPressure = C.clamp((pressure.activation + 1) / 2, 0, 1);
                const sellPressure = C.clamp(1 - buyPressure, 0, 1);
                const sentimentScore = C.clamp((sentiment.activation + 1) / 2, 0, 1);

                // Regime from participation + trend health (market-derived).
                const riskOn = regimeN.activation > 0.15 && (f.adxN || 0) > 0.25;
                const riskOff = regimeN.activation < -0.2 || ((f.volatility || 0) > 0.75 && (f.adxN || 0) < 0.2);
                const regime = riskOn ? 'RISK_ON' : (riskOff ? 'RISK_OFF' : 'NEUTRAL');

                const syncMag = Math.abs(sync.activation);
                const confidence = C.clamp(0.3 + syncMag * 0.35 + Math.abs(crowdBias) * 0.25, 0.05, 0.95);

                const factors = [
                    { label: 'Taker imbalance', value: C.clamp(f.takerImb || 0, -1, 1), weight: 0.4 },
                    { label: 'CVD pressure', value: C.clamp(f.cvdImb || 0, -1, 1), weight: 0.35 },
                    { label: 'Crowd participation', value: C.clamp(crowd.activation, -1, 1), weight: 0.3 },
                    { label: 'MTF synchronization', value: C.clamp(sync.activation, -1, 1), weight: 0.3 },
                    { label: 'Regime state', value: C.clamp(regimeN.activation, -1, 1), weight: 0.25 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: crowdBias,
                    confidence: confidence,
                    output: {
                        sentiment: sentimentScore,
                        buyPressure: buyPressure,
                        sellPressure: sellPressure,
                        crowdBias: crowdBias,
                        regime: regime
                    },
                    factors: factors.slice(0, 4)
                };
            }
        });
    }

    let instance = null;
    function get() {
        if (!instance) instance = build();
        return instance;
    }

    return {
        id: 'dolphin',
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
