/* agentEagle.js — EAGLE BRAIN: Wide-Field Structure Intelligence.
 *
 * DESIGN CONCEPT (a computational metaphor, NOT a claim about real eagle
 * biology): a high vantage point that scans a broad area, resolves the overall
 * shape of the market, and only commits when the picture is unambiguous.
 *
 * Trading translation:
 *   - broad structure first (multi-timeframe + long EMAs + trend strength),
 *   - momentum / directional movement as the trigger,
 *   - deliberately SELECTIVE: high activation threshold means chop produces
 *     (almost) no signal instead of a noisy one,
 *   - confidence grows with alignment between the wide view and the impulse.
 *
 * UMD: registers window.AnimalAgents.Eagle, module.exports for tests.
 */
(function EagleUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Eagle = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildEagle(root) {
    'use strict';

    function core() {
        if (root && root.NeuralCore) return root.NeuralCore;
        if (typeof NeuralCore !== 'undefined') return NeuralCore;
        try {
            if (typeof require === 'function') return require('./neuralCore');
        } catch (e) { /* browser: globals only */ }
        return null;
    }

    function build() {
        const C = core();
        if (!C) throw new Error('NeuralCore missing for Eagle');
        return C.createAgent({
            id: 'eagle',
            name: 'EAGLE',
            icon: '🦅',
            role: 'Wide-Field Structure',
            reliability: 0.66,
            neurons: {
                // The wide view: where is price relative to the long structure?
                scan: {
                    inputs: ['emaD55', 'emaD200', 'mtf1h', 'mtf1d', 'linregSlopeN', 'emaD21', 'patDayBias'],
                    weights: [0.4, 0.5, 0.4, 0.45, 0.35, 0.25, 0.3],
                    // High threshold: a weak structure read stays silent.
                    bias: 0.0, threshold: 0.16, decay: 0.3, recurrentWeight: 0.45
                },
                // Directional thrust: is the market actually moving somewhere?
                momentum: {
                    inputs: ['ret20', 'momentum', 'acceleration', 'macdHistN', 'macdBull', 'patAnalogBias'],
                    weights: [0.45, 0.55, 0.35, 0.4, 0.3, 0.4],
                    bias: 0.0, threshold: 0.12, decay: 0.25, recurrentWeight: 0.4
                },
                // Trend strength: only strong regimes deserve an entry.
                clarity: {
                    inputs: ['adxN', 'bbWidth', 'rangeAtr', 'volatility'],
                    weights: [0.6, 0.2, 0.15, -0.15],
                    bias: -0.25, threshold: 0.08, decay: 0.3, recurrentWeight: 0.35
                },
                // Selectivity: chop/noise suppresses the decision entirely.
                selectivity: {
                    inputs: ['adxN', 'volatility', 'volAnomaly', 'mtf15m'],
                    weights: [0.5, -0.35, -0.25, 0.2],
                    bias: -0.45, threshold: 0.05, decay: 0.35, recurrentWeight: 0.3
                },
                // Commitment: trend filters agreeing with the impulse.
                strike: {
                    inputs: ['supertrend', 'psarSide', 'momentum', 'takerImb'],
                    weights: [0.4, 0.35, 0.45, 0.2],
                    bias: 0.0, threshold: 0.14, decay: 0.25, recurrentWeight: 0.35
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const N = agent.neurons;
                const scan = N.scan.forward(f);
                const momentum = N.momentum.forward(f);
                const clarity = N.clarity.forward(f);
                const selectivity = N.selectivity.forward(f);
                const strike = N.strike.forward(f);

                // Structure agreement in [-1, 1]: wide view vs impulse.
                const structureSign = scan.activation >= 0 ? 1 : -1;
                const momentumSign = momentum.activation >= 0 ? 1 : -1;
                const alignment = C.clamp(structureSign * momentumSign, -1, 1);

                // Selectivity gate: near-zero in chop, ~1 in a clean regime.
                const gate = C.clamp((selectivity.activation + 1) / 2, 0, 1);

                // Momentum leads, structure must agree, strike confirms.
                let direction = C.clamp(
                    momentum.activation * 0.5 + scan.activation * 0.3 + strike.activation * 0.2, -1, 1);
                // Penalise a momentum read that fights the wide view.
                direction *= (0.35 + 0.65 * Math.max(0, alignment));
                // Then apply the selectivity gate.
                direction *= (0.25 + 0.75 * gate);

                const clarityScore = C.clamp((clarity.activation + 1) / 2, 0, 1);
                const confidence = C.clamp(
                    0.2 + Math.abs(alignment) * 0.3 + gate * 0.25 + clarityScore * 0.2, 0.05, 0.95);

                const trend = direction > 0.2 ? 'BULLISH' : (direction < -0.2 ? 'BEARISH' : 'NEUTRAL');

                const factors = [
                    { label: 'Directional momentum', value: C.clamp(momentum.activation, -1, 1), weight: 0.4 },
                    { label: 'Wide structure', value: C.clamp(scan.activation, -1, 1), weight: 0.35 },
                    { label: 'Trend clarity', value: C.clamp(clarity.activation, -1, 1), weight: 0.3 },
                    { label: 'Selectivity gate', value: C.clamp(gate * 2 - 1, -1, 1), weight: 0.3 },
                    { label: 'Commitment filters', value: C.clamp(strike.activation, -1, 1), weight: 0.25 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: direction,
                    confidence: confidence,
                    output: {
                        direction: direction,
                        structureAlignment: alignment,
                        selectivity: gate,
                        trendClarity: clarityScore,
                        trend: trend
                    },
                    factors: factors.slice(0, 4)
                };
            }
        });
    }

    // Lazily built so script order can never break page boot.
    let instance = null;
    function get() {
        if (!instance) instance = build();
        return instance;
    }

    return {
        id: 'eagle',
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
