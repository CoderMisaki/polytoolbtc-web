/* synapticNetwork.js — dynamic inter-agent synaptic connections.
 * Each synapse: source, target, weight, activation, reliability, decay,
 * lastUpdated. Weights adapt from SIMULATED trade outcomes with hard
 * clamps so they cannot run away. Reproducible: persisted via safeStore.
 * UMD: window.SynapticNetwork, module.exports for tests.
 */
(function SynapticUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.SynapticNetwork = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildSynaptic(root) {
    'use strict';

    const MIN_WEIGHT = 0.05;
    const MAX_WEIGHT = 0.95;
    const LEARNING_RATE = 0.02;
    const STORE_KEY = 'masako_neural_synapses_v1';

    const EDGE_DEFS = [
        { source: 'chimpanzee', target: 'octopus', weight: 0.82 },
        { source: 'raven', target: 'octopus', weight: 0.91 },
        { source: 'dolphin', target: 'octopus', weight: 0.60 },
        { source: 'elephant', target: 'octopus', weight: 0.55 },
        { source: 'eagle', target: 'octopus', weight: 0.68 },
        { source: 'owl', target: 'octopus', weight: 0.58 },
        { source: 'dragonfly', target: 'octopus', weight: 0.62 },
        { source: 'chimpanzee', target: 'meta', weight: 0.80 },
        { source: 'raven', target: 'meta', weight: 0.70 },
        { source: 'dolphin', target: 'meta', weight: 0.65 },
        { source: 'elephant', target: 'meta', weight: 0.88 },
        { source: 'eagle', target: 'meta', weight: 0.72 },
        { source: 'owl', target: 'meta', weight: 0.60 },
        { source: 'dragonfly', target: 'meta', weight: 0.55 },
        { source: 'octopus', target: 'meta', weight: 0.85 },
        { source: 'chimpanzee', target: 'raven', weight: 0.40 },
        { source: 'raven', target: 'chimpanzee', weight: 0.35 },
        { source: 'dolphin', target: 'chimpanzee', weight: 0.45 },
        { source: 'elephant', target: 'chimpanzee', weight: 0.50 },
        // Wide-field structure feeds the tactical brain; quiet observation and
        // rapid detection cross-check each other before reaching the meta layer.
        { source: 'eagle', target: 'chimpanzee', weight: 0.48 },
        { source: 'owl', target: 'raven', weight: 0.42 },
        { source: 'dragonfly', target: 'raven', weight: 0.44 },
        { source: 'owl', target: 'dragonfly', weight: 0.38 },
        { source: 'dragonfly', target: 'owl', weight: 0.34 }
    ];

    function core() {
        if (root && root.NeuralCore) return root.NeuralCore;
        if (typeof NeuralCore !== 'undefined') return NeuralCore;
        try {
            if (typeof require === 'function') return require('./neuralCore');
        } catch (e) { /* unreachable in browser when ordered */ }
        return null;
    }

    function safeStoreFn() {
        if (root && typeof root.safeStore === 'function') return root.safeStore;
        if (typeof safeStore === 'function') return safeStore;
        return null;
    }

    function safeLoadFn() {
        if (root && typeof root.safeLoad === 'function') return root.safeLoad;
        if (typeof safeLoad === 'function') return safeLoad;
        return null;
    }

    function create() {
        const C = core();
        const net = {
            synapses: [],
            byKey: {},
            updates: 0
        };

        function keyOf(source, target) { return source + '->' + target; }

        net.build = function () {
            net.synapses = [];
            net.byKey = {};
            EDGE_DEFS.forEach(function (def) {
                const s = new C.Synapse({
                    source: def.source,
                    target: def.target,
                    weight: def.weight,
                    reliability: 0.7,
                    decay: 0.02
                });
                net.synapses.push(s);
                net.byKey[keyOf(def.source, def.target)] = s;
            });
            net.restore();
            return net;
        };

        net.restore = function () {
            try {
                const load = safeLoadFn();
                if (!load) return;
                const saved = load(STORE_KEY, null);
                if (!saved || typeof saved !== 'object') return;
                Object.keys(saved).forEach(function (key) {
                    const s = net.byKey[key];
                    const w = saved[key];
                    if (s && Number.isFinite(w)) {
                        s.weight = C.clamp(w, MIN_WEIGHT, MAX_WEIGHT);
                        s.baseline = s.weight;
                    }
                });
            } catch (e) { /* corrupted store: keep defaults */ }
        };

        net.persist = function () {
            try {
                const store = safeStoreFn();
                if (!store) return;
                const payload = {};
                net.synapses.forEach(function (s) { payload[keyOf(s.source, s.target)] = s.weight; });
                store(STORE_KEY, payload);
            } catch (e) { /* storage unavailable */ }
        };

        net.get = function (source, target) {
            return net.byKey[keyOf(source, target)] || null;
        };

        net.outgoing = function (source) {
            return net.synapses.filter(function (s) { return s.source === source; });
        };

        net.incoming = function (target) {
            return net.synapses.filter(function (s) { return s.target === target; });
        };

        /**
         * Propagate agent signals through the network. Returns per-target
         * aggregated modulation in [-1, 1].
         */
        net.propagate = function (agentResults, nowMs) {
            const now = Number.isFinite(nowMs) ? nowMs : Date.now();
            const byId = {};
            (agentResults || []).forEach(function (r) {
                if (r && r.id) byId[r.id] = r;
            });
            const acc = {};
            const wsum = {};
            net.synapses.forEach(function (s) {
                const src = byId[s.source];
                const signal = src && Number.isFinite(src.bias) ? src.bias : 0;
                const conf = src && Number.isFinite(src.confidence) ? src.confidence : 0.5;
                s.reliability = C.clamp(0.5 + conf * 0.5, 0, 1);
                const out = s.propagate(signal, now);
                acc[s.target] = (acc[s.target] || 0) + out;
                wsum[s.target] = (wsum[s.target] || 0) + s.weight;
            });
            const modulation = {};
            Object.keys(acc).forEach(function (target) {
                modulation[target] = wsum[target] > 0 ? C.clamp(acc[target] / wsum[target], -1, 1) : 0;
            });
            net.updates++;
            return modulation;
        };

        /**
         * Adapt weights from a simulated outcome. `correctByAgent` maps
         * agent id -> true/false (prediction matched outcome direction).
         */
        net.updateFromOutcome = function (correctByAgent) {
            const map = correctByAgent || {};
            let touched = false;
            net.synapses.forEach(function (s) {
                if (!Object.prototype.hasOwnProperty.call(map, s.source)) return;
                touched = true;
                if (map[s.source]) s.nudge(LEARNING_RATE, MIN_WEIGHT, MAX_WEIGHT);
                else s.nudge(-LEARNING_RATE * 1.5, MIN_WEIGHT, MAX_WEIGHT);
                s.applyDecay();
            });
            if (touched) {
                net.persist();
            }
            return touched;
        };

        net.applyDecayAll = function () {
            net.synapses.forEach(function (s) { s.applyDecay(); });
        };

        net.strengthTo = function (target) {
            const inc = net.incoming(target);
            if (inc.length === 0) return 0;
            return C.clamp(C.mean(inc.map(function (s) { return s.weight; })), 0, 1);
        };

        net.snapshot = function () {
            return net.synapses.map(function (s) {
                return {
                    source: s.source,
                    target: s.target,
                    weight: s.weight,
                    activation: s.activation,
                    reliability: s.reliability,
                    lastUpdated: s.lastUpdated
                };
            });
        };

        net.reset = function () {
            net.build();
        };

        net.build();
        return net;
    }

    let instance = null;
    function get() {
        if (!instance) instance = create();
        return instance;
    }

    return {
        MIN_WEIGHT: MIN_WEIGHT,
        MAX_WEIGHT: MAX_WEIGHT,
        LEARNING_RATE: LEARNING_RATE,
        EDGE_DEFS: EDGE_DEFS,
        get: get,
        create: create
    };
});
