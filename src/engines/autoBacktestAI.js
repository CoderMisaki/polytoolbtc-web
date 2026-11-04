/* autoBacktestAI.js — AUTOMATED FORWARD-TEST ENGINE (login required).
 *
 * "Auto Backtest AI" turns a strong AI signal into a real demo position,
 * complete with its own SL/TP, and keeps a win-rate ledger of the results, so
 * the strategy is tested forward on live market data instead of only on past
 * candles.
 *
 * Flow:
 *   market tick -> IntelligenceEngine signal + Neural Meta/Gate + pattern
 *   evidence -> this module decides whether the signal is strong enough ->
 *   FuturesEngine.openPosition(type, true, overrides) -> the existing demo
 *   engine manages SL/TP/trailing -> on close, `recordClose()` books the result
 *   into the Auto Backtest ledger -> win-rate panel updates.
 *
 * Safety rules that make this feature honest:
 *   - LOGIN ONLY: it never runs while signed out.
 *   - It only ever creates DEMO positions through the existing simulation
 *     engine; no real exchange order is ever sent.
 *   - Strong-signal gate: requires the AI signal type EXECUTE (confluence of
 *     ADX / MTF / volume), a minimum score, a minimum neural confidence and a
 *     Neural Risk Gate pass; optional pattern-alignment confirmation.
 *   - Bounded risk: one position per pair, a configurable cap on simultaneous
 *     auto positions, a per-pair cooldown, a loss-streak pause, and a margin
 *     size derived from a percentage of the demo balance.
 *   - Every decision (entered or skipped) is logged with its reason so the user
 *     can see why the engine did or did not act.
 *
 * Settings + ledger are persisted per user id (localStorage) so two accounts on
 * the same browser never share statistics.
 * UMD: window.AutoBacktestAI in browsers, module.exports in Node.
 */
(function AutoBacktestAIUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.AutoBacktestAI = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildAutoBacktestAI(root) {
    'use strict';

    const STORE_KEY = 'masako_autobt_v1';
    const RECORD_CAP = 300;          // windowed win-rate history
    const DECISION_CAP = 40;         // "why it acted / did not act" log
    const MIN_EVAL_INTERVAL_MS = 2500;
    const MAX_RECORD_AGE_MS = 180 * 24 * 60 * 60 * 1000;

    const DEFAULTS = Object.freeze({
        enabled: false,
        mode: 'CONS',              // CONS = only EXECUTE signals, AGG = score threshold
        minConfidence: 0.62,       // neural meta confidence (0..1)
        minScore: 55,              // |IntelligenceEngine score| in AGG mode
        riskPct: 1.0,              // % of demo balance per auto position
        leverage: 10,
        maxOpen: 2,
        requireGate: true,         // Neural Risk Gate must not block
        requirePattern: false,     // pattern alignment must agree with direction
        cooldownMinutes: 15,
        lossStreakPause: 3,        // pause after N consecutive losses
        useTrailing: true,
        useBe: true
    });

    // Server engine health as reported by /api/get-state. The server is the
    // primary executor; the browser only takes over when the engine is
    // demonstrably stale (see isServerAuthoritative).
    const SERVER_DEFAULT = Object.freeze({
        healthy: false,
        authoritative: true,
        lastTickAt: 0,
        tickAgeMs: null,
        tickIntervalMs: 60000,
        tickCount: 0,
        staleAfterMs: 5 * 60 * 1000,
        clientPresent: false,
        updatedAt: 0
    });

    const S = {
        settings: Object.assign({}, DEFAULTS),
        stats: emptyStats(),
        decisions: [],
        profileId: null,
        profileEmail: null,
        loaded: false,
        lastEvalAt: 0,
        lastOutcomeAt: 0,
        cooldowns: {},             // pair -> timestamp of last auto entry
        lastSkip: null,
        server: Object.assign({}, SERVER_DEFAULT),
        listeners: []
    };

    /**
     * True while the server engine owns Auto Backtest entries.
     *
     * The engine is trusted when it reported a tick recently enough. If the
     * scheduler dies (no cron, bad secret, deploy gone wrong) we fall back to
     * local execution so the feature still works while the tab is open — but
     * the panel says so, instead of pretending everything is server-side.
     */
    function isServerAuthoritative() {
        const server = S.server || SERVER_DEFAULT;
        if (server.authoritative !== true) return false;
        if (!Number.isFinite(server.lastTickAt) || server.lastTickAt <= 0) return false;
        const staleAfter = Number.isFinite(server.staleAfterMs) ? server.staleAfterMs : 5 * 60 * 1000;
        const age = Date.now() - Number(server.lastTickAt);
        return age <= staleAfter;
    }

    function setServerEngineStatus(status) {
        if (!status || typeof status !== 'object') return isServerAuthoritative();
        S.server = Object.assign({}, SERVER_DEFAULT, status, { updatedAt: Date.now() });
        renderPanel();
        emit();
        return isServerAuthoritative();
    }

    function getServerEngineStatus() {
        return Object.assign({}, S.server, { owning: isServerAuthoritative() });
    }

    /**
     * Hand the browser's live signal to the server so the engine can act within
     * seconds instead of waiting for its own next poll. The server still makes
     * every entry/exit decision — this is telemetry, not an instruction.
     */
    const SIGNAL_PUSH_THROTTLE_MS = 20000;
    let lastSignalPushAt = 0;
    function pushSignalToServer(signal) {
        if (!root || !root.apiFetch) return;
        if (!root.MasakoAuth || !root.MasakoAuth.isAuthenticated) return;
        if (!signal || !signal.pair || !(signal.price > 0)) return;
        if (Date.now() - lastSignalPushAt < SIGNAL_PUSH_THROTTLE_MS) return;
        lastSignalPushAt = Date.now();
        root.apiFetch('/api/sync-autobt', {
            method: 'POST',
            body: JSON.stringify({
                signal: {
                    pair: signal.pair,
                    price: signal.price,
                    atr: signal.atr,
                    score: signal.score,
                    direction: signal.direction,
                    type: signal.type,
                    confidence: signal.neural && signal.neural.confidence,
                    bias: signal.neural && signal.neural.bias,
                    // Forward only an explicit, active neural PASS. Missing
                    // gate data must never be upgraded to permission by the API.
                    gateAllowed: !!(signal.neural
                        && signal.neural.active === true
                        && signal.neural.gatePass === true
                        && signal.neural.hardBlock !== true
                        && signal.neural.decision === signal.direction),
                    gateReason: signal.neural && signal.neural.blockReason,
                    at: Date.now()
                }
            })
        }).catch(function () { /* signal push is best effort */ });
    }

    function emptyStats() {
        return {
            trades: 0,
            wins: 0,
            losses: 0,
            grossPnl: 0,
            grossWin: 0,
            grossLoss: 0,
            bestPnl: 0,
            worstPnl: 0,
            streak: 0,
            lossStreak: 0,
            records: [],
            startedAt: 0,
            updatedAt: 0
        };
    }

    // ------------------------------------------------------------- storage

    function safeLoad() {
        if (root && typeof root.safeLoad === 'function') return root.safeLoad;
        if (typeof safeLoad === 'function') return safeLoad;
        return null;
    }

    function safeStore() {
        if (root && typeof root.safeStore === 'function') return root.safeStore;
        if (typeof safeStore === 'function') return safeStore;
        return null;
    }

    function hashId(value) {
        const str = String(value || '');
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
    }

    function storageKey() {
        return S.profileId ? STORE_KEY + ':' + hashId(S.profileId) : STORE_KEY;
    }

    function load() {
        const read = safeLoad();
        const key = storageKey();
        const saved = read ? read(key, null, null) : null;
        S.settings = Object.assign({}, DEFAULTS, saved && saved.settings ? saved.settings : {});
        S.stats = Object.assign(emptyStats(), saved && saved.stats ? saved.stats : {});
        if (!Array.isArray(S.stats.records)) S.stats.records = [];
        if (!Array.isArray(S.decisions)) S.decisions = [];
        S.decisions = Array.isArray(saved && saved.decisions) ? saved.decisions.slice(-DECISION_CAP) : [];
        S.cooldowns = saved && saved.cooldowns && typeof saved.cooldowns === 'object' ? saved.cooldowns : {};
        sanitizeSettings();
        S.loaded = true;
    }

    function save(triggerServerSync = true) {
        const write = safeStore();
        if (!write) return;
        write(storageKey(), {
            settings: S.settings,
            stats: Object.assign({}, S.stats, { records: S.stats.records.slice(-RECORD_CAP) }),
            decisions: S.decisions.slice(-DECISION_CAP),
            cooldowns: S.cooldowns
        }, (root && root.APP_SCHEMA_VERSION) || undefined);

        if (triggerServerSync !== false) {
            syncToServer();
        }
    }

    let syncTimer = null;
    function syncToServer() {
        if (!root || !root.MasakoAuth?.isAuthenticated || !root.apiFetch) return;
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
            root.apiFetch('/api/sync-autobt', {
                method: 'POST',
                body: JSON.stringify({
                    settings: S.settings,
                    stats: S.stats,
                    decisions: S.decisions.slice(-DECISION_CAP),
                    cooldowns: S.cooldowns
                })
            }).catch(err => console.warn('AutoBacktestAI sync to server error:', err.message));
        }, 1000);
    }

    function syncFromServer(serverData) {
        if (!serverData) return;
        if (serverData.engine) setServerEngineStatus(serverData.engine);
        if (serverData.settings) {
            S.settings = Object.assign({}, S.settings, serverData.settings);
            sanitizeSettings();
        }
        if (serverData.stats) {
            if ((serverData.stats.trades || 0) >= (S.stats.trades || 0)) {
                S.stats = Object.assign({}, S.stats, serverData.stats);
            }
        }
        if (Array.isArray(serverData.decisions) && serverData.decisions.length > 0) {
            const existingKeys = new Set(S.decisions.map(d => `${d.t}_${d.reason}`));
            for (const dec of serverData.decisions) {
                if (!existingKeys.has(`${dec.t}_${dec.reason}`)) {
                    S.decisions.unshift(dec);
                }
            }
            S.decisions.sort((a, b) => (b.t || 0) - (a.t || 0));
            S.decisions = S.decisions.slice(0, DECISION_CAP);
        }
        if (serverData.cooldowns) {
            S.cooldowns = Object.assign({}, S.cooldowns, serverData.cooldowns);
        }
        save(false);
    }

    function num(value, fallback) {
        return Number.isFinite(value) ? value : fallback;
    }

    function clamp(x, lo, hi) {
        if (!Number.isFinite(x)) return lo;
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

    /** Keep every setting inside a sane, documented range. */
    function sanitizeSettings() {
        const s = S.settings;
        s.enabled = s.enabled === true;
        s.mode = s.mode === 'AGG' ? 'AGG' : 'CONS';
        s.minConfidence = clamp(num(s.minConfidence, DEFAULTS.minConfidence), 0.3, 0.95);
        s.minScore = clamp(num(s.minScore, DEFAULTS.minScore), 10, 100);
        s.riskPct = clamp(num(s.riskPct, DEFAULTS.riskPct), 0.1, 10);
        s.leverage = Math.round(clamp(num(s.leverage, DEFAULTS.leverage), 1, 125));
        s.maxOpen = Math.round(clamp(num(s.maxOpen, DEFAULTS.maxOpen), 1, 5));
        s.requireGate = s.requireGate !== false;
        s.requirePattern = s.requirePattern === true;
        s.cooldownMinutes = clamp(num(s.cooldownMinutes, DEFAULTS.cooldownMinutes), 0, 720);
        s.lossStreakPause = Math.round(clamp(num(s.lossStreakPause, DEFAULTS.lossStreakPause), 0, 10));
        s.useTrailing = s.useTrailing !== false;
        s.useBe = s.useBe !== false;
        return s;
    }

    // ------------------------------------------------------------- identity

    function auth() {
        if (root && root.MasakoAuth) return root.MasakoAuth;
        if (typeof MasakoAuth !== 'undefined') return MasakoAuth;
        return null;
    }

    function isLoggedIn() {
        const a = auth();
        return !!(a && a.isAuthenticated);
    }

    function setUser(userLike) {
        const a = userLike !== undefined ? userLike : auth();
        const user = a && a.user ? a.user : null;
        const email = (a && a.email) || (user && user.email) || null;
        const id = (user && (user.id || user.sub)) || email || null;
        if (!id) {
            if (S.profileId !== null) {
                S.profileId = null;
                S.profileEmail = null;
                load();
                emit();
            }
            return { id: null, email: null };
        }
        if (S.profileId === id) return { id: S.profileId, email: S.profileEmail };
        S.profileId = id;
        S.profileEmail = email;
        S.decisions = [];
        S.cooldowns = {};
        load();
        emit();
        return { id: id, email: email };
    }

    // -------------------------------------------------------------- helpers

    function appState() {
        if (root && root.AppState) return root.AppState;
        if (typeof AppState !== 'undefined') return AppState;
        return null;
    }

    function futuresEngine() {
        if (root && root.FuturesEngine) return root.FuturesEngine;
        if (typeof FuturesEngine !== 'undefined') return FuturesEngine;
        return null;
    }

    function neuralSystem() {
        if (root && root.AnimalNeuralSystem) return root.AnimalNeuralSystem;
        if (typeof AnimalNeuralSystem !== 'undefined') return AnimalNeuralSystem;
        return null;
    }

    function showToast() {
        if (root && typeof root.showToast === 'function') return root.showToast;
        if (typeof showToast === 'function') return showToast;
        return null;
    }

    function emit() {
        for (let i = 0; i < S.listeners.length; i++) {
            try { S.listeners[i](getStatus()); } catch (e) { /* listener isolation */ }
        }
    }

    function subscribe(listener) {
        if (typeof listener === 'function') S.listeners.push(listener);
        return function unsubscribe() {
            const i = S.listeners.indexOf(listener);
            if (i >= 0) S.listeners.splice(i, 1);
        };
    }

    function autoPositions() {
        const fe = futuresEngine();
        const positions = fe && fe.state && Array.isArray(fe.state.positions) ? fe.state.positions : [];
        return positions.filter(function (p) { return p && p.origin === 'AUTO_BACKTEST_AI'; });
    }

    function logDecision(kind, reason, detail) {
        const entry = {
            t: Date.now(),
            kind: kind,
            reason: reason || '',
            detail: detail || null
        };
        S.decisions.push(entry);
        if (S.decisions.length > DECISION_CAP) S.decisions.splice(0, S.decisions.length - DECISION_CAP);
        if (kind !== 'entered') S.lastSkip = entry;
        return entry;
    }

    // ------------------------------------------------------------ decision

    /** Signal snapshot used by both the gate and the UI. */
    function readSignal() {
        const AppState = appState();
        const live = AppState && AppState.live ? AppState.live : null;
        if (!live) return null;
        const score = num(live.score, 0);
        const type = typeof live.type === 'string' ? live.type : 'WAIT';
        const signal = typeof live.signal === 'string' ? live.signal : 'WAIT';
        let direction = 'NONE';
        if (signal === 'STRONG BUY' || (type === 'EXECUTE' && score > 0)) direction = 'LONG';
        else if (signal === 'STRONG SELL' || (type === 'EXECUTE' && score < 0)) direction = 'SHORT';
        else if (score > 0) direction = 'LONG';
        else if (score < 0) direction = 'SHORT';
        return {
            type: type,
            signal: signal,
            score: score,
            direction: direction,
            age: num(live.age, 0),
            atr: num(live.atr, 0),
            price: AppState ? num(AppState.price, 0) : 0,
            pair: AppState ? AppState.g_pair : null,
            risk: live.risk || 'MED',
            neural: live.neural || null
        };
    }

    function patternAlignment(direction) {
        const sys = neuralSystem();
        if (!sys || typeof sys.getPatterns !== 'function') return 0;
        const patterns = sys.getPatterns();
        const features = patterns && patterns.available ? patterns.features : null;
        if (!features || !Number.isFinite(features.patAlignment)) return 0;
        const sign = direction === 'SHORT' ? -1 : 1;
        return features.patAlignment * sign;
    }

    /**
     * Decide whether the current signal deserves an automatic demo entry.
     * Returns { allow, reason, detail, plan }.
     */
    function evaluateSignal(signal, settings) {
        const AppState = appState();
        const fe = futuresEngine();
        if (!signal) return { allow: false, reason: 'no-signal' };
        if (!AppState || !AppState.g_pair) return { allow: false, reason: 'no-market' };
        if (!(signal.price > 0)) return { allow: false, reason: 'no-price' };
        if (!fe || !fe.state) return { allow: false, reason: 'engine-not-ready' };
        if (AppState.pendingOpenPositionSave) return { allow: false, reason: 'engine-busy' };

        const candles = Array.isArray(AppState.candles) ? AppState.candles.length : 0;
        if (candles < 200) return { allow: false, reason: 'history-warmup', detail: candles };

        const feed = AppState.feed || {};
        if (feed.status === 'ERROR') return { allow: false, reason: 'feed-error' };

        const balance = num(fe.state.balance, 0);
        if (!(balance > 0)) return { allow: false, reason: 'no-balance' };

        const openAuto = autoPositions().length;
        if (openAuto >= settings.maxOpen) return { allow: false, reason: 'max-auto-positions', detail: openAuto };

        const samePair = (fe.state.positions || []).some(function (p) { return p && p.pair === AppState.g_pair; });
        if (samePair) return { allow: false, reason: 'pair-position-open' };

        if (AppState.drawdownGuard && num(AppState.drawdownGuard.lossStreak, 0) >= settings.lossStreakPause && settings.lossStreakPause > 0) {
            return { allow: false, reason: 'loss-streak-pause', detail: AppState.drawdownGuard.lossStreak };
        }

        const cooldownMs = settings.cooldownMinutes * 60 * 1000;
        const lastEntry = num(S.cooldowns[AppState.g_pair], 0);
        if (cooldownMs > 0 && lastEntry > 0 && (Date.now() - lastEntry) < cooldownMs) {
            const left = Math.ceil((cooldownMs - (Date.now() - lastEntry)) / 60000);
            return { allow: false, reason: 'cooldown', detail: left };
        }

        // Strong-signal requirement.
        if (settings.mode === 'CONS') {
            if (signal.type !== 'EXECUTE') return { allow: false, reason: 'need-execute-signal', detail: signal.signal };
        } else {
            const strongEnough = signal.type === 'EXECUTE' || Math.abs(signal.score) >= settings.minScore;
            if (!strongEnough) return { allow: false, reason: 'score-below-threshold', detail: Math.round(Math.abs(signal.score)) };
        }

        if (settings.mode === 'AGG' && signal.type !== 'EXECUTE' && Math.abs(signal.score) < settings.minScore) {
            return { allow: false, reason: 'score-below-threshold' };
        }

        // Neural confidence + risk gate.
        const neural = signal.neural || (neuralSystem() && typeof neuralSystem().getInfluence === 'function'
            ? neuralSystem().getInfluence()
            : null);
        const neuralActive = !!(neural && neural.active);
        if (!neuralActive) return { allow: false, reason: 'neural-not-ready' };
        if (num(neural.confidence, 0) < settings.minConfidence) {
            return { allow: false, reason: 'neural-confidence-low', detail: Math.round(num(neural.confidence, 0) * 100) };
        }
        if (settings.requireGate && neural.hardBlock) {
            return { allow: false, reason: 'neural-gate-block', detail: neural.blockReason || 'NO_TRADE' };
        }
        if (settings.requireGate) {
            const sys = neuralSystem();
            const verdict = sys && typeof sys.shouldBlockAiTrade === 'function' ? sys.shouldBlockAiTrade() : { block: false };
            if (verdict && verdict.block) return { allow: false, reason: 'risk-gate-' + (verdict.reason || 'block') };
        }

        if (signal.direction !== 'LONG' && signal.direction !== 'SHORT') {
            return { allow: false, reason: 'no-direction' };
        }

        if (settings.requirePattern) {
            const align = patternAlignment(signal.direction);
            if (align < 0.15) return { allow: false, reason: 'pattern-not-aligned', detail: Math.round(align * 100) };
        }

        // Margin sizing: percentage of the demo balance, capped at half balance.
        const rawMargin = balance * (settings.riskPct / 100);
        const margin = Math.max(5, Math.min(rawMargin, balance * 0.5));
        const feeEstimate = margin * settings.leverage * 0.0004;
        if (margin + feeEstimate > balance) return { allow: false, reason: 'insufficient-balance' };

        return {
            allow: true,
            reason: 'strong-signal',
            plan: {
                pair: AppState.g_pair,
                direction: signal.direction,
                margin: Math.round(margin * 100) / 100,
                leverage: settings.leverage,
                score: signal.score,
                confidence: num(neural.confidence, 0),
                patternAlignment: patternAlignment(signal.direction),
                signal: signal.signal
            }
        };
    }

    function evaluate(context) {
        const ctx = context || {};
        const nowMs = Date.now();
        if (nowMs - S.lastEvalAt < MIN_EVAL_INTERVAL_MS) return getStatus();
        S.lastEvalAt = nowMs;
        if (!S.loaded) load();
        if (!S.settings.enabled) return getStatus();
        if (!isLoggedIn()) {
            logDecision('skipped', 'login-required');
            emit();
            return getStatus();
        }
        setUser();
        const signal = ctx.signal || readSignal();
        const verdict = evaluateSignal(signal, S.settings);
        if (!verdict.allow) {
            logDecision('skipped', verdict.reason, verdict.detail);
            emit();
            return getStatus();
        }
        enter(verdict.plan, signal);
        return getStatus();
    }

    function enter(plan, signal) {
        // Server-first: while the server engine is healthy it owns entries, so
        // the browser only forwards the signal and reports why it did not open
        // anything itself. This is what keeps a closed tab and an open tab from
        // producing two entries for the same signal.
        if (isServerAuthoritative()) {
            pushSignalToServer(signal);
            // The market ticks several times a second: log the hand-off once a
            // minute so the decision log stays readable.
            if (Date.now() - (S.lastDeferLogAt || 0) > 60000) {
                S.lastDeferLogAt = Date.now();
                logDecision('skipped', 'server-deferred', plan.pair);
            }
            emit();
            renderPanel();
            return false;
        }

        const fe = futuresEngine();
        if (!fe || typeof fe.openPosition !== 'function') {
            logDecision('error', 'engine-missing');
            return false;
        }
        logDecision('entered', plan.direction + ' ' + plan.pair, {
            margin: plan.margin,
            leverage: plan.leverage,
            score: Math.round(plan.score),
            confidence: Math.round(plan.confidence * 100)
        });
        S.cooldowns[plan.pair] = Date.now();
        save();
        try {
            Promise.resolve(fe.openPosition(plan.direction, true, {
                margin: plan.margin,
                leverage: plan.leverage,
                marginMode: 'ISOLATED',
                origin: 'AUTO_BACKTEST_AI',
                autoBacktest: true,
                useTrailing: S.settings.useTrailing,
                useBe: S.settings.useBe,
                autoRr: true,
                silent: true,
                signalSnapshot: {
                    score: plan.score,
                    confidence: plan.confidence,
                    signal: plan.signal,
                    patternAlignment: plan.patternAlignment,
                    atr: signal ? signal.atr : 0
                }
            })).catch(function () { /* openPosition reports its own errors */ });
        } catch (e) {
            logDecision('error', 'open-failed');
            return false;
        }
        const toast = showToast();
        if (toast) toast('Auto Backtest AI: entry ' + plan.direction + ' ' + plan.pair + ' (' + Math.round(plan.margin) + ' USDT, ' + plan.leverage + 'x)', false, 3500);
        emit();
        return true;
    }

    /** Called by FuturesEngine.closePosition for auto positions. */
    function recordClose(pos, outcome) {
        const o = outcome || {};
        const pnl = num(o.pnl, NaN);
        if (!Number.isFinite(pnl)) return false;
        if (!S.loaded) load();
        const won = pnl > 0;
        const record = {
            t: Date.now(),
            pair: (pos && pos.pair) || o.pair || '—',
            type: (pos && pos.type) || o.type || '—',
            pnl: pnl,
            leverage: pos && Number.isFinite(pos.leverage) ? pos.leverage : null,
            margin: pos && Number.isFinite(pos.margin) ? pos.margin : null,
            reason: o.reason || 'CLOSED',
            mode: S.settings.mode,
            openTime: pos && Number.isFinite(pos.openTime) ? pos.openTime : null
        };
        S.stats.trades++;
        if (won) {
            S.stats.wins++;
            S.stats.grossWin += pnl;
            S.stats.streak = S.stats.streak >= 0 ? S.stats.streak + 1 : 1;
            S.stats.lossStreak = 0;
        } else {
            S.stats.losses++;
            S.stats.grossLoss += Math.abs(pnl);
            S.stats.streak = S.stats.streak <= 0 ? S.stats.streak - 1 : -1;
            S.stats.lossStreak = S.stats.lossStreak + 1;
        }
        S.stats.grossPnl += pnl;
        S.stats.bestPnl = Math.max(S.stats.bestPnl, pnl);
        S.stats.worstPnl = Math.min(S.stats.worstPnl, pnl);
        S.stats.records.push(record);
        if (S.stats.records.length > RECORD_CAP) S.stats.records.splice(0, S.stats.records.length - RECORD_CAP);
        const cutoff = Date.now() - MAX_RECORD_AGE_MS;
        S.stats.records = S.stats.records.filter(function (r) { return r && r.t >= cutoff; });
        // Metrik kuantitatif formal (temuan audit #3): dihitung ulang dari
        // records setiap ada trade baru — Sharpe, Sortino, drawdown, dll.
        // Dibungkus try/catch agar tidak mengganggu alur utama jika modul
        // belum termuat.
        try {
            var QM = (typeof window !== 'undefined' && window.QuantMetrics) || null;
            if (!QM && typeof require === 'function') {
                try { QM = require('../quant/metrics.js'); } catch (_) {}
            }
            if (QM && QM.summarize) {
                S.stats.quant = QM.summarize(S.stats.records, { startEquity: 10000, tradesPerYear: 252 });
                S.stats.quantAt = Date.now();
            }
        } catch (_) {}
        if (!S.stats.startedAt) S.stats.startedAt = Date.now();
        S.stats.updatedAt = Date.now();
        S.lastOutcomeAt = Date.now();
        save();
        const toast = showToast();
        if (toast) {
            toast('Auto Backtest AI: ' + (won ? 'WIN' : 'LOSS') + ' ' + record.pair + ' ' +
                (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2), !won, 4000);
        }
        emit();
        renderPanel();
        return true;
    }

    // ---------------------------------------------------------- statistics

    function windowStats(records, sinceMs) {
        const from = sinceMs ? Date.now() - sinceMs : 0;
        const subset = from > 0 ? records.filter(function (r) { return r.t >= from; }) : records;
        let wins = 0;
        let grossWin = 0;
        let grossLoss = 0;
        for (let i = 0; i < subset.length; i++) {
            const pnl = subset[i].pnl;
            if (pnl > 0) { wins++; grossWin += pnl; }
            else grossLoss += Math.abs(pnl);
        }
        const total = subset.length;
        const losses = total - wins;
        return {
            trades: total,
            wins: wins,
            losses: losses,
            winRate: total > 0 ? wins / total : 0,
            profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
            expectancy: total > 0 ? (grossWin - grossLoss) / total : 0,
            grossPnl: grossWin - grossLoss
        };
    }

    function maxDrawdown(records) {
        if (!records || records.length === 0) return 0;
        let equity = 0;
        let peak = 0;
        let maxDd = 0;
        for (let i = 0; i < records.length; i++) {
            equity += records[i].pnl;
            if (equity > peak) peak = equity;
            const dd = peak > 0 ? (peak - equity) / Math.max(peak, 1) : 0;
            if (dd > maxDd) maxDd = dd;
        }
        return maxDd;
    }

    function byPair(records) {
        const map = {};
        records.forEach(function (r) {
            const key = r.pair || '—';
            const entry = map[key] || (map[key] = { pair: key, trades: 0, wins: 0, pnl: 0 });
            entry.trades++;
            if (r.pnl > 0) entry.wins++;
            entry.pnl += r.pnl;
        });
        return Object.keys(map).map(function (k) {
            const e = map[k];
            e.winRate = e.trades > 0 ? e.wins / e.trades : 0;
            return e;
        }).sort(function (a, b) { return b.trades - a.trades; });
    }

    function getStats() {
        if (!S.loaded) load();
        const records = S.stats.records;
        const all = windowStats(records, 0);
        const day = 24 * 60 * 60 * 1000;
        return {
            enabled: S.settings.enabled,
            profile: S.profileId ? { email: S.profileEmail, id: S.profileId } : null,
            lifetime: {
                trades: S.stats.trades,
                wins: S.stats.wins,
                losses: S.stats.losses,
                winRate: S.stats.trades > 0 ? S.stats.wins / S.stats.trades : 0,
                grossPnl: S.stats.grossPnl,
                profitFactor: S.stats.grossLoss > 0 ? S.stats.grossWin / S.stats.grossLoss : (S.stats.grossWin > 0 ? 99 : 0),
                streak: S.stats.streak,
                bestPnl: S.stats.bestPnl,
                worstPnl: S.stats.worstPnl,
                startedAt: S.stats.startedAt
            },
            windows: {
                records: all.trades,
                all: all,
                d1: windowStats(records, day),
                d7: windowStats(records, 7 * day),
                d30: windowStats(records, 30 * day)
            },
            drawdown: maxDrawdown(records),
            pairs: byPair(records),
            openAutoPositions: autoPositions().length,
            records: records.slice(-20).reverse(),
            decisions: S.decisions.slice(-8).reverse(),
            updatedAt: S.stats.updatedAt
        };
    }

    function getStatus() {
        if (!S.loaded) load();
        const signal = readSignal();
        return {
            enabled: S.settings.enabled,
            loggedIn: isLoggedIn(),
            profile: S.profileId ? { email: S.profileEmail, id: S.profileId } : null,
            settings: Object.assign({}, S.settings),
            signal: signal ? {
                pair: signal.pair,
                signal: signal.signal,
                type: signal.type,
                direction: signal.direction,
                score: signal.score
            } : null,
            openAutoPositions: autoPositions().length,
            lastSkip: S.lastSkip,
            lastOutcomeAt: S.lastOutcomeAt,
            server: getServerEngineStatus(),
            stats: getStats()
        };
    }

    // ---------------------------------------------------------------- panel

    function getSettings() { return Object.assign({}, S.settings); }

    function updateSettings(patch) {
        if (!patch || typeof patch !== 'object') return getSettings();
        Object.keys(DEFAULTS).forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(patch, key)) S.settings[key] = patch[key];
        });
        sanitizeSettings();
        save();
        emit();
        renderPanel();
        return getSettings();
    }

    function resetStats() {
        S.stats = emptyStats();
        S.decisions = [];
        save();
        emit();
        renderPanel();
        return getStats();
    }

    function resetCooldowns() {
        S.cooldowns = {};
        save();
        return true;
    }

    function pct(value) {
        if (!Number.isFinite(value)) return '—';
        return (value * 100).toFixed(1) + '%';
    }

    function money(value) {
        if (!Number.isFinite(value)) return '—';
        return (value >= 0 ? '+$' : '-$') + Math.abs(value).toFixed(2);
    }

    function setText(id, text, color) {
        const doc = docRef();
        if (!doc) return;
        const el = doc.getElementById(id);
        if (!el) return;
        el.textContent = String(text);
        if (color) el.style.color = color;
    }

    function docRef() {
        if (typeof document !== 'undefined') return document;
        if (root && root.document) return root.document;
        return null;
    }

    const REASON_LABELS = {
        'no-signal': 'Belum ada sinyal',
        'no-market': 'Data market belum siap',
        'no-price': 'Harga belum tersedia',
        'engine-not-ready': 'Engine posisi belum siap',
        'engine-busy': 'Engine sedang memproses order',
        'history-warmup': 'Riwayat candle belum cukup',
        'feed-error': 'Feed market error',
        'no-balance': 'Saldo demo habis',
        'max-auto-positions': 'Batas posisi auto tercapai',
        'pair-position-open': 'Sudah ada posisi di pair ini',
        'loss-streak-pause': 'Jeda karena rentetan loss',
        'cooldown': 'Cooldown setelah entry terakhir',
        'need-execute-signal': 'Sinyal belum EXECUTE (mode konservatif)',
        'score-below-threshold': 'Skor AI di bawah ambang',
        'neural-not-ready': 'Otak hewan masih pemanasan',
        'neural-confidence-low': 'Confidence otak hewan rendah',
        'neural-gate-block': 'Neural Risk Gate menolak',
        'no-direction': 'Arah sinyal belum jelas',
        'pattern-not-aligned': 'Pola data luas tidak searah',
        'insufficient-balance': 'Saldo tidak cukup untuk margin + fee',
        'login-required': 'Perlu login email',
        'server-disabled': 'Auto Backtest nonaktif di server',
        'server-deferred': 'Sinyal dikirim ke engine server (entry oleh server)'
    };

    function reasonLabel(status) {
        if (!status || !status.lastSkip) return 'Menunggu sinyal kuat';
        const code = status.lastSkip.reason;
        if (code && REASON_LABELS[code]) {
            if (code === 'cooldown' && Number.isFinite(status.lastSkip.detail)) {
                return REASON_LABELS[code] + ' (~' + status.lastSkip.detail + ' menit)';
            }
            if ((code === 'neural-confidence-low' || code === 'pattern-not-aligned' ||
                code === 'score-below-threshold' || code === 'max-auto-positions') &&
                Number.isFinite(status.lastSkip.detail)) {
                return REASON_LABELS[code] + ' (' + status.lastSkip.detail + ')';
            }
            return REASON_LABELS[code];
        }
        return status.lastSkip.reason || 'Menunggu sinyal kuat';
    }

    /**
     * The one UI line that tells the truth about the 24/7 engine: is the server
     * ticking, how long ago, and who is entering trades right now.
     */
    function renderServerStatus(status) {
        const doc = docRef();
        if (!doc || typeof doc.getElementById !== 'function') return;
        const el = doc.getElementById('abt-server-status');
        if (!el) return;

        const server = S.server || SERVER_DEFAULT;
        const owning = isServerAuthoritative();
        let label = 'Engine server: belum ada tick';
        let tone = 'is-unknown';

        if (!status || status.loggedIn === false) {
            label = 'Engine server: butuh login email';
            tone = 'is-unknown';
        } else if (owning) {
            const ageSec = Math.max(0, Math.round((Date.now() - Number(server.lastTickAt)) / 1000));
            const age = ageSec < 90 ? `${ageSec} detik lalu` : `${Math.round(ageSec / 60)} menit lalu`;
            label = `Engine server: AKTIF 24/7 · tick ${age} · entry oleh server`;
            tone = 'is-ok';
        } else if (Number(server.lastTickAt) > 0) {
            const ageMin = Math.max(1, Math.round((Date.now() - Number(server.lastTickAt)) / 60000));
            label = `Engine server: TERTUNDA (tick ${ageMin} menit lalu) · browser mengambil alih entry`;
            tone = 'is-warn';
        } else if (server.updatedAt > 0) {
            label = 'Engine server: belum pernah tick — cek scheduler/CRON_SECRET';
            tone = 'is-bad';
        }

        el.textContent = label;
        el.className = 'abt-server-status ' + tone;
    }

    function renderPanel() {
        const doc = docRef();
        if (!doc || typeof doc.getElementById !== 'function') return false;
        const panel = doc.getElementById('abt-panel');
        if (!panel) return false;
        const status = getStatus();
        const stats = status.stats;
        // An empty ledger shows a dash instead of a meaningless 0% win-rate.
        const hasTrades = stats.lifetime.trades > 0;
        setText('abt-wr', hasTrades ? pct(stats.windows.all.winRate) : '—',
            hasTrades ? (stats.windows.all.winRate >= 0.5 ? 'var(--color-correct)' : 'var(--color-wrong)') : null);
        setText('abt-wr-d1', stats.windows.d1.trades > 0 ? pct(stats.windows.d1.winRate) : '—');
        setText('abt-wr-d7', stats.windows.d7.trades > 0 ? pct(stats.windows.d7.winRate) : '—');
        setText('abt-wr-d30', stats.windows.d30.trades > 0 ? pct(stats.windows.d30.winRate) : '—');
        setText('abt-trades', String(stats.lifetime.trades));
        setText('abt-pf', !hasTrades ? '—' : (stats.windows.all.profitFactor >= 99 ? '∞' : stats.windows.all.profitFactor.toFixed(2)));
        setText('abt-exp', hasTrades ? money(stats.windows.all.expectancy) : '—');
        setText('abt-pnl', hasTrades ? money(stats.lifetime.grossPnl) : '—');
        setText('abt-dd', '-' + (stats.drawdown * 100).toFixed(1) + '%');
        setText('abt-streak', String(stats.lifetime.streak));
        setText('abt-open', String(status.openAutoPositions));
        setText('abt-status', reasonLabel(status));
        renderServerStatus(status);
        setText('abt-record-count', stats.windows.records + ' trade tercatat (maks 300 terakhir)');

        const toggle = doc.getElementById('abt-toggle');
        if (toggle) {
            toggle.checked = status.settings.enabled === true;
            toggle.disabled = !status.loggedIn;
        }
        const gate = doc.getElementById('abt-login-note');
        if (gate) gate.style.display = status.loggedIn ? 'none' : 'block';

        const pairsBox = doc.getElementById('abt-pairs');
        if (pairsBox && typeof pairsBox.replaceChildren === 'function') {
            const frag = doc.createDocumentFragment();
            if (stats.pairs.length === 0) {
                const empty = doc.createElement('div');
                empty.className = 'abt-empty';
                empty.textContent = 'Belum ada trade auto.';
                frag.appendChild(empty);
            }
            stats.pairs.slice(0, 6).forEach(function (p) {
                const row = doc.createElement('div');
                row.className = 'abt-pair-row';
                const name = doc.createElement('span');
                name.className = 'abt-pair-name';
                name.textContent = p.pair;
                const wr = doc.createElement('span');
                wr.className = 'abt-pair-wr';
                wr.textContent = pct(p.winRate) + ' (' + p.trades + ')';
                const pnl = doc.createElement('span');
                pnl.className = 'abt-pair-pnl ' + (p.pnl >= 0 ? 'is-win' : 'is-loss');
                pnl.textContent = money(p.pnl);
                row.appendChild(name);
                row.appendChild(wr);
                row.appendChild(pnl);
                frag.appendChild(row);
            });
            pairsBox.replaceChildren(frag);
        }

        const logBox = doc.getElementById('abt-log');
        if (logBox && typeof logBox.replaceChildren === 'function') {
            const frag = doc.createDocumentFragment();
            if (stats.records.length === 0) {
                const empty = doc.createElement('div');
                empty.className = 'abt-empty';
                empty.textContent = 'Belum ada hasil trade auto.';
                frag.appendChild(empty);
            }
            stats.records.forEach(function (r) {
                const row = doc.createElement('div');
                row.className = 'abt-log-row';
                const side = doc.createElement('span');
                side.className = 'abt-log-side ' + (r.type === 'LONG' ? 'is-long' : 'is-short');
                side.textContent = r.type;
                const pair = doc.createElement('span');
                pair.className = 'abt-log-pair';
                pair.textContent = r.pair;
                const res = doc.createElement('span');
                res.className = 'abt-log-pnl ' + (r.pnl >= 0 ? 'is-win' : 'is-loss');
                res.textContent = money(r.pnl);
                const why = doc.createElement('span');
                why.className = 'abt-log-reason';
                why.textContent = r.reason || '';
                row.appendChild(side);
                row.appendChild(pair);
                row.appendChild(res);
                row.appendChild(why);
                frag.appendChild(row);
            });
            logBox.replaceChildren(frag);
        }

        const decisionBox = doc.getElementById('abt-decisions');
        if (decisionBox && typeof decisionBox.replaceChildren === 'function') {
            const frag = doc.createDocumentFragment();
            const decisions = stats.decisions;
            decisions.forEach(function (d) {
                const row = doc.createElement('div');
                row.className = 'abt-decision-row abt-decision-' + (d.kind || 'info');
                const time = doc.createElement('span');
                time.className = 'abt-decision-time';
                const date = new Date(d.t);
                const pad = function (v) { return (v < 10 ? '0' : '') + v; };
                time.textContent = pad(date.getHours()) + ':' + pad(date.getMinutes());
                const text = doc.createElement('span');
                text.className = 'abt-decision-text';
                text.textContent = d.kind === 'entered'
                    ? ('Entry otomatis: ' + (d.reason || '') + ' ' + (d.detail ? JSON.stringify(d.detail) : ''))
                    : (reasonLabel({ lastSkip: d }) + (d.kind === 'error' ? ' (error)' : ''));
                row.appendChild(time);
                row.appendChild(text);
                frag.appendChild(row);
            });
            decisionBox.replaceChildren(frag);
        }
        return true;
    }

    // ------------------------------------------------------------- bootstrap

    // No timer lives here on purpose: the market tick path in main.js calls
    // evaluate() continuously while the chart is live, so an interval would
    // only duplicate work (and would need its own teardown).
    load();

    return {
        STORE_KEY: STORE_KEY,
        DEFAULTS: DEFAULTS,
        REASON_LABELS: REASON_LABELS,
        load: load,
        save: save,
        syncToServer: syncToServer,
        syncFromServer: syncFromServer,
        setServerEngineStatus: setServerEngineStatus,
        getServerEngineStatus: getServerEngineStatus,
        isServerAuthoritative: isServerAuthoritative,
        pushSignalToServer: pushSignalToServer,
        setUser: setUser,
        isLoggedIn: isLoggedIn,
        updateSettings: updateSettings,
        getSettings: getSettings,
        getStats: getStats,
        getStatus: getStatus,
        readSignal: readSignal,
        evaluateSignal: evaluateSignal,
        evaluate: evaluate,
        recordClose: recordClose,
        resetStats: resetStats,
        resetCooldowns: resetCooldowns,
        reasonLabel: reasonLabel,
        renderPanel: renderPanel,
        subscribe: subscribe,
        _state: S
    };
});
