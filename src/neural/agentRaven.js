/* agentRaven.js — RAVEN BRAIN: Problem Solving + Tactical Intelligence.
 * Sequential reasoning, anomaly detection, tactical entries, liquidity
 * behavior, breakout traps and false-breakout detection.
 * UMD: registers window.AnimalAgents.Raven, module.exports for tests.
 */
(function RavenUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Raven = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildRaven(root) {
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
        if (!C) throw new Error('NeuralCore missing for Raven');
        return C.createAgent({
            id: 'raven',
            name: 'RAVEN',
            icon: '🐦',
            role: 'Tactical Intelligence',
            reliability: 0.68,
            neurons: {
                // Multi-step sequence: how did we arrive here?
                sequence: {
                    inputs: ['ret1', 'ret5', 'ret20', 'momentum', 'acceleration', 'bodyAvg5', 'physicsDrift', 'physicsTrend'],
                    weights: [0.25, 0.4, 0.3, 0.5, 0.35, 0.4, 0.35, 0.3],
                    bias: 0.0, threshold: 0.06, decay: 0.1, recurrentWeight: 0.45
                },
                // Abnormal candles, volume spikes, exhaustion wicks, and the
                // diffusion model's observed jump/impact pressure.
                anomaly: {
                    inputs: ['volAnomaly', 'rangeAtr', 'upperWick', 'lowerWick', 'volatility', 'bbWidth', 'physicsJumpRisk', 'physicsTailRisk', 'physicsImpact'],
                    weights: [0.55, 0.4, 0.35, 0.35, 0.3, 0.25, 0.45, 0.35, 0.3],
                    bias: -0.55, threshold: 0.04, decay: 0.22, recurrentWeight: 0.15
                },
                // Tactical entry quality: with-trend + not extended.
                tactical: {
                    inputs: ['supertrend', 'macdBull', 'emaD21', 'rsi14n', 'stochKn', 'psarSide'],
                    weights: [0.45, 0.35, -0.25, -0.2, -0.15, 0.3],
                    bias: 0.0, threshold: 0.08, decay: 0.15, recurrentWeight: 0.3
                },
                // Pattern combination: breakout attempt vs trap signature.
                combo: {
                    inputs: ['bbPos', 'distSwingHigh', 'distSwingLow', 'volChange', 'takerImb', 'body'],
                    weights: [0.3, -0.35, 0.35, 0.4, 0.4, 0.35],
                    bias: 0.0, threshold: 0.06, decay: 0.15, recurrentWeight: 0.3
                },
                // Short-term memory of immediate sequence state.
                stmemory: {
                    inputs: ['ret1', 'body', 'takerImb', 'volChange'],
                    weights: [0.4, 0.4, 0.35, 0.3],
                    bias: 0.0, threshold: 0.05, decay: 0.06, recurrentWeight: 0.6
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const N = agent.neurons;
                const sequence = N.sequence.forward(f);
                const anomaly = N.anomaly.forward(f);
                const tactical = N.tactical.forward(f);
                const combo = N.combo.forward(f);
                const stmemory = N.stmemory.forward(f);

                const anomalyScore = C.clamp((anomaly.activation + 1) / 2, 0, 1);
                const jumpRisk = C.clamp(Number.isFinite(f.physicsJumpRisk) ? f.physicsJumpRisk : 0, 0, 1);
                const tailRisk = C.clamp(Number.isFinite(f.physicsTailRisk) ? f.physicsTailRisk : 0, 0, 1);
                const impact = C.clamp(Number.isFinite(f.physicsImpact) ? f.physicsImpact : 0, 0, 1);

                // Breakout quality: strong combo + volume support, low anomaly
                // and low estimated adverse execution impact.
                const breakoutQuality = C.clamp(
                    0.5 + combo.activation * 0.35 + Math.max(0, f.volChange || 0) * 0.2 - anomalyScore * 0.35 - impact * 0.15, 0, 1);

                // Trap probability: anomaly + exhaustion wick against the move
                // + weak follow-through (sequence/memory disagree with combo).
                const dirSign = combo.activation >= 0 ? 1 : -1;
                const rejectWick = dirSign > 0 ? (f.upperWick || 0) : (f.lowerWick || 0);
                const followThrough = (sequence.activation * dirSign + stmemory.activation * dirSign) / 2;
                const trapProbability = C.clamp(
                    anomalyScore * 0.45 + rejectWick * 0.3 + Math.max(0, -followThrough) * 0.35 +
                    jumpRisk * 0.2 + tailRisk * 0.15, 0, 1);

                // Tactical bias: sequence-led, vetoed by traps. A large price
                // impact estimate reduces conviction rather than reversing the
                // observable direction by itself.
                let tacticalBias = C.clamp(
                    sequence.activation * 0.4 + tactical.activation * 0.3 +
                    combo.activation * 0.2 + stmemory.activation * 0.1, -1, 1);
                tacticalBias *= (1 - trapProbability * 0.7) * (1 - impact * 0.35);

                const confidence = C.clamp(
                    0.35 + breakoutQuality * 0.3 + (1 - trapProbability) * 0.25 - anomalyScore * 0.15 - tailRisk * 0.12, 0.05, 0.97);

                const factors = [
                    { label: 'Sequence momentum', value: C.clamp(sequence.activation, -1, 1), weight: 0.35 },
                    { label: 'Anomaly level', value: C.clamp(-anomaly.activation, -1, 1), weight: 0.3 },
                    { label: 'Breakout structure', value: C.clamp(combo.activation, -1, 1), weight: 0.3 },
                    { label: 'Trap signature', value: C.clamp(-trapProbability * dirSign, -1, 1), weight: 0.4 },
                    { label: 'Jump / impact risk', value: C.clamp(-(jumpRisk + impact) / 2, -1, 1), weight: 0.3 },
                    { label: 'Tactical entry', value: C.clamp(tactical.activation, -1, 1), weight: 0.25 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: tacticalBias,
                    confidence: confidence,
                    output: {
                        tacticalBias: tacticalBias,
                        anomalyScore: anomalyScore,
                        breakoutQuality: breakoutQuality,
                        trapProbability: trapProbability
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
        id: 'raven',
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
