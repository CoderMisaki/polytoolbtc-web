/* metaBrain.js — META BRAIN: fuses all animal agents into one
 * collective trading decision. Computes consensus, disagreement,
 * confidence, directional probability, risk and market regime.
 * Never opens positions itself; output feeds the existing AI signal
 * and risk gate first. UMD: window.MetaBrain, module.exports.
 */
(function MetaBrainUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.MetaBrain = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildMetaBrain(root) {
    'use strict';

    const AGENT_IDS = [
        'chimpanzee', 'raven', 'dolphin', 'elephant',
        'eagle', 'owl', 'dragonfly',
        'octopus'
    ];

    function core() {
        if (root && root.NeuralCore) return root.NeuralCore;
        if (typeof NeuralCore !== 'undefined') return NeuralCore;
        try {
            if (typeof require === 'function') return require('./neuralCore');
        } catch (e) { /* unreachable in browser when ordered */ }
        return null;
    }

    function synapses() {
        if (root && root.SynapticNetwork) return root.SynapticNetwork.get();
        if (typeof SynapticNetwork !== 'undefined') return SynapticNetwork.get();
        try {
            if (typeof require === 'function') return require('./synapticNetwork').get();
        } catch (e) { /* unreachable in browser when ordered */ }
        return null;
    }

    /**
     * Decide from agent results.
     * agentResults: [{ id, bias, confidence, reliability, ok, output }]
     * marketCtx: { volatility, anomalyScore, trapProbability, dataQuality,
     *              jumpRisk, tailRisk, marketImpact }
     */
    function decide(agentResults, marketCtx) {
        const C = core();
        const ctx = marketCtx || {};
        const results = Array.isArray(agentResults) ? agentResults : [];
        const byId = {};
        results.forEach(function (r) { if (r && r.id) byId[r.id] = r; });

        let net = null;
        try { net = synapses(); } catch (e) { net = null; }

        const active = [];
        const weights = {};
        AGENT_IDS.forEach(function (id) {
            const r = byId[id];
            if (!r || r.ok === false) return;
            const reliability = Number.isFinite(r.reliability) ? r.reliability : 0.5;
            const confidence = Number.isFinite(r.confidence) ? r.confidence : 0.5;
            let synW = 0.7;
            try {
                const s = net ? net.get(id, 'meta') : null;
                if (s && Number.isFinite(s.weight)) synW = s.weight;
            } catch (e) { /* default stands */ }
            // Degraded/failed agents contribute ~0: excluded or down-weighted.
            const w = Math.max(0.02, reliability * (0.4 + confidence * 0.6) * synW);
            weights[id] = w;
            active.push(r);
        });

        if (active.length === 0) {
            return {
                decision: 'NEUTRAL',
                confidence: 0,
                consensus: 0,
                disagreement: 1,
                directionalProbability: 0.5,
                risk: 1,
                regime: 'UNKNOWN',
                activeAgents: 0,
                weights: weights,
                longVotes: 0,
                shortVotes: 0
            };
        }

        let wSum = 0;
        let biasSum = 0;
        let confSum = 0;
        let longVotes = 0;
        let shortVotes = 0;
        const biases = [];
        active.forEach(function (r) {
            const w = weights[r.id] || 0;
            const b = Number.isFinite(r.bias) ? C.clamp(r.bias, -1, 1) : 0;
            wSum += w;
            biasSum += w * b;
            confSum += w * (Number.isFinite(r.confidence) ? r.confidence : 0.5);
            biases.push(b);
            if (b > 0.12) longVotes++;
            else if (b < -0.12) shortVotes++;
        });

        // Wide-context pattern evidence (patternMemory.js) may nudge the
        // collective consensus, but never dominate it: the eight agents stay
        // the primary voters. When no corpus is loaded this is exactly 0 and
        // the decision math is bit-for-bit the previous behaviour.
        const patternBias = Number.isFinite(ctx.patternBias) ? C.clamp(ctx.patternBias, -1, 1) : 0;
        const patternWeight = Number.isFinite(ctx.patternWeight) ? C.clamp(ctx.patternWeight, 0, 0.4) : 0.18;
        let consensus = wSum > 0 ? C.clamp(biasSum / wSum, -1, 1) : 0;
        if (patternBias !== 0) {
            consensus = C.clamp(consensus + patternBias * patternWeight, -1, 1);
        }
        const meanConf = wSum > 0 ? confSum / wSum : 0;
        const disagreement = C.clamp(C.std(biases) * 1.5, 0, 1);

        const dataQuality = Number.isFinite(ctx.dataQuality) ? C.clamp(ctx.dataQuality, 0, 1) : 0.7;
        const expected = AGENT_IDS.length;
        const coveragePenalty = active.length < expected ? (expected - active.length) * 0.06 : 0;
        const confidence = C.clamp(
            (1 - disagreement) * 0.5 + meanConf * 0.35 + dataQuality * 0.15 - coveragePenalty, 0, 1);

        const directionalProbability = C.sigmoid(consensus * 4);

        const volatility = Number.isFinite(ctx.volatility) ? C.clamp(ctx.volatility, 0, 1) : 0.4;
        const anomaly = Number.isFinite(ctx.anomalyScore) ? C.clamp(ctx.anomalyScore, 0, 1) : 0;
        const trap = Number.isFinite(ctx.trapProbability) ? C.clamp(ctx.trapProbability, 0, 1) : 0;
        // Physics features describe observed jump/tail/impact pressure. They
        // only add a small risk component and never invent a direction.
        const jumpRisk = Number.isFinite(ctx.jumpRisk) ? C.clamp(ctx.jumpRisk, 0, 1) : 0;
        const tailRisk = Number.isFinite(ctx.tailRisk) ? C.clamp(ctx.tailRisk, 0, 1) : 0;
        const impact = Number.isFinite(ctx.marketImpact) ? C.clamp(ctx.marketImpact, 0, 1) : 0;
        const risk = C.clamp(
            disagreement * 0.30 + volatility * 0.22 + anomaly * 0.13 + trap * 0.13 +
            jumpRisk * 0.09 + tailRisk * 0.08 + impact * 0.05 + (1 - confidence) * 0.1, 0, 1);

        let regime = 'NEUTRAL';
        try {
            const dolphin = byId.dolphin;
            if (dolphin && dolphin.output && typeof dolphin.output.regime === 'string') {
                regime = dolphin.output.regime;
            }
        } catch (e) { /* keep NEUTRAL */ }

        let decision = 'NEUTRAL';
        if (consensus > 0.22 && confidence >= 0.5) decision = 'LONG';
        else if (consensus < -0.22 && confidence >= 0.5) decision = 'SHORT';

        return {
            decision: decision,
            confidence: confidence,
            consensus: consensus,
            disagreement: disagreement,
            directionalProbability: directionalProbability,
            risk: risk,
            regime: regime,
            activeAgents: active.length,
            weights: weights,
            longVotes: longVotes,
            shortVotes: shortVotes,
            patternBias: patternBias,
            jumpRisk: jumpRisk,
            tailRisk: tailRisk,
            marketImpact: impact
        };
    }

    return {
        AGENT_IDS: AGENT_IDS,
        decide: decide
    };
});
