/* agentChimpanzee.js — CHIMPANZEE BRAIN: Strategic Pattern Intelligence.
 * Pattern recognition, contextual reasoning, adaptive strategy, reward/risk
 * evaluation, market structure, momentum, support/resistance, breakouts.
 * UMD: registers window.AnimalAgents.Chimpanzee, module.exports for tests.
 */
(function ChimpanzeeUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Chimpanzee = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildChimpanzee(root) {
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
        if (!C) throw new Error('NeuralCore missing for Chimpanzee');
        return C.createAgent({
            id: 'chimpanzee',
            name: 'CHIMPANZEE',
            icon: '🐒',
            role: 'Strategic Pattern Intelligence',
            reliability: 0.72,
            neurons: {
                // Sees candle geometry + swing structure.
                pattern: {
                    inputs: ['body', 'bodyAvg5', 'upperWick', 'lowerWick', 'rangeAtr', 'distSwingHigh', 'distSwingLow', 'bbPos', 'patAnalogBias', 'patMotifBias'],
                    weights: [0.55, 0.5, -0.35, 0.35, 0.3, -0.4, 0.4, 0.25, 0.35, 0.25],
                    bias: 0.0, threshold: 0.08, decay: 0.2, recurrentWeight: 0.3
                },
                // Multi-timeframe + indicator context.
                context: {
                    inputs: ['mtf15m', 'mtf1h', 'mtf1d', 'emaD21', 'emaD55', 'emaD200', 'supertrend', 'adxN', 'patDayBias', 'patHourBias'],
                    weights: [0.35, 0.5, 0.4, 0.3, 0.3, 0.35, 0.45, 0.2, 0.35, 0.25],
                    bias: 0.0, threshold: 0.05, decay: 0.12, recurrentWeight: 0.35
                },
                // Fuses pattern + context + momentum into a strategy vector.
                strategy: {
                    inputs: ['ret5', 'ret20', 'momentum', 'macdHistN', 'macdBull', 'linregSlopeN', 'psarSide', 'rsi14n'],
                    weights: [0.4, 0.3, 0.55, 0.4, 0.3, 0.35, 0.3, -0.15],
                    bias: 0.0, threshold: 0.05, decay: 0.15, recurrentWeight: 0.3
                },
                // Reward expectation: trend persistence + room to swing target.
                reward: {
                    inputs: ['adxN', 'momentum', 'distSwingHigh', 'bodyAvg5', 'volAnomaly'],
                    weights: [0.5, 0.45, 0.35, 0.3, 0.25],
                    bias: -0.1, threshold: 0.1, decay: 0.18, recurrentWeight: 0.25
                },
                // Risk: overextension, volatility, wick rejection.
                risk: {
                    inputs: ['volatility', 'rangeAtr', 'upperWick', 'lowerWick', 'bbWidth', 'rsi14n'],
                    weights: [0.5, 0.35, 0.3, 0.3, 0.3, 0.2],
                    bias: -0.35, threshold: 0.05, decay: 0.2, recurrentWeight: 0.2
                },
                // Short temporal memory of recent direction persistence.
                memory: {
                    inputs: ['ret1', 'ret5', 'bodyAvg5', 'momentum'],
                    weights: [0.3, 0.45, 0.4, 0.5],
                    bias: 0.0, threshold: 0.05, decay: 0.08, recurrentWeight: 0.55
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const N = agent.neurons;
                const pattern = N.pattern.forward(f);
                const context = N.context.forward(f);
                const strategy = N.strategy.forward(f);
                const reward = N.reward.forward(f);
                const risk = N.risk.forward(f);
                const memory = N.memory.forward(f);

                // Direction: strategy leads, pattern/context/memory vote.
                const direction = C.clamp(
                    strategy.activation * 0.45 +
                    pattern.activation * 0.2 +
                    context.activation * 0.2 +
                    memory.activation * 0.15, -1, 1);

                // Agreement between modules drives confidence.
                const votes = [strategy.activation, pattern.activation, context.activation, memory.activation];
                const agreement = 1 - Math.min(1, C.std(votes) * 1.6);
                const riskPenalty = Math.max(0, risk.activation) * 0.45;
                const rewardBoost = Math.max(0, reward.activation) * 0.2;
                const confidence = C.clamp(0.35 + agreement * 0.45 + rewardBoost - riskPenalty, 0.05, 0.97);

                const trend = direction > 0.18 ? 'BULLISH' : (direction < -0.18 ? 'BEARISH' : 'NEUTRAL');
                const patternStrength = C.clamp(Math.abs(pattern.activation) * 0.6 + Math.abs(strategy.activation) * 0.4, 0, 1);
                const momentumMag = C.clamp(Math.abs(memory.activation) * 0.5 + Math.abs(strategy.activation) * 0.5, 0, 1);

                const factors = [];
                function pushFactor(label, value, weight) {
                    factors.push({ label: label, value: C.clamp(value, -1, 1), weight: weight });
                }
                pushFactor('Momentum persistence', memory.activation, 0.3);
                pushFactor('MTF context', context.activation, 0.25);
                pushFactor('Pattern structure', pattern.activation, 0.25);
                pushFactor('Trend strategy', strategy.activation, 0.35);
                pushFactor('Reward expectation', reward.activation, 0.2);
                pushFactor('Risk pressure', -risk.activation, 0.3);
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: direction,
                    confidence: confidence,
                    output: {
                        direction: direction,
                        confidence: confidence,
                        trend: trend,
                        patternStrength: patternStrength,
                        momentum: momentumMag,
                        risk: C.clamp((risk.activation + 1) / 2, 0, 1)
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
        id: 'chimpanzee',
        get: get,
        // Direct passthroughs used by the orchestrator/tests.
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
