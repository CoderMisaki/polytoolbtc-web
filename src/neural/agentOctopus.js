/* agentOctopus.js — OCTOPUS BRAIN: Adaptive Multi-Path Intelligence.
 * Multi-signal integration, rapid adaptation, regime switching, conflicting
 * signal resolution, short-term response, volatility adaptation. Consumes
 * every other agent's output plus market state to resolve conflicts.
 * UMD: registers window.AnimalAgents.Octopus, module.exports for tests.
 */
(function OctopusUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Octopus = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildOctopus(root) {
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
        if (!C) throw new Error('NeuralCore missing for Octopus');
        return C.createAgent({
            id: 'octopus',
            name: 'OCTOPUS',
            icon: '🐙',
            role: 'Adaptive Intelligence',
            reliability: 0.7,
            neurons: {
                // Integrates the four peer biases, reliability-weighted.
                adaptive: {
                    inputs: ['peerChimp', 'peerRaven', 'peerDolphin', 'peerElephant',
                        'peerEagle', 'peerOwl', 'peerDragonfly', 'peerMean'],
                    weights: [0.28, 0.28, 0.24, 0.24, 0.26, 0.22, 0.22, 0.4],
                    bias: 0.0, threshold: 0.04, decay: 0.1, recurrentWeight: 0.4
                },
                // Multi-path: market path can override peers when decisive.
                multipath: {
                    inputs: ['momentum', 'acceleration', 'macdHistN', 'supertrend', 'peerMean'],
                    weights: [0.4, 0.3, 0.35, 0.3, 0.35],
                    bias: 0.0, threshold: 0.05, decay: 0.12, recurrentWeight: 0.35
                },
                // Explicit conflict measurement between peers.
                conflict: {
                    inputs: ['peerSpread', 'peerDisagree', 'anomalyLevel', 'trapLevel'],
                    weights: [0.5, 0.5, 0.3, 0.35],
                    bias: -0.4, threshold: 0.03, decay: 0.15, recurrentWeight: 0.25
                },
                // Volatility adaptation: shrinks exposure as chop rises.
                voladapt: {
                    inputs: ['volatility', 'adxN', 'bbWidth', 'volAnomaly', 'physicsVolatility', 'physicsJumpRisk', 'physicsImpact'],
                    weights: [0.45, -0.4, 0.3, 0.25, 0.35, 0.35, 0.25],
                    bias: -0.15, threshold: 0.05, decay: 0.12, recurrentWeight: 0.3
                },
                // Rapid response to fresh information.
                rapid: {
                    inputs: ['ret1', 'body', 'takerImb', 'volChange'],
                    weights: [0.45, 0.4, 0.35, 0.3],
                    bias: 0.0, threshold: 0.06, decay: 0.2, recurrentWeight: 0.45
                }
            },
            compute: function (features, ctx, agent) {
                const f = features || {};
                const context = ctx || {};
                const peers = context.peers || {};

                function peerBias(id) {
                    const p = peers[id];
                    return p && Number.isFinite(p.bias) ? C.clamp(p.bias, -1, 1) : 0;
                }
                function peerConf(id) {
                    const p = peers[id];
                    return p && Number.isFinite(p.confidence) ? C.clamp(p.confidence, 0, 1) : 0.5;
                }

                const PEER_IDS = ['chimpanzee', 'raven', 'dolphin', 'elephant', 'eagle', 'owl', 'dragonfly'];
                function weightedPeer(id) {
                    // A peer that is not present contributes nothing at all
                    // (not a zero vote), so a missing/degraded agent module
                    // cannot drag the consensus toward neutral.
                    if (!peers[id]) return null;
                    return peerBias(id) * (0.5 + peerConf(id) * 0.5);
                }
                const peerMap = {};
                const peerVals = [];
                PEER_IDS.forEach(function (id) {
                    const v = weightedPeer(id);
                    peerMap[id] = v === null ? 0 : v;
                    if (v !== null) peerVals.push(v);
                });
                const chimp = peerMap.chimpanzee;
                const raven = peerMap.raven;
                const dolphin = peerMap.dolphin;
                const elephant = peerMap.elephant;
                const eagle = peerMap.eagle;
                const owl = peerMap.owl;
                const dragonfly = peerMap.dragonfly;
                const effectivePeers = peerVals.length > 0 ? peerVals : [0];
                const peerMean = effectivePeers.reduce(function (a, b) { return a + b; }, 0) / effectivePeers.length;
                const peerSpread = C.std(effectivePeers);
                const signs = effectivePeers.map(function (v) { return v >= 0 ? 1 : -1; });
                const peerDisagree = 1 - Math.abs(C.mean(signs));

                const anomalyLevel = peers.raven && peers.raven.output && Number.isFinite(peers.raven.output.anomalyScore)
                    ? peers.raven.output.anomalyScore : 0;
                const trapLevel = peers.raven && peers.raven.output && Number.isFinite(peers.raven.output.trapProbability)
                    ? peers.raven.output.trapProbability : 0;

                const enriched = Object.assign({}, f, {
                    peerChimp: chimp, peerRaven: raven, peerDolphin: dolphin,
                    peerElephant: elephant, peerEagle: eagle, peerOwl: owl,
                    peerDragonfly: dragonfly, peerMean: peerMean,
                    peerSpread: C.clamp(peerSpread * 2, 0, 1),
                    peerDisagree: C.clamp(peerDisagree, 0, 1),
                    anomalyLevel: C.clamp(anomalyLevel, 0, 1),
                    trapLevel: C.clamp(trapLevel, 0, 1)
                });

                const N = agent.neurons;
                const adaptive = N.adaptive.forward(enriched);
                const multipath = N.multipath.forward(enriched);
                const conflict = N.conflict.forward(enriched);
                const voladapt = N.voladapt.forward(enriched);
                const rapid = N.rapid.forward(enriched);

                const conflictScore = C.clamp((conflict.activation + 1) / 2, 0, 1);
                const volStress = C.clamp((voladapt.activation + 1) / 2, 0, 1);

                // Adaptive bias: peers lead, market path + rapid adjust,
                // conflict and volatility stress shrink the signal.
                let adaptiveBias = C.clamp(
                    adaptive.activation * 0.5 + multipath.activation * 0.3 + rapid.activation * 0.2, -1, 1);
                adaptiveBias *= (1 - conflictScore * 0.55) * (1 - volStress * 0.3);

                const regimeAdaptation = C.clamp(1 - volStress * 0.6 - conflictScore * 0.25, 0, 1);
                const adaptationConfidence = C.clamp(
                    0.3 + (1 - conflictScore) * 0.4 + regimeAdaptation * 0.2, 0.05, 0.96);

                const factors = [
                    { label: 'Peer consensus', value: C.clamp(adaptive.activation, -1, 1), weight: 0.4 },
                    { label: 'Signal conflict', value: C.clamp(-conflict.activation, -1, 1), weight: 0.4 },
                    { label: 'Market path', value: C.clamp(multipath.activation, -1, 1), weight: 0.3 },
                    { label: 'Volatility stress', value: C.clamp(-voladapt.activation, -1, 1), weight: 0.3 },
                    { label: 'Rapid response', value: C.clamp(rapid.activation, -1, 1), weight: 0.2 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: adaptiveBias,
                    confidence: adaptationConfidence,
                    output: {
                        adaptiveBias: adaptiveBias,
                        regimeAdaptation: regimeAdaptation,
                        conflictScore: conflictScore,
                        adaptationConfidence: adaptationConfidence
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
        id: 'octopus',
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
