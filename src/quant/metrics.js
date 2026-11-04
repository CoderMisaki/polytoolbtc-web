/* src/quant/metrics.js — Metrik kuantitatif formal untuk backtest/trading.
 *
 * Temuan audit #3: repo hanya mengukur win rate. Modul ini menambahkan metrik
 * standar industri yang dihitung dari trade records (array {pnl}):
 *
 * - profitFactor  : grossWin / grossLoss
 * - sharpe        : mean/stddev dari return per trade (annualized asumsi)
 * - sortino       : seperti Sharpe tapi hanya memakai downside deviation
 * - maxDrawdown   : penurunan puncak-ke-lembah terbesar dari equity curve
 * - expectancy    : rata-rata pnl per trade
 * - winRate       : wins / trades
 * - calmar        : annualized return / maxDrawdown
 *
 * Semua fungsi pure (tidak ada side-effect), aman dipakai di browser maupun
 * Node (test). Nilai yang tidak terdefinisi (mis. stddev=0) dikembalikan
 * sebagai null, bukan Infinity/NaN.
 */
(function () {
    'use strict';

    function pnlsOf(records) {
        if (!Array.isArray(records)) return [];
        const out = [];
        for (let i = 0; i < records.length; i++) {
            const p = Number(records[i] && records[i].pnl);
            if (Number.isFinite(p)) out.push(p);
        }
        return out;
    }

    function mean(xs) {
        if (!xs.length) return 0;
        let s = 0;
        for (let i = 0; i < xs.length; i++) s += xs[i];
        return s / xs.length;
    }

    function stddev(xs, m) {
        if (xs.length < 2) return 0;
        const mu = (m === undefined) ? mean(xs) : m;
        let s = 0;
        for (let i = 0; i < xs.length; i++) s += (xs[i] - mu) * (xs[i] - mu);
        return Math.sqrt(s / (xs.length - 1));
    }

    function winRate(records) {
        const xs = pnlsOf(records);
        if (!xs.length) return null;
        let w = 0;
        for (let i = 0; i < xs.length; i++) if (xs[i] > 0) w++;
        return w / xs.length;
    }

    function profitFactor(records) {
        const xs = pnlsOf(records);
        let gw = 0, gl = 0;
        for (let i = 0; i < xs.length; i++) {
            if (xs[i] > 0) gw += xs[i];
            else gl += Math.abs(xs[i]);
        }
        if (gw === 0 && gl === 0) return null;
        if (gl === 0) return gw > 0 ? Infinity : null;
        return gw / gl;
    }

    function expectancy(records) {
        const xs = pnlsOf(records);
        if (!xs.length) return null;
        return mean(xs);
    }

    // Sharpe: mean/stddev per trade. Annualized dengan asumsi N trade/tahun.
    // Untuk backtest intraday dengan interval ~1 menit, default 525600 trade/tahun
    // terlalu agresif; pemanggil bisa mengisi tradesPerYear sesuai frekuensi.
    function sharpe(records, tradesPerYear) {
        const xs = pnlsOf(records);
        if (xs.length < 2) return null;
        const mu = mean(xs);
        const sd = stddev(xs, mu);
        if (!(sd > 0)) return null;
        const tpy = Number(tradesPerYear) > 0 ? Number(tradesPerYear) : 252;
        return (mu / sd) * Math.sqrt(tpy);
    }

    // Sortino: seperti Sharpe tapi penyebut hanya downside deviation.
    function sortino(records, tradesPerYear) {
        const xs = pnlsOf(records);
        if (xs.length < 2) return null;
        const mu = mean(xs);
        let downside = 0, n = 0;
        for (let i = 0; i < xs.length; i++) {
            if (xs[i] < 0) { downside += xs[i] * xs[i]; n++; }
        }
        if (n === 0) return mu > 0 ? Infinity : null;
        const dd = Math.sqrt(downside / n);
        if (!(dd > 0)) return null;
        const tpy = Number(tradesPerYear) > 0 ? Number(tradesPerYear) : 252;
        return (mu / dd) * Math.sqrt(tpy);
    }

    // Max drawdown dari equity curve yang dibangun dari pnl berurutan.
    // Mengembalikan { amount, pct } — pct relatif terhadap peak.
    function maxDrawdown(records, startEquity) {
        const xs = pnlsOf(records);
        if (!xs.length) return null;
        let equity = Number(startEquity) > 0 ? Number(startEquity) : 10000;
        let peak = equity;
        let maxDd = 0;
        for (let i = 0; i < xs.length; i++) {
            equity += xs[i];
            if (equity > peak) peak = equity;
            const dd = peak - equity;
            if (dd > maxDd) maxDd = dd;
        }
        return { amount: maxDd, pct: peak > 0 ? maxDd / peak : 0 };
    }

    function calmar(records, startEquity, tradesPerYear) {
        const xs = pnlsOf(records);
        if (xs.length < 2) return null;
        const totalReturn = xs.reduce((a, b) => a + b, 0);
        const dd = maxDrawdown(records, startEquity);
        if (!dd || !(dd.amount > 0)) return totalReturn > 0 ? Infinity : null;
        const tpy = Number(tradesPerYear) > 0 ? Number(tradesPerYear) : 252;
        // Annualized return diaproksimasi dari total return / (trades/tpy tahun)
        const years = xs.length / tpy;
        if (!(years > 0)) return null;
        const annReturn = totalReturn / years;
        return annReturn / dd.amount;
    }

    // Rangkuman satu panggilan: semua metrik sekaligus.
    function summarize(records, opts) {
        const o = opts || {};
        const dd = maxDrawdown(records, o.startEquity);
        return {
            trades: pnlsOf(records).length,
            winRate: winRate(records),
            profitFactor: profitFactor(records),
            expectancy: expectancy(records),
            sharpe: sharpe(records, o.tradesPerYear),
            sortino: sortino(records, o.tradesPerYear),
            maxDrawdown: dd,
            calmar: calmar(records, o.startEquity, o.tradesPerYear)
        };
    }

    const QuantMetrics = {
        winRate, profitFactor, expectancy, sharpe, sortino,
        maxDrawdown, calmar, summarize
    };

    if (typeof window !== 'undefined') window.QuantMetrics = QuantMetrics;
    if (typeof module !== 'undefined' && module.exports) module.exports = QuantMetrics;
})();
