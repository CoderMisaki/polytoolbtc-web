/* neuralCore.js — biologically-inspired computational primitives.
 * Real computation: tanh neurons with weighted inputs, bias, recurrent state,
 * signal decay, activation thresholds and temporal memory. No fake neurons.
 * UMD: window.NeuralCore in browsers, module.exports in Node (deterministic).
 */
(function NeuralCoreUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.NeuralCore = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildNeuralCore() {
    'use strict';

    function clamp(value, min, max) {
        if (!Number.isFinite(value)) return 0;
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    function tanh(x) {
        if (!Number.isFinite(x)) return 0;
        // Bounded, numerically stable tanh.
        if (x > 20) return 1;
        if (x < -20) return -1;
        const e2x = Math.exp(2 * x);
        return (e2x - 1) / (e2x + 1);
    }

    function sigmoid(x) {
        if (!Number.isFinite(x)) return 0.5;
        if (x >= 0) {
            const z = Math.exp(-x);
            return 1 / (1 + z);
        }
        const z = Math.exp(x);
        return z / (1 + z);
    }

    // Soft clamp for unbounded signals into (-1, 1).
    function softClamp(x) {
        if (!Number.isFinite(x)) return 0;
        return x / (1 + Math.abs(x));
    }

    function mean(values) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < values.length; i++) {
            if (Number.isFinite(values[i])) { sum += values[i]; n++; }
        }
        return n > 0 ? sum / n : 0;
    }

    function std(values, avg) {
        if (!Array.isArray(values) || values.length === 0) return 0;
        const m = Number.isFinite(avg) ? avg : mean(values);
        let sum = 0;
        let n = 0;
        for (let i = 0; i < values.length; i++) {
            if (Number.isFinite(values[i])) { sum += (values[i] - m) * (values[i] - m); n++; }
        }
        return n > 0 ? Math.sqrt(sum / n) : 0;
    }

    // Deterministic PRNG (mulberry32) so weights are reproducible.
    function mulberry32(seed) {
        let a = seed >>> 0;
        return function next() {
            a |= 0;
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function hashSeed(str) {
        const s = String(str || '');
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function initWeights(count, seed, scale) {
        const rand = mulberry32(hashSeed(seed));
        const out = [];
        const amp = Number.isFinite(scale) ? scale : 0.5;
        for (let i = 0; i < count; i++) {
            out.push((rand() * 2 - 1) * amp);
        }
        return out;
    }

    /**
     * A computational neuron:
     *   activation = tanh(weightedInputs + bias + recurrent*recurrentWeight)
     * with signal decay (trace), threshold gating and temporal memory.
     */
    function Neuron(config) {
        config = config || {};
        this.id = config.id || 'neuron';
        this.inputKeys = Array.isArray(config.inputs) ? config.inputs.slice() : [];
        this.weights = Array.isArray(config.weights)
            ? config.weights.slice()
            : initWeights(this.inputKeys.length, config.seed || this.id, config.weightScale);
        while (this.weights.length < this.inputKeys.length) this.weights.push(0);
        this.bias = Number.isFinite(config.bias) ? config.bias : 0;
        this.threshold = Number.isFinite(config.threshold) ? Math.abs(config.threshold) : 0;
        this.decay = clamp(Number.isFinite(config.decay) ? config.decay : 0.15, 0, 0.9);
        this.recurrentWeight = Number.isFinite(config.recurrentWeight) ? config.recurrentWeight : 0.25;
        this.state = 0;      // recurrent activation (temporal memory)
        this.trace = 0;      // decayed signal trace
        this.lastRaw = 0;
        this.lastActivation = 0;
        this.updates = 0;
    }

    Neuron.prototype.reset = function () {
        this.state = 0;
        this.trace = 0;
        this.lastRaw = 0;
        this.lastActivation = 0;
        this.updates = 0;
    };

    Neuron.prototype.forward = function (inputMap) {
        const src = inputMap || {};
        let sum = this.bias;
        let activeInputs = 0;
        for (let i = 0; i < this.inputKeys.length; i++) {
            const v = src[this.inputKeys[i]];
            if (!Number.isFinite(v)) continue;
            sum += this.weights[i] * v;
            activeInputs++;
        }
        // Recurrent temporal memory: previous activation feeds back in.
        sum += this.state * this.recurrentWeight;
        this.lastRaw = sum;
        let activation = tanh(sum);
        // Threshold gating: weak signals stay silent (sparse coding).
        if (Math.abs(activation) < this.threshold) activation = 0;
        // Signal decay: trace blends new activation with history.
        this.trace = this.trace * this.decay + activation * (1 - this.decay);
        this.state = activation;
        this.lastActivation = activation;
        this.updates++;
        return {
            activation: activation,
            trace: this.trace,
            raw: sum,
            activeInputs: activeInputs
        };
    };

    /**
     * Minimal synapse between two nodes: gated, weighted, decaying signal.
     */
    function Synapse(config) {
        config = config || {};
        this.source = config.source || '';
        this.target = config.target || '';
        this.weight = clamp(Number.isFinite(config.weight) ? config.weight : 0.5, 0, 1);
        this.baseline = this.weight;
        this.activation = 0;
        this.reliability = clamp(Number.isFinite(config.reliability) ? config.reliability : 0.7, 0, 1);
        this.decay = clamp(Number.isFinite(config.decay) ? config.decay : 0.02, 0, 0.5);
        this.lastUpdated = 0;
    }

    Synapse.prototype.propagate = function (signal, nowMs) {
        const s = Number.isFinite(signal) ? clamp(signal, -1, 1) : 0;
        const out = s * this.weight * (0.5 + 0.5 * this.reliability);
        this.activation = out;
        this.lastUpdated = Number.isFinite(nowMs) ? nowMs : Date.now();
        return out;
    };

    Synapse.prototype.nudge = function (delta, min, max) {
        const lo = Number.isFinite(min) ? min : 0.05;
        const hi = Number.isFinite(max) ? max : 0.95;
        this.weight = clamp(this.weight + delta, lo, hi);
        this.lastUpdated = Date.now();
    };

    Synapse.prototype.applyDecay = function () {
        // Slow mean-reversion toward baseline so weights cannot run away.
        this.weight += (this.baseline - this.weight) * this.decay;
    };

    /**
     * Agent factory: owns neurons, activation/confidence bookkeeping,
     * reliability tracking and error-isolated processing.
     */
    function createAgent(def) {
        def = def || {};
        const agent = {
            id: def.id || 'agent',
            name: def.name || 'Agent',
            icon: def.icon || '?',
            role: def.role || '',
            neurons: {},
            status: 'INITIALIZING',
            activation: 0,
            confidence: 0,
            bias: 0,
            reliability: Number.isFinite(def.reliability) ? clamp(def.reliability, 0, 1) : 0.7,
            lastOutput: null,
            lastFactors: [],
            lastError: null,
            processCount: 0,
            errorCount: 0,
            _compute: typeof def.compute === 'function' ? def.compute : null
        };

        const neuronDefs = def.neurons || {};
        Object.keys(neuronDefs).forEach(function (key) {
            const cfg = neuronDefs[key] || {};
            cfg.id = def.id + '.' + key;
            cfg.seed = cfg.seed || (def.id + '.' + key);
            agent.neurons[key] = new Neuron(cfg);
        });

        agent.reset = function () {
            Object.keys(agent.neurons).forEach(function (key) { agent.neurons[key].reset(); });
            agent.status = 'INITIALIZING';
            agent.activation = 0;
            agent.confidence = 0;
            agent.bias = 0;
            agent.lastOutput = null;
            agent.lastFactors = [];
            agent.lastError = null;
            agent.processCount = 0;
        };

        agent.neuronActivations = function () {
            const out = {};
            Object.keys(agent.neurons).forEach(function (key) {
                out[key] = agent.neurons[key].lastActivation;
            });
            return out;
        };

        // Error-isolated processing: an agent failure degrades the agent,
        // never the caller.
        agent.safeProcess = function (features, ctx) {
            try {
                if (typeof agent._compute !== 'function') throw new Error('no-compute');
                const result = agent._compute(features, ctx || {}, agent);
                agent.processCount++;
                agent.status = 'ACTIVE';
                agent.lastError = null;
                if (result && typeof result === 'object') {
                    agent.bias = clamp(Number.isFinite(result.bias) ? result.bias : 0, -1, 1);
                    agent.confidence = clamp(Number.isFinite(result.confidence) ? result.confidence : 0, 0, 1);
                    const acts = Object.keys(agent.neurons).map(function (k) {
                        return Math.abs(agent.neurons[k].lastActivation);
                    });
                    agent.activation = clamp(mean(acts), 0, 1);
                    agent.lastOutput = result.output || null;
                    agent.lastFactors = Array.isArray(result.factors) ? result.factors.slice(0, 6) : [];
                }
                return {
                    ok: true,
                    id: agent.id,
                    bias: agent.bias,
                    confidence: agent.confidence,
                    activation: agent.activation,
                    reliability: agent.reliability,
                    output: agent.lastOutput,
                    factors: agent.lastFactors
                };
            } catch (err) {
                agent.errorCount++;
                agent.status = 'DEGRADED';
                agent.lastError = err && err.message ? err.message : String(err);
                // Keep last known output but mark confidence down.
                agent.confidence = agent.confidence * 0.5;
                return {
                    ok: false,
                    id: agent.id,
                    bias: agent.bias,
                    confidence: agent.confidence,
                    activation: 0,
                    reliability: agent.reliability * 0.9,
                    output: agent.lastOutput,
                    factors: agent.lastFactors,
                    error: agent.lastError
                };
            }
        };

        agent.recordOutcome = function (correct, learningRate) {
            const lr = clamp(Number.isFinite(learningRate) ? learningRate : 0.02, 0, 0.2);
            if (correct) agent.reliability = clamp(agent.reliability + lr, 0.05, 0.98);
            else agent.reliability = clamp(agent.reliability - lr * 1.5, 0.05, 0.98);
        };

        return agent;
    }

    function cosineSimilarity(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
        let dot = 0;
        let na = 0;
        let nb = 0;
        for (let i = 0; i < a.length; i++) {
            const x = Number.isFinite(a[i]) ? a[i] : 0;
            const y = Number.isFinite(b[i]) ? b[i] : 0;
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        if (na === 0 || nb === 0) return 0;
        return clamp(dot / (Math.sqrt(na) * Math.sqrt(nb)), -1, 1);
    }

    return {
        clamp: clamp,
        tanh: tanh,
        sigmoid: sigmoid,
        softClamp: softClamp,
        mean: mean,
        std: std,
        mulberry32: mulberry32,
        hashSeed: hashSeed,
        initWeights: initWeights,
        cosineSimilarity: cosineSimilarity,
        Neuron: Neuron,
        Synapse: Synapse,
        createAgent: createAgent
    };
});
