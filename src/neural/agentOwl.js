/* agentOwl.js — OWL BRAIN: Quiet-Condition Observation Intelligence.
 *
 * DESIGN CONCEPT (a computational metaphor, NOT a claim about real owl
 * biology): an observer tuned to low-noise conditions that notices small
 * changes and treats sudden disturbance as a threat rather than an
 * opportunity.
 *
 * Trading translation:
 *   - reads QUIET markets (low volatility, compressed range, thin volume),
 *   - tracks SMALL changes rather than big directional thrusts,
 *   - leans mean-reverting while conditions stay calm,
 *   - becomes defensive (shrinks magnitude, raises perceived risk) when a
 *     threat signature appears, so it is deliberately NOT always aggressive,
 *   - adapts when the regime itself shifts.
 *
 * UMD: registers window.AnimalAgents.Owl, module.exports for tests.
 */
(function OwlUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Owl = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildOwl(root) {
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
        if (!C) throw new Error('NeuralCore missing for Owl');
        return C.createAgent({
            id: 'owl',
            name: 'OWL',
            icon: '🦉',
            role: 'Quiet Observation',
            reliability: 0.64,
            neurons: {
                // How calm is the market right now? (inverse-volatility read)
                silence: {
                    inputs: ['volatility', 'bbWidth', 'volAnomaly', 'adxN', 'rangeAtr'],
                    weights: [-0.55, -0.4, -0.35, -0.3, -0.25],
                    bias: 0.35, threshold: 0.05, decay: 0.35, recurrentWeight: 0.4
                },
                // Small deltas: the changes most observers ignore.
                micro: {
                    inputs: ['ret1', 'body', 'volChange', 'takerImb', 'stochKn', 'patMinuteBias'],
                    weights: [0.4, 0.35, 0.3, 0.35, -0.25, 0.35],
                    bias: 0.0, threshold: 0.04, decay: 0.2, recurrentWeight: 0.5
                },
                // Threat: rejection wicks, volume spikes, stretched oscillators.
                threat: {
                    inputs: ['upperWick', 'lowerWick', 'volAnomaly', 'rsi14n', 'stochKn'],
                    weights: [0.4, 0.4, 0.45, 0.3, 0.25],
                    bias: -0.5, threshold: 0.03, decay: 0.3, recurrentWeight: 0.25
                },
                // Patience: prefers to wait rather than chase.
                patience: {
                    inputs: ['momentum', 'adxN', 'acceleration', 'bbPos'],
                    weights: [-0.4, -0.35, -0.3, -0.2],
                    bias: 0.4, threshold: 0.05, decay: 0.4, recurrentWeight: 0.45
                },
                // Adaptation: is the regime itself changing?
                adapt: {
                    inputs: ['bbWidth', 'volatility', 'mtf15m', 'mtf1h', 'voloscN', 'patSamples'],
                    weights: [0.35, 0.3, 0.2, 0.25, 0.25, 0.3],
                    bias: -0.2, threshold: 0.06, decay: 0.3, recurrentWeight: 0.35
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const N = agent.neurons;
                const silence = N.silence.forward(f);
                const micro = N.micro.forward(f);
                const threat = N.threat.forward(f);
                const patience = N.patience.forward(f);
                const adapt = N.adapt.forward(f);

                const quietness = C.clamp((silence.activation + 1) / 2, 0, 1);
                const threatLevel = C.clamp((threat.activation + 1) / 2, 0, 1);
                const patienceLevel = C.clamp((patience.activation + 1) / 2, 0, 1);
                const regimeShift = C.clamp((adapt.activation + 1) / 2, 0, 1);

                // Mean-reversion lean: fade stretched readings while calm.
                // bbPos > 0.5 / rsi14n > 0 means price sits high in its range.
                const stretch = C.clamp(
                    ((Number.isFinite(f.bbPos) ? f.bbPos : 0.5) - 0.5) * 2 * 0.6 +
                    (Number.isFinite(f.rsi14n) ? f.rsi14n : 0) * 0.4, -1, 1);
                const reversion = -stretch * quietness;

                // Direction: small-change signal, faded by patience, only
                // expressed when the market is actually calm.
                let direction = C.clamp(
                    micro.activation * 0.45 + reversion * 0.55, -1, 1);
                // Calm markets express the signal; turbulent ones mute it.
                direction *= (0.2 + 0.8 * quietness);
                // A threat makes the owl defensive, not aggressive.
                direction *= (1 - threatLevel * 0.7);
                // Patience caps conviction: this agent rarely shouts.
                direction *= (1 - patienceLevel * 0.35);
                // Regime shift → fall back toward neutral and re-observe.
                direction *= (1 - regimeShift * 0.4);

                const confidence = C.clamp(
                    0.22 + quietness * 0.35 + (1 - threatLevel) * 0.25 - regimeShift * 0.15, 0.05, 0.9);

                const factors = [
                    { label: 'Quiet conditions', value: C.clamp(quietness * 2 - 1, -1, 1), weight: 0.35 },
                    { label: 'Small-change signal', value: C.clamp(micro.activation, -1, 1), weight: 0.35 },
                    { label: 'Threat signature', value: C.clamp(-threatLevel * 2 + 1, -1, 1), weight: 0.4 },
                    { label: 'Patience', value: C.clamp(patienceLevel * 2 - 1, -1, 1), weight: 0.25 },
                    { label: 'Regime shift', value: C.clamp(-regimeShift * 2 + 1, -1, 1), weight: 0.3 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: direction,
                    confidence: confidence,
                    output: {
                        direction: direction,
                        quietness: quietness,
                        threatLevel: threatLevel,
                        patienceLevel: patienceLevel,
                        regimeShift: regimeShift
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
        id: 'owl',
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
