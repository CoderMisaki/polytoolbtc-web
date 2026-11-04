/* agentDragonfly.js — DRAGONFLY BRAIN: Rapid-Change Detection Intelligence.
 *
 * DESIGN CONCEPT (a computational metaphor, NOT a claim about real dragonfly
 * biology): an interceptor built for speed — it reacts to the newest
 * information first and revises its read every update.
 *
 * Trading translation:
 *   - shortest memory of the three new agents: dominated by the LAST candle
 *     and the current order-flow imbalance,
 *   - measures the rate of change of momentum, not the momentum itself,
 *   - high turnover: it changes its mind quickly and says so with a lower
 *     per-signal confidence,
 *   - a hard brake cuts the signal when price is already stretched, so speed
 *     does not turn into chasing.
 *
 * UMD: registers window.AnimalAgents.Dragonfly, module.exports for tests.
 */
(function DragonflyUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Dragonfly = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildDragonfly(root) {
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
        if (!C) throw new Error('NeuralCore missing for Dragonfly');
        return C.createAgent({
            id: 'dragonfly',
            name: 'DRAGONFLY',
            icon: '🪰',
            role: 'Rapid Change Detection',
            reliability: 0.6,
            neurons: {
                // Fastest path: the very latest candle only. Low decay + high
                // recurrent weight = reacts now, forgets quickly.
                reflex: {
                    inputs: ['ret1', 'body', 'takerImb', 'volChange'],
                    weights: [0.55, 0.5, 0.45, 0.35],
                    bias: 0.0, threshold: 0.02, decay: 0.04, recurrentWeight: 0.7
                },
                // Rate of change of momentum (acceleration), not momentum.
                accel: {
                    inputs: ['acceleration', 'macdHistN', 'momentum', 'ret5'],
                    weights: [0.55, 0.4, -0.25, -0.2],
                    bias: 0.0, threshold: 0.03, decay: 0.06, recurrentWeight: 0.6
                },
                // Microstructure: who is actually hitting the book.
                microstructure: {
                    inputs: ['takerImb', 'cvdImb', 'obvSlopeN', 'volAnomaly'],
                    weights: [0.45, 0.4, 0.3, 0.2],
                    bias: 0.0, threshold: 0.03, decay: 0.08, recurrentWeight: 0.55
                },
                // Freshness weighting: recency beats persistence.
                latency: {
                    inputs: ['ret1', 'volChange', 'bodyAvg5', 'ret5'],
                    weights: [0.5, 0.3, -0.3, -0.25],
                    bias: 0.0, threshold: 0.03, decay: 0.05, recurrentWeight: 0.65
                },
                // Brake: stretched oscillators / far from the swings.
                brake: {
                    inputs: ['rsi14n', 'stochKn', 'wrN', 'bbPos', 'distSwingHigh'],
                    weights: [0.45, 0.4, 0.3, 0.3, 0.25],
                    bias: -0.55, threshold: 0.02, decay: 0.15, recurrentWeight: 0.3
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const N = agent.neurons;
                const reflex = N.reflex.forward(f);
                const accel = N.accel.forward(f);
                const micro = N.microstructure.forward(f);
                const latency = N.latency.forward(f);
                const brake = N.brake.forward(f);

                // Impulse: newest information dominates.
                let impulse = C.clamp(
                    reflex.activation * 0.45 + accel.activation * 0.3 +
                    micro.activation * 0.15 + latency.activation * 0.1, -1, 1);

                // Directional agreement between the fast paths.
                const votes = [reflex.activation, accel.activation, micro.activation, latency.activation];
                const agreement = 1 - Math.min(1, C.std(votes) * 1.8);

                // Brake: how stretched is price right now?
                const brakeLevel = C.clamp((brake.activation + 1) / 2, 0, 1);
                // Signed brake: only cut when stretched in the direction we
                // are about to take, not when stretched against it.
                const dirSign = impulse >= 0 ? 1 : -1;
                const stretchInDirection = C.clamp(brake.activation * dirSign, 0, 1);

                impulse *= (1 - stretchInDirection * 0.8);

                // Fast agent: reacts strongly but trusts itself less.
                const reactionSpeed = C.clamp(Math.abs(reflex.activation) * 0.6 + Math.abs(accel.activation) * 0.4, 0, 1);
                const confidence = C.clamp(
                    0.18 + agreement * 0.35 + reactionSpeed * 0.2 - brakeLevel * 0.2, 0.05, 0.85);

                const factors = [
                    { label: 'Reflex (last candle)', value: C.clamp(reflex.activation, -1, 1), weight: 0.45 },
                    { label: 'Momentum acceleration', value: C.clamp(accel.activation, -1, 1), weight: 0.4 },
                    { label: 'Order-flow imbalance', value: C.clamp(micro.activation, -1, 1), weight: 0.3 },
                    { label: 'Over-extension brake', value: C.clamp(-brake.activation, -1, 1), weight: 0.35 },
                    { label: 'Recency weighting', value: C.clamp(latency.activation, -1, 1), weight: 0.25 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: impulse,
                    confidence: confidence,
                    output: {
                        impulse: impulse,
                        reactionSpeed: reactionSpeed,
                        agreement: agreement,
                        brakeLevel: brakeLevel
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
        id: 'dragonfly',
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
