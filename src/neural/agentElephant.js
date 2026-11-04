/* agentElephant.js — ELEPHANT BRAIN: Long-Term Memory + Historical Context.
 * Compares current market state against completed historical states and
 * reports what happened after similar states. NO look-ahead bias: memory
 * entries are only usable after their outcome horizon has fully elapsed,
 * i.e. only states strictly older than `horizon` candles are recalled.
 * UMD: registers window.AnimalAgents.Elephant, module.exports for tests.
 */
(function ElephantUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalAgents = root.AnimalAgents || {};
        root.AnimalAgents.Elephant = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildElephant(root) {
    'use strict';

    const MEMORY_CAP = 300;        // bounded ring buffer
    const RECALL_HORIZON = 10;     // candles before an outcome is observable
    const TOP_K = 8;               // similar states consulted

    function core() {
        if (root && root.NeuralCore) return root.NeuralCore;
        if (typeof NeuralCore !== 'undefined') return NeuralCore;
        try {
            if (typeof require === 'function') return require('./neuralCore');
        } catch (e) { /* unreachable in browser when ordered */ }
        return null;
    }

    function featureEngine() {
        if (root && root.NeuralFeatureEngine) return root.NeuralFeatureEngine;
        if (typeof NeuralFeatureEngine !== 'undefined') return NeuralFeatureEngine;
        try {
            if (typeof require === 'function') return require('./featureEngine');
        } catch (e) { /* unreachable in browser when ordered */ }
        return null;
    }

    function build() {
        const C = core();
        if (!C) throw new Error('NeuralCore missing for Elephant');

        // Long-term store lives outside neurons (bounded, recency-weighted).
        const memory = {
            states: [],
            push: function (entry) {
                this.states.push(entry);
                if (this.states.length > MEMORY_CAP) {
                    this.states.splice(0, this.states.length - MEMORY_CAP);
                }
            },
            clear: function () { this.states.length = 0; }
        };

        const agent = C.createAgent({
            id: 'elephant',
            name: 'ELEPHANT',
            icon: '🐘',
            role: 'Historical Memory',
            reliability: 0.7,
            neurons: {
                // Encodes regime fingerprint of the current state.
                ltm: {
                    inputs: ['adxN', 'volatility', 'bbWidth', 'mtf1h', 'mtf1d', 'emaD200', 'patAnalogEdge'],
                    weights: [0.45, 0.35, 0.3, 0.35, 0.35, 0.3, 0.3],
                    bias: 0.0, threshold: 0.05, decay: 0.05, recurrentWeight: 0.5
                },
                // Historical similarity channel (recall score fed as input).
                similarity: {
                    inputs: ['recallScore', 'recallAgreement', 'memoryDepth'],
                    weights: [0.6, 0.45, 0.3],
                    bias: -0.2, threshold: 0.05, decay: 0.1, recurrentWeight: 0.35
                },
                // Regime memory: is this volatility regime familiar?
                regimeMemory: {
                    inputs: ['volatility', 'volAnomaly', 'adxN', 'rangeAtr'],
                    weights: [0.4, 0.35, 0.4, 0.3],
                    bias: -0.1, threshold: 0.06, decay: 0.06, recurrentWeight: 0.5
                },
                // Experience: outcome direction of recalled states.
                experience: {
                    inputs: ['recallBias', 'recallScore', 'memoryDepth', 'patAnalogBias'],
                    weights: [0.65, 0.3, 0.25, 0.5],
                    bias: 0.0, threshold: 0.05, decay: 0.1, recurrentWeight: 0.35
                },
                // Recency weighting: fresh memories count more.
                recency: {
                    inputs: ['memoryDepth', 'recallScore', 'volatility'],
                    weights: [0.5, 0.3, -0.2],
                    bias: 0.0, threshold: 0.05, decay: 0.08, recurrentWeight: 0.4
                }
            },
            compute: function (features, ctx, self) {
                const f = features || {};
                const context = ctx || {};
                const N = self.neurons;

                // 1) Observe: store snapshot of a PAST state whose outcome is
                // now known (called by the orchestrator with lagged data).
                // 2) Recall: compare current state vs completed memories only.
                const recall = recallSimilar(f, context.currentIndex);

                const enriched = Object.assign({}, f, {
                    recallScore: recall.similarity,
                    recallAgreement: recall.agreement,
                    recallBias: recall.outcomeBias,
                    memoryDepth: recall.depth
                });

                const ltm = N.ltm.forward(enriched);
                const similarity = N.similarity.forward(enriched);
                const regimeMemory = N.regimeMemory.forward(enriched);
                const experience = N.experience.forward(enriched);
                const recency = N.recency.forward(enriched);

                // No recall -> no similarity claim (never fake confidence).
                const hasRecall = recall.used > 0;
                const historicalSimilarity = hasRecall ? C.clamp((similarity.activation + 1) / 2, 0, 1) : 0;
                const historicalOutcomeBias = hasRecall ? C.clamp(experience.activation, -1, 1) : 0;
                const memoryConfidence = C.clamp(
                    historicalSimilarity * 0.5 + recall.depth * 0.25 +
                    (recency.activation + 1) / 2 * 0.15 + (ltm.activation + 1) / 2 * 0.1, 0, 1);

                // Bias follows recalled outcomes, scaled by memory confidence.
                const bias = C.clamp(historicalOutcomeBias * (0.3 + memoryConfidence * 0.7), -1, 1);
                const confidence = C.clamp(0.2 + memoryConfidence * 0.6 + Math.abs(historicalOutcomeBias) * 0.15, 0.05, 0.95);

                const factors = [
                    { label: 'Historical similarity', value: C.clamp(similarity.activation, -1, 1), weight: 0.4 },
                    { label: 'Recalled outcome', value: C.clamp(experience.activation, -1, 1), weight: 0.45 },
                    { label: 'Regime familiarity', value: C.clamp(regimeMemory.activation, -1, 1), weight: 0.25 },
                    { label: 'Memory depth', value: C.clamp(recency.activation, -1, 1), weight: 0.2 }
                ];
                factors.sort(function (a, b) { return Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight); });

                return {
                    bias: bias,
                    confidence: confidence,
                    output: {
                        historicalSimilarity: historicalSimilarity,
                        historicalOutcomeBias: historicalOutcomeBias,
                        memoryConfidence: memoryConfidence,
                        recalledStates: recall.used,
                        regimeFamiliarity: C.clamp((regimeMemory.activation + 1) / 2, 0, 1)
                    },
                    factors: factors.slice(0, 4)
                };
            }
        });

        function recallSimilar(features, currentIndex) {
            const FE = featureEngine();
            const states = memory.states;
            if (!FE || states.length === 0) {
                return { similarity: 0, agreement: 0, outcomeBias: 0, depth: 0, used: 0 };
            }
            const nowIdx = Number.isFinite(currentIndex) ? currentIndex : Infinity;
            const vec = FE.toMemoryVector(features);
            const scored = [];
            // Only completed states: strictly older than the outcome horizon.
            for (let i = 0; i < states.length; i++) {
                const s = states[i];
                if (!s || !Number.isFinite(s.outcome)) continue;
                if (Number.isFinite(s.index) && s.index > nowIdx - RECALL_HORIZON) continue;
                const sim = C.cosineSimilarity(vec, s.vector);
                if (sim > 0.55) scored.push({ sim: sim, outcome: s.outcome, age: states.length - i });
            }
            scored.sort(function (a, b) { return b.sim - a.sim; });
            const top = scored.slice(0, TOP_K);
            if (top.length === 0) {
                return { similarity: 0, agreement: 0, outcomeBias: 0, depth: Math.min(1, states.length / 50), used: 0 };
            }
            let wSum = 0;
            let oSum = 0;
            let sSum = 0;
            for (let i = 0; i < top.length; i++) {
                const recencyW = 1 / (1 + Math.log(1 + top[i].age));
                const w = top[i].sim * recencyW;
                wSum += w;
                oSum += w * C.clamp(top[i].outcome, -1, 1);
                sSum += top[i].sim;
            }
            const outcomeBias = wSum > 0 ? oSum / wSum : 0;
            const similarity = sSum / top.length;
            const outcomes = top.map(function (t) { return t.outcome; });
            const agreement = 1 - Math.min(1, C.std(outcomes) * 1.4);
            return {
                similarity: C.clamp(similarity, 0, 1),
                agreement: C.clamp(agreement, 0, 1),
                outcomeBias: C.clamp(outcomeBias, -1, 1),
                depth: C.clamp(states.length / 120, 0, 1),
                used: top.length
            };
        }

        agent.observe = function (features, outcome, index) {
            const FE = featureEngine();
            if (!FE || !features || !Number.isFinite(outcome)) return false;
            try {
                memory.push({
                    vector: FE.toMemoryVector(features),
                    outcome: C.clamp(outcome, -1, 1),
                    index: Number.isFinite(index) ? index : -1,
                    at: Date.now()
                });
                return true;
            } catch (e) {
                return false;
            }
        };

        agent.memorySize = function () { return memory.states.length; };
        agent.clearMemory = function () { memory.clear(); };
        agent.RECALL_HORIZON = RECALL_HORIZON;

        const baseReset = agent.reset.bind(agent);
        agent.reset = function () {
            baseReset();
            memory.clear();
        };

        return agent;
    }

    let instance = null;
    function get() {
        if (!instance) instance = build();
        return instance;
    }

    return {
        id: 'elephant',
        RECALL_HORIZON: RECALL_HORIZON,
        get: get,
        safeProcess: function (features, ctx) { return get().safeProcess(features, ctx); },
        observe: function (features, outcome, index) { return get().observe(features, outcome, index); },
        memorySize: function () { return get().memorySize(); },
        clearMemory: function () { return get().clearMemory(); },
        reset: function () { get().reset(); },
        recordOutcome: function (correct, lr) { get().recordOutcome(correct, lr); }
    };
});
