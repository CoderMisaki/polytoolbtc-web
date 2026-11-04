/* riskGate.js — NEURAL RISK GATE: final checkpoint before an AI EXECUTE
 * is allowed. Evaluates confidence, disagreement, volatility, liquidity /
 * data quality, risk/reward, existing position and data staleness.
 * Output: PASS (TRADE allowed) or NO_TRADE with explicit reasons.
 * UMD: window.NeuralRiskGate, module.exports for tests.
 */
(function RiskGateUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.NeuralRiskGate = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildRiskGate() {
    'use strict';

    const THRESHOLDS = {
        MIN_CONFIDENCE: 0.55,
        MAX_DISAGREEMENT: 0.50,
        MIN_DATA_QUALITY: 0.40,
        MAX_RISK: 0.78,
        MIN_RR: 1.0,
        MAX_VOLATILITY: 0.92,
        MAX_JUMP_RISK: 0.85,
        MAX_MARKET_IMPACT: 0.88,
        HARD_MIN_CONFIDENCE: 0.35
    };

    function num(v, fb) {
        return Number.isFinite(v) ? v : fb;
    }

    /**
     * Evaluate the gate.
     * input: {
     *   meta: { decision, confidence, disagreement, risk },
     *   dataQuality: 0..1, fresh: bool, stale: bool,
     *   volatility: 0..1, liquidity: 0..1, jumpRisk: 0..1,
     *   marketImpact: 0..1, riskReward: number|null, existingPosition: bool,
     *   activeAgents: number
     * }
     */
    function evaluate(input) {
        const inp = input || {};
        const meta = inp.meta || {};
        const reasons = [];
        const failedChecks = [];

        const confidence = num(meta.confidence, 0);
        const disagreement = num(meta.disagreement, 1);
        const risk = num(meta.risk, 1);
        const dataQuality = num(inp.dataQuality, 0);
        const liquidity = num(inp.liquidity, 0.5);
        const volatility = num(inp.volatility, 0.5);
        const jumpRisk = Math.max(0, Math.min(1, num(inp.jumpRisk, 0)));
        const marketImpact = Math.max(0, Math.min(1, num(inp.marketImpact, 0)));
        const rr = inp.riskReward === null || inp.riskReward === undefined ? null : num(inp.riskReward, 0);
        const stale = inp.stale === true || inp.fresh === false;
        const hasPosition = inp.existingPosition === true;
        const activeAgents = Number.isFinite(inp.activeAgents) ? inp.activeAgents : 5;

        function fail(code, message, severity) {
            failedChecks.push(code);
            reasons.push({ code: code, message: message, severity: severity || 'SOFT' });
        }

        // 1. confidence
        if (confidence < THRESHOLDS.MIN_CONFIDENCE) {
            fail('low-confidence',
                'Confidence ' + Math.round(confidence * 100) + '% di bawah ambang ' +
                Math.round(THRESHOLDS.MIN_CONFIDENCE * 100) + '%',
                confidence < THRESHOLDS.HARD_MIN_CONFIDENCE ? 'HARD' : 'SOFT');
        }
        // 2. disagreement
        if (disagreement > THRESHOLDS.MAX_DISAGREEMENT) {
            fail('high-disagreement',
                'Disagreement antar-agent ' + Math.round(disagreement * 100) + '% melebihi ' +
                Math.round(THRESHOLDS.MAX_DISAGREEMENT * 100) + '%',
                disagreement > 0.7 ? 'HARD' : 'SOFT');
        }
        // 3. volatility extreme
        if (volatility > THRESHOLDS.MAX_VOLATILITY) {
            fail('extreme-volatility', 'Volatilitas ekstrem; sinyal tidak stabil', 'HARD');
        }
        // 4. observed jump / execution-impact risk from the bounded physics
        // model. These are hard only at extreme values.
        if (jumpRisk > THRESHOLDS.MAX_JUMP_RISK) {
            fail('jump-risk', 'Lonjakan harga statistik ekstrem; tunggu stabilisasi', 'HARD');
        }
        if (marketImpact > THRESHOLDS.MAX_MARKET_IMPACT) {
            fail('market-impact', 'Estimasi dampak eksekusi terlalu tinggi', 'HARD');
        }
        // 5. liquidity / data quality
        if (dataQuality < THRESHOLDS.MIN_DATA_QUALITY) {
            fail('poor-data-quality',
                'Kualitas data ' + Math.round(dataQuality * 100) + '% terlalu rendah', 'HARD');
        }
        if (liquidity < 0.2) {
            fail('thin-liquidity', 'Likuiditas/volume terlalu tipis', 'SOFT');
        }
        // 5. risk/reward
        if (rr !== null && rr < THRESHOLDS.MIN_RR) {
            fail('bad-risk-reward', 'Risk/reward ' + rr.toFixed(2) + ' di bawah 1:1', 'SOFT');
        }
        // 6. existing position
        if (hasPosition) {
            fail('position-open', 'Sudah ada posisi aktif di pair ini', 'SOFT');
        }
        // 7. stale market data
        if (stale) {
            fail('stale-data', 'Data market basi (stale); sinyal tidak valid', 'HARD');
        }
        // 8. overall neural risk
        if (risk > THRESHOLDS.MAX_RISK) {
            fail('risk-too-high', 'Skor risiko neural ' + Math.round(risk * 100) + '% terlalu tinggi', 'SOFT');
        }
        // 9. agent quorum
        if (activeAgents < 3) {
            fail('no-quorum', 'Hanya ' + activeAgents + ' agent aktif (butuh >= 3)', 'HARD');
        }

        const hardFails = reasons.filter(function (r) { return r.severity === 'HARD'; });
        const pass = failedChecks.length === 0;

        return {
            pass: pass,
            decision: pass ? 'TRADE' : 'NO_TRADE',
            reasons: reasons,
            failedChecks: failedChecks,
            hardBlock: hardFails.length > 0,
            summary: pass
                ? 'PASS'
                : ('NO_TRADE: ' + reasons.map(function (r) { return r.code; }).join(', '))
        };
    }

    return {
        THRESHOLDS: THRESHOLDS,
        evaluate: evaluate
    };
});
