/* animalNeuralSystem.js — ANIMAL NEURAL TRADING SYSTEM orchestrator.
 *
 *   MARKET DATA -> FEATURE EXTRACTION -> 8 ANIMAL AGENTS -> SYNAPTIC
 *   NETWORK -> META BRAIN -> RISK GATE -> EXISTING AI SIGNAL -> FUTURES SIM
 *
 * Secondary analysis path: the chart NEVER waits for this system.
 * Every agent runs error-isolated; a single agent failure degrades that
 * agent only. Deterministic, bounded, throttled, persisted learning.
 * UMD: window.AnimalNeuralSystem in browsers, module.exports in Node.
 */
(function AnimalNeuralUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AnimalNeuralSystem = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildAnimalNeural(root) {
    'use strict';

    const STATUS = {
        INITIALIZING: 'INITIALIZING',
        WARMING_UP: 'WARMING_UP',
        ACTIVE: 'ACTIVE',
        DEGRADED: 'DEGRADED',
        NO_DATA: 'NO_DATA',
        ERROR: 'ERROR'
    };

    // Octopus must stay last: it consumes every other agent's output.
    const AGENT_ORDER = [
        'chimpanzee', 'raven', 'dolphin', 'elephant',
        'eagle', 'owl', 'dragonfly',
        'octopus'
    ];
    const MIN_FULL_INTERVAL_MS = 2500;   // full recompute throttle
    const MIN_CANDLE_INTERVAL_MS = 900;  // min gap even on new candle
    const RESULT_STALE_MS = 20000;
    const MAX_CONSECUTIVE_ERRORS = 5;
    const STATS_KEY = 'masako_neural_stats_v1';
    const LEARNING_RATE = 0.02;
    const ELEPHANT_LAG = 10;             // candles before outcome is known

    function pick(name) {
        if (root && root[name]) return root[name];
        try {
            if (typeof require === 'function') {
                const map = {
                    NeuralCore: './neuralCore',
                    NeuralFeatureEngine: './featureEngine',
                    MetaBrain: './metaBrain',
                    NeuralRiskGate: './riskGate',
                    SynapticNetwork: './synapticNetwork',
                    CandleValidation: '../charts/candleValidation'
                };
                if (map[name]) return require(map[name]);
            }
        } catch (e) { /* browser: globals only */ }
        return null;
    }

    function agents() {
        if (root && root.AnimalAgents) return root.AnimalAgents;
        if (typeof AnimalAgents !== 'undefined') return AnimalAgents;
        return null;
    }

    function patternMiner() {
        if (root && root.PatternMemory) return root.PatternMemory;
        if (typeof PatternMemory !== 'undefined') return PatternMemory;
        try {
            if (typeof require === 'function') return require('./patternMemory');
        } catch (e) { /* optional module */ }
        return null;
    }

    function appState() {
        if (root && root.AppState) return root.AppState;
        if (typeof AppState !== 'undefined') return AppState;
        return null;
    }

    function storeGet(key, fallback) {
        try {
            if (root && typeof root.safeLoad === 'function') return root.safeLoad(key, fallback);
            if (typeof safeLoad === 'function') return safeLoad(key, fallback);
        } catch (e) { /* noop */ }
        return fallback;
    }

    function storeSet(key, value) {
        try {
            if (root && typeof root.storeSet === 'function') { root.storeSet(key, value); return; }
            if (root && typeof root.safeStore === 'function') { root.safeStore(key, value); return; }
            if (typeof safeStore === 'function') { safeStore(key, value); return; }
        } catch (e) { /* storage unavailable */ }
    }

    function now() { return Date.now(); }

    function clamp11(x) {
        if (!Number.isFinite(x)) return 0;
        if (x < -1) return -1;
        if (x > 1) return 1;
        return x;
    }

    // Safe reader for a numeric field inside an agent's output object.
    function agentOutput(peers, id, field) {
        const r = peers ? peers[id] : null;
        if (!r || !r.output) return 0;
        const v = r.output[field];
        return Number.isFinite(v) ? v : 0;
    }

    function fmtTime(ms) {
        try {
            const d = new Date(ms);
            const p = function (v) { return (v < 10 ? '0' : '') + v; };
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        } catch (e) { return '--:--:--'; }
    }

    const S = {
        status: STATUS.INITIALIZING,
        statusReason: 'boot',
        lastResult: null,
        lastComputeAt: 0,
        lastCandleTime: 0,
        consecutiveErrors: 0,
        computeCount: 0,
        pair: null,
        tf: null,
        events: [],
        listeners: [],
        pendingTrades: [],
        featureHistory: [],   // lagged { index, time, features, close, atr }
        stats: null,
        patterns: null,       // latest wide-context pattern analysis
        patternSource: null,  // { pair, frames, candles, fetchedAt, partial }
        patternBuilds: 0
    };

    function loadStats() {
        const fb = { trades: 0, wins: 0, agentCorrect: {}, agentTotal: {}, updatedAt: 0 };
        const saved = storeGet(STATS_KEY, null);
        if (saved && typeof saved === 'object') {
            S.stats = {
                trades: saved.trades || 0,
                wins: saved.wins || 0,
                agentCorrect: saved.agentCorrect || {},
                agentTotal: saved.agentTotal || {},
                updatedAt: saved.updatedAt || 0
            };
        } else {
            S.stats = fb;
        }
        return S.stats;
    }

    function persistStats() {
        S.stats.updatedAt = now();
        storeSet(STATS_KEY, S.stats);
    }

    function emitEvent(agent, text, kind) {
        const ev = { t: now(), clock: fmtTime(now()), agent: agent, text: text, kind: kind || 'info' };
        S.events.push(ev);
        if (S.events.length > 40) S.events.splice(0, S.events.length - 40);
        for (let i = 0; i < S.listeners.length; i++) {
            try { S.listeners[i](ev); } catch (e) { /* never break compute */ }
        }
    }

    function subscribe(listener) {
        if (typeof listener === 'function') S.listeners.push(listener);
        return function unsubscribe() {
            const i = S.listeners.indexOf(listener);
            if (i >= 0) S.listeners.splice(i, 1);
        };
    }

    function drainEvents(max) {
        const limit = Number.isFinite(max) ? max : 40;
        return S.events.slice(-limit);
    }

    function setStatus(status, reason) {
        if (S.status !== status) {
            S.status = status;
            S.statusReason = reason || '';
            emitEvent('SYSTEM', 'status -> ' + status + (reason ? ' (' + reason + ')' : ''), 'status');
        }
    }

    function buildSnapshot() {
        const AppState = appState();
        if (!AppState || !Array.isArray(AppState.candles) || AppState.candles.length === 0) {
            return { ok: false, reason: 'NO_DATA' };
        }
        return {
            ok: true,
            candles: AppState.candles,
            indicators: AppState.indicators || {},
            volSMA: AppState.volSMA || [],
            atrSMA: AppState.atrSMA || [],
            swings: AppState.swings || { highs: [], lows: [] },
            mtf: AppState.mtf || {},
            pair: AppState.g_pair,
            tf: AppState.g_tf,
            price: AppState.price,
            feed: AppState.feed || {}
        };
    }

    function checkFreshness(candles, tf) {
        try {
            const CV = pick('CandleValidation');
            if (CV && typeof CV.checkDataFreshness === 'function') {
                return CV.checkDataFreshness(candles, tf, now(), 3);
            }
        } catch (e) { /* fall through */ }
        if (!Array.isArray(candles) || candles.length === 0) {
            return { fresh: false, stale: true, reason: 'NO_DATA' };
        }
        return { fresh: true, stale: false, reason: 'ASSUMED_FRESH' };
    }

    function feedElephantMemory(snap, featureSet) {
        try {
            const A = agents();
            if (!A || !A.Elephant) return;
            const idx = featureSet.index;
            S.featureHistory.push({
                index: idx,
                time: featureSet.time,
                features: featureSet.features,
                close: featureSet.close,
                atr: featureSet.atr
            });
            if (S.featureHistory.length > ELEPHANT_LAG + 5) {
                S.featureHistory.splice(0, S.featureHistory.length - (ELEPHANT_LAG + 5));
            }
            // Finalize the state ELEPHANT_LAG candles ago: its forward outcome
            // is fully observed NOW, so storing it introduces no look-ahead.
            const past = S.featureHistory.length > ELEPHANT_LAG
                ? S.featureHistory[S.featureHistory.length - 1 - ELEPHANT_LAG]
                : null;
            if (past && Number.isFinite(past.close) && past.close > 0 && Number.isFinite(featureSet.close)) {
                const denom = Number.isFinite(past.atr) && past.atr > 0 ? past.atr : past.close * 0.005;
                const fwd = (featureSet.close - past.close) / denom;
                const outcome = fwd / (1 + Math.abs(fwd));
                A.Elephant.observe(past.features, outcome, past.index);
            }
        } catch (e) { /* memory is best-effort */ }
    }

    function computeFromSnapshot(snap) {
        const FE = pick('NeuralFeatureEngine');
        const MB = pick('MetaBrain');
        const RG = pick('NeuralRiskGate');
        const SN = pick('SynapticNetwork');
        const A = agents();
        if (!FE || !MB || !RG || !A) throw new Error('neural-modules-missing');

        const patternFeatures = S.patterns && S.patterns.ok ? S.patterns.features : null;
        const extracted = FE.extract({
            candles: snap.candles,
            indicators: snap.indicators,
            volSMA: snap.volSMA,
            atrSMA: snap.atrSMA,
            swings: snap.swings,
            mtf: snap.mtf,
            patternFeatures: patternFeatures
        });
        if (!extracted || extracted.ok !== true) {
            return { ok: false, reason: extracted ? extracted.reason : 'FEATURE_FAIL', extracted: extracted };
        }

        feedElephantMemory(snap, extracted);

        const f = extracted.features;
        // Order matters: Octopus consumes every other agent's output, so it
        // runs last. Missing agent modules degrade that agent only.
        const ctxBase = { pair: snap.pair, tf: snap.tf };
        const peers = {};
        const agentResults = [];
        const PEER_IDS = AGENT_ORDER.filter(function (id) { return id !== 'octopus'; });

        function runAgent(id, extraCtx) {
            const key = id.charAt(0).toUpperCase() + id.slice(1);
            const handle = A[key];
            if (!handle || typeof handle.safeProcess !== 'function') {
                return { ok: false, id: id, bias: 0, confidence: 0, activation: 0, reliability: 0, output: null, factors: [], error: 'agent-missing' };
            }
            return handle.safeProcess(f, extraCtx ? Object.assign({}, ctxBase, extraCtx) : ctxBase);
        }

        PEER_IDS.forEach(function (id) {
            const extra = id === 'elephant' ? { currentIndex: extracted.index } : null;
            const result = runAgent(id, extra);
            peers[id] = result;
            agentResults.push(result);
        });

        const octopus = runAgent('octopus', { peers: peers });
        agentResults.push(octopus);
        peers.octopus = octopus;
        peers.agents = Object.assign({}, peers);
        delete peers.agents.agents;

        const activeCount = agentResults.filter(function (r) { return r && r.ok; }).length;

        let modulation = {};
        try {
            if (SN) modulation = SN.get().propagate(agentResults, now());
        } catch (e) { modulation = {}; }

        const fresh = checkFreshness(snap.candles, snap.tf);
        const volNow = Number.isFinite(f.volatility) ? f.volatility : 0.4;
        const anomalyScore = agentOutput(peers, 'raven', 'anomalyScore');
        const trapProbability = agentOutput(peers, 'raven', 'trapProbability');

        const dataQuality = Math.max(0, Math.min(1,
            extracted.coverage * 0.6 + (fresh.fresh ? 0.3 : 0) + (activeCount / AGENT_ORDER.length) * 0.1));

        const patternBias = patternFeatures && Number.isFinite(patternFeatures.patAlignment)
            ? clamp11(patternFeatures.patAlignment)
            : 0;
        const meta = MB.decide(agentResults, {
            volatility: volNow,
            anomalyScore: anomalyScore,
            trapProbability: trapProbability,
            dataQuality: dataQuality,
            patternBias: patternBias,
            patternWeight: 0.18,
            jumpRisk: f.physicsJumpRisk,
            tailRisk: f.physicsTailRisk,
            marketImpact: f.physicsImpact
        });

        const AppState = appState();
        let existingPosition = false;
        try {
            const FE2 = (root && root.FuturesEngine) || (typeof FuturesEngine !== 'undefined' ? FuturesEngine : null);
            if (FE2 && FE2.state && Array.isArray(FE2.state.positions)) {
                existingPosition = FE2.state.positions.some(function (p) { return p && p.pair === snap.pair; });
            } else if (AppState && AppState._neuralPositionOpen === true) {
                existingPosition = true;
            }
        } catch (e) { /* default false */ }

        const liquidity = Number.isFinite(f.volAnomaly) ? Math.max(0, Math.min(1, f.volAnomaly)) : 0.5;
        const gate = RG.evaluate({
            meta: meta,
            dataQuality: dataQuality,
            fresh: fresh.fresh === true,
            stale: fresh.stale === true,
            volatility: volNow,
            liquidity: liquidity,
            jumpRisk: f.physicsJumpRisk,
            marketImpact: f.physicsImpact,
            riskReward: null,
            existingPosition: existingPosition,
            activeAgents: activeCount
        });

        return {
            ok: true,
            extracted: extracted,
            agents: peers.agents,
            agentResults: agentResults,
            activeCount: activeCount,
            modulation: modulation,
            meta: meta,
            gate: gate,
            dataQuality: dataQuality,
            fresh: fresh,
            pair: snap.pair,
            tf: snap.tf,
            time: now(),
            candleTime: extracted.time,
            patternFeatures: patternFeatures,
            patternBias: patternBias,
            patternFindings: S.patterns && S.patterns.ok ? S.patterns.findings : []
        };
    }

    function publishActivity(result) {
        try {
            const R = result.agents;
            const dirWord = function (b) { return b > 0.12 ? 'bullish' : (b < -0.12 ? 'bearish' : 'neutral'); };
            if (R.chimpanzee.ok) {
                emitEvent('CHIMPANZEE', dirWord(R.chimpanzee.bias) + ' pattern ' +
                    Math.round((R.chimpanzee.output.patternStrength || 0) * 100) + '%', 'agent');
            }
            if (R.raven.ok) {
                emitEvent('RAVEN', 'breakout quality ' +
                    Math.round((R.raven.output.breakoutQuality || 0) * 100) + '%, trap ' +
                    Math.round((R.raven.output.trapProbability || 0) * 100) + '%', 'agent');
            }
            if (R.dolphin.ok) {
                emitEvent('DOLPHIN', (R.dolphin.output.regime || 'NEUTRAL') +
                    ' buy pressure ' + Math.round((R.dolphin.output.buyPressure || 0) * 100) + '%', 'agent');
            }
            if (R.elephant.ok) {
                emitEvent('ELEPHANT', 'historical similarity ' +
                    Math.round((R.elephant.output.historicalSimilarity || 0) * 100) + '%', 'agent');
            }
            if (R.eagle && R.eagle.ok) {
                emitEvent('EAGLE', dirWord(R.eagle.bias) + ' structure align ' +
                    Math.round((R.eagle.output.structureAlignment || 0) * 100) + '%, selectivity ' +
                    Math.round((R.eagle.output.selectivity || 0) * 100) + '%', 'agent');
            }
            if (R.owl && R.owl.ok) {
                emitEvent('OWL', 'quiet ' + Math.round((R.owl.output.quietness || 0) * 100) +
                    '%, threat ' + Math.round((R.owl.output.threatLevel || 0) * 100) + '%', 'agent');
            }
            if (R.dragonfly && R.dragonfly.ok) {
                emitEvent('DRAGONFLY', 'impulse ' + dirWord(R.dragonfly.bias) +
                    ', reaction ' + Math.round((R.dragonfly.output.reactionSpeed || 0) * 100) + '%', 'agent');
            }
            if (R.octopus.ok) {
                emitEvent('OCTOPUS', 'conflict ' +
                    Math.round((R.octopus.output.conflictScore || 0) * 100) + '%, bias ' +
                    dirWord(R.octopus.bias), 'agent');
            }
            emitEvent('META BRAIN', result.meta.decision + ' confidence ' +
                Math.round(result.meta.confidence * 100) + '%', 'meta');
            const physics = result.extracted && result.extracted.physics;
            if (physics && physics.ok) {
                emitEvent('MARKET PHYSICS', 'jump ' + Math.round((physics.jumpRisk || 0) * 100) +
                    '%, impact ' + Math.round((physics.impact || 0) * 100) +
                    '%, liquidity ' + Math.round((physics.liquidity || 0) * 100) + '%', 'physics');
            }
            emitEvent('RISK GATE', result.gate.pass ? 'PASS' : result.gate.summary, result.gate.pass ? 'pass' : 'block');
        } catch (e) { /* logging never breaks compute */ }
    }

    function runCompute(reason) {
        const snap = buildSnapshot();
        if (!snap.ok) {
            setStatus(STATUS.NO_DATA, snap.reason);
            return null;
        }
        // Pair/timeframe switch resets recurrent state (no cross-pair memory).
        if (S.pair !== snap.pair || S.tf !== snap.tf) {
            resetForConfig(snap.pair, snap.tf);
        }
        let result = null;
        try {
            result = computeFromSnapshot(snap);
        } catch (err) {
            S.consecutiveErrors++;
            if (S.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                setStatus(STATUS.ERROR, err && err.message ? err.message : 'compute-failed');
            } else {
                setStatus(STATUS.DEGRADED, 'compute-error');
            }
            return null;
        }
        if (!result || result.ok !== true) {
            S.consecutiveErrors++;
            setStatus(result && result.reason === 'INSUFFICIENT_DATA' ? STATUS.WARMING_UP : STATUS.NO_DATA,
                result ? result.reason : 'unknown');
            return null;
        }

        S.consecutiveErrors = 0;
        S.computeCount++;
        S.lastComputeAt = now();
        S.lastCandleTime = result.candleTime;
        S.lastResult = result;

        if (result.activeCount >= 4 && result.dataQuality >= 0.5) {
            setStatus(STATUS.ACTIVE, reason || 'ok');
        } else if (result.activeCount >= 3) {
            setStatus(STATUS.DEGRADED, 'partial-agents');
        } else {
            setStatus(STATUS.DEGRADED, 'low-quorum');
        }

        publishActivity(result);
        return result;
    }

    function onMarketUpdate(info) {
        try {
            const inf = info || {};
            const t = now();
            const gap = t - S.lastComputeAt;
            const isNew = inf.isNewCandle === true;
            const minGap = isNew ? MIN_CANDLE_INTERVAL_MS : MIN_FULL_INTERVAL_MS;
            if (S.lastComputeAt > 0 && gap < minGap) return S.lastResult;
            return runCompute(isNew ? 'new-candle' : 'tick');
        } catch (e) {
            return S.lastResult;
        }
    }

    function warmup() {
        if (S.status === STATUS.ACTIVE) return S.lastResult;
        setStatus(STATUS.WARMING_UP, 'lifecycle-live');
        return runCompute('warmup');
    }

    function resetForConfig(pair, tf) {
        try {
            const A = agents();
            if (A) {
                AGENT_ORDER.forEach(function (id) {
                    const key = id.charAt(0).toUpperCase() + id.slice(1);
                    if (A[key] && typeof A[key].reset === 'function') A[key].reset();
                });
            }
        } catch (e) { /* noop */ }
        // A pattern mined on one pair is not evidence for another pair.
        if (pair && S.patternSource && S.patternSource.pair && S.patternSource.pair !== pair) {
            S.patterns = null;
            S.patternSource = null;
        }
        S.pair = pair || null;
        S.tf = tf || null;
        S.lastResult = null;
        S.lastComputeAt = 0;
        S.lastCandleTime = 0;
        S.consecutiveErrors = 0;
        S.featureHistory = [];
        S.pendingTrades = [];
        setStatus(STATUS.INITIALIZING, 'config-change');
    }

    function getResult() {
        if (!S.lastResult) return null;
        if (now() - S.lastResult.time > RESULT_STALE_MS) return S.lastResult; // flagged stale by callers
        return S.lastResult;
    }

    function isResultStale() {
        if (!S.lastResult) return true;
        return (now() - S.lastResult.time) > RESULT_STALE_MS;
    }

    /**
     * Influence consumed by the existing IntelligenceEngine. Returns a
     * bounded nudge plus gate state; null-safe when neural is not ready.
     */
    function getInfluence() {
        try {
            const r = S.lastResult;
            if (!r || (S.status !== STATUS.ACTIVE && S.status !== STATUS.DEGRADED)) {
                return { active: false };
            }
            if (isResultStale()) return { active: false, stale: true };
            const summary = 'Neural:' + r.meta.decision + ' ' + Math.round(r.meta.confidence * 100) + '%';
            return {
                active: true,
                bias: r.meta.consensus,
                confidence: r.meta.confidence,
                decision: r.meta.decision,
                disagreement: r.meta.disagreement,
                risk: r.meta.risk,
                gatePass: r.gate.pass === true,
                gateBlock: r.gate.pass !== true,
                hardBlock: r.gate.hardBlock === true,
                blockReason: r.gate.pass ? null : (r.gate.failedChecks[0] || 'NO_TRADE'),
                summary: summary
            };
        } catch (e) {
            return { active: false };
        }
    }

    /**
     * Called before an AI EXECUTE. Only HARD blocks stop the trade so the
     * existing engine keeps working in normal conditions.
     */
    function shouldBlockAiTrade() {
        try {
            const inf = getInfluence();
            if (!inf.active) {
                // Neural not ready: do not block, but flag when data is stale.
                if (inf.stale) return { block: true, reason: 'stale-data', detail: 'Neural signal basi' };
                return { block: false, reason: null };
            }
            if (inf.hardBlock) {
                return { block: true, reason: inf.blockReason || 'NO_TRADE', detail: 'Neural Risk Gate: NO_TRADE' };
            }
            return { block: false, reason: null, gatePass: inf.gatePass };
        } catch (e) {
            return { block: false, reason: null };
        }
    }

    function recordPositionOpened(pos) {
        try {
            if (!pos || !S.lastResult) return false;
            const biases = {};
            AGENT_ORDER.forEach(function (id) {
                const r = S.lastResult.agents[id];
                biases[id] = r && Number.isFinite(r.bias) ? r.bias : 0;
            });
            S.pendingTrades.push({
                pair: pos.pair,
                direction: pos.type === 'SHORT' ? -1 : 1,
                openTime: now(),
                metaDecision: S.lastResult.meta.decision,
                metaConsensus: S.lastResult.meta.consensus,
                agentBiases: biases
            });
            if (S.pendingTrades.length > 20) S.pendingTrades.splice(0, S.pendingTrades.length - 20);
            return true;
        } catch (e) {
            return false;
        }
    }

    function recordTradeOutcome(outcome) {
        try {
            const o = outcome || {};
            if (!Number.isFinite(o.pnl)) return false;
            // Match the most recent pending trade for this pair+direction.
            let idx = -1;
            for (let i = S.pendingTrades.length - 1; i >= 0; i--) {
                const p = S.pendingTrades[i];
                if (p.pair === o.pair && p.direction === (o.direction === 'SHORT' ? -1 : 1)) {
                    idx = i;
                    break;
                }
            }
            const won = o.pnl > 0;
            loadStatsIfNeeded();
            S.stats.trades++;
            if (won) S.stats.wins++;

            const correctByAgent = {};
            if (idx >= 0) {
                const pending = S.pendingTrades[idx];
                S.pendingTrades.splice(idx, 1);
                AGENT_ORDER.forEach(function (id) {
                    const b = pending.agentBiases[id] || 0;
                    // Agent "correct" if it agreed with a winning trade or
                    // disagreed with a losing one.
                    const agreed = (b >= 0 && pending.direction > 0) || (b < 0 && pending.direction < 0);
                    const correct = won ? agreed : !agreed;
                    correctByAgent[id] = correct;
                    S.stats.agentTotal[id] = (S.stats.agentTotal[id] || 0) + 1;
                    if (correct) S.stats.agentCorrect[id] = (S.stats.agentCorrect[id] || 0) + 1;
                    try {
                        const A = agents();
                        const key = id.charAt(0).toUpperCase() + id.slice(1);
                        if (A && A[key] && typeof A[key].recordOutcome === 'function') {
                            A[key].recordOutcome(correct, LEARNING_RATE);
                        }
                    } catch (e) { /* per-agent isolated */ }
                });
                try {
                    const SN = pick('SynapticNetwork');
                    if (SN) SN.get().updateFromOutcome(correctByAgent);
                } catch (e) { /* noop */ }
            }
            persistStats();
            emitEvent('LEARNING', 'trade ' + o.pair + ' ' + (o.direction || '') + ' ' +
                (won ? 'WIN' : 'LOSS') + ' -> weights updated', 'learning');
            return true;
        } catch (e) {
            return false;
        }
    }

    function loadStatsIfNeeded() {
        if (!S.stats) loadStats();
        return S.stats;
    }

    function getStats() {
        loadStatsIfNeeded();
        return {
            trades: S.stats.trades,
            wins: S.stats.wins,
            winRate: S.stats.trades > 0 ? S.stats.wins / S.stats.trades : 0,
            agentAccuracy: AGENT_ORDER.reduce(function (acc, id) {
                const t = S.stats.agentTotal[id] || 0;
                acc[id] = t > 0 ? (S.stats.agentCorrect[id] || 0) / t : 0;
                return acc;
            }, {}),
            updatedAt: S.stats.updatedAt
        };
    }

    function getSnapshot() {
        const r = S.lastResult;
        let synapses = [];
        try {
            const SN = pick('SynapticNetwork');
            if (SN) synapses = SN.get().snapshot();
        } catch (e) { synapses = []; }
        const neurons = {};
        try {
            const A = agents();
            if (A) {
                AGENT_ORDER.forEach(function (id) {
                    const key = id.charAt(0).toUpperCase() + id.slice(1);
                    const handle = A[key];
                    if (handle && typeof handle.get === 'function') {
                        const inst = handle.get();
                        neurons[id] = inst ? inst.neuronActivations() : {};
                    }
                });
            }
        } catch (e) { /* noop */ }
        return {
            status: S.status,
            statusReason: S.statusReason,
            pair: S.pair,
            tf: S.tf,
            computeCount: S.computeCount,
            stale: isResultStale(),
            meta: r ? r.meta : null,
            gate: r ? r.gate : null,
            agents: r ? r.agents : null,
            dataQuality: r ? r.dataQuality : 0,
            patterns: patternStatus(),
            synapses: synapses,
            neurons: neurons,
            stats: getStats()
        };
    }

    /**
     * Feed a wide multi-timeframe corpus (see src/data/deepHistory.js) into the
     * pattern miner. Returns a compact status object; never throws.
     */
    function ingestCorpus(corpus) {
        const PM = patternMiner();
        if (!PM || typeof PM.build !== 'function') return { ok: false, reason: 'MINER_MISSING' };
        if (!corpus || !corpus.series) return { ok: false, reason: 'NO_CORPUS' };
        let analysis = null;
        try {
            analysis = PM.build(corpus, {});
        } catch (e) {
            S.patterns = null;
            S.patternSource = null;
            return { ok: false, reason: 'BUILD_FAILED' };
        }
        if (!analysis || analysis.ok !== true) {
            S.patterns = analysis || null;
            S.patternSource = {
                pair: corpus.pair || null,
                fetchedAt: corpus.fetchedAt || now(),
                frames: corpus.frames || [],
                candles: corpus.totals ? corpus.totals.candles : 0,
                partial: !!corpus.partial,
                ok: false
            };
            return { ok: false, reason: analysis ? analysis.reason : 'BUILD_EMPTY' };
        }
        S.patterns = analysis;
        S.patternBuilds++;
        S.patternSource = {
            pair: corpus.pair || analysis.pair || null,
            fetchedAt: corpus.fetchedAt || analysis.builtAt,
            frames: corpus.frames || [],
            candles: corpus.totals ? corpus.totals.candles : analysis.stats.candles,
            partial: !!corpus.partial,
            ok: true
        };
        emitEvent('PATTERN', analysis.findings.length + ' pola dari ' + analysis.stats.candles +
            ' candle (' + analysis.stats.families + ' keluarga)', 'learning');
        return {
            ok: true,
            pair: S.patternSource.pair,
            candles: S.patternSource.candles,
            families: analysis.stats.families,
            samples: analysis.stats.samples,
            findings: analysis.findings.length
        };
    }

    function patternStatus() {
        const src = S.patternSource || {};
        const analysis = S.patterns;
        return {
            available: !!(analysis && analysis.ok),
            pair: src.pair || (analysis ? analysis.pair : null) || null,
            fetchedAt: src.fetchedAt || 0,
            candles: src.candles || 0,
            frames: src.frames || [],
            partial: !!src.partial,
            families: analysis && analysis.ok ? analysis.stats.families : 0,
            samples: analysis && analysis.ok ? analysis.stats.samples : 0,
            counts: analysis && analysis.counts ? analysis.counts : {},
            features: analysis && analysis.ok ? analysis.features : null,
            findings: analysis && analysis.ok ? analysis.findings : [],
            builtAt: analysis ? analysis.builtAt : 0,
            builds: S.patternBuilds
        };
    }

    function getPatterns() { return patternStatus(); }

    function clearPatterns() {
        S.patterns = null;
        S.patternSource = null;
    }

    // ---- lifecycle wiring (chart is the critical path; neural is secondary)
    function wireLifecycle() {
        try {
            const CL = (root && root.ChartLifecycle) || (typeof ChartLifecycle !== 'undefined' ? ChartLifecycle : null);
            if (CL && typeof CL.onPhase === 'function') {
                CL.onPhase(function (payload) {
                    try {
                        const phase = payload ? payload.phase : '';
                        if (phase === 'LIVE') warmup();
                        else if (phase === 'WAITING_LAYOUT' || phase === 'CREATING' || phase === 'ERROR') {
                            if (payload && (payload.pair !== S.pair || payload.tf !== S.tf)) {
                                resetForConfig(payload.pair, payload.tf);
                            }
                        }
                    } catch (e) { /* never break chart boot */ }
                });
            }
        } catch (e) { /* optional wiring */ }
        // Late-load safety: if the chart is already live when this script
        // executes, warm up on the next frame instead of waiting for events.
        try {
            const AppState = appState();
            if (AppState && Array.isArray(AppState.candles) && AppState.candles.length > 30) {
                const defer = (typeof requestAnimationFrame === 'function')
                    ? requestAnimationFrame
                    : function (fn) { return setTimeout(fn, 16); };
                defer(function () {
                    try { warmup(); } catch (e) { /* noop */ }
                });
            }
        } catch (e) { /* noop */ }
    }

    loadStats();
    wireLifecycle();

    return {
        STATUS: STATUS,
        AGENT_ORDER: AGENT_ORDER,
        onMarketUpdate: onMarketUpdate,
        warmup: warmup,
        resetForConfig: resetForConfig,
        getResult: getResult,
        getSnapshot: getSnapshot,
        getInfluence: getInfluence,
        shouldBlockAiTrade: shouldBlockAiTrade,
        recordPositionOpened: recordPositionOpened,
        recordTradeOutcome: recordTradeOutcome,
        getStats: getStats,
        ingestCorpus: ingestCorpus,
        getPatterns: getPatterns,
        clearPatterns: clearPatterns,
        subscribe: subscribe,
        drainEvents: drainEvents,
        getStatus: function () { return { status: S.status, reason: S.statusReason }; }
    };
});
