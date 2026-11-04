/* patternMemory.js — WIDE-CONTEXT PATTERN MINER for the animal brains.
 *
 * The eight agents already read the chart in front of them. This module gives
 * them something far wider: months of daily structure, weeks of hourly
 * structure and days of intraday structure, mined for repeatable patterns that
 * are hard to spot by eye, for example:
 *
 *   "yesterday +4.2%, today -3.1% and we are at hour 14 → of 38 similar
 *    historical moments, 63% recovered within 4 hours."
 *
 * Four independent pattern families are computed:
 *   1. dayContext  — previous-day move + move-so-far + hour-of-day, with the
 *                    outcome that followed (4h and 24h later).
 *   2. hourProfile — hour-of-day seasonality (which hours historically bounce
 *                    or fade) measured on 1h candles with a 4h forward window.
 *   3. minuteProfile — minute-of-hour microstructure seasonality (5m candles,
 *                    15m forward window).
 *   4. analogs     — z-normalized shape matching: how did the market behave
 *                    the last k times its recent shape looked like now?
 *   5. motifs      — short candle-state sequences (5m) with forward stats.
 *
 * Honesty + safety rules:
 *   - Every family is computed ONLY from closed candles; the forward outcome of
 *     a sample must be fully in the past before that sample is used, so there
 *     is no look-ahead bias.
 *   - A family with too few samples reports zero confidence instead of a made
 *     up number.
 *   - All outputs are bounded: features live in [-1, 1] and findings carry
 *     their sample count so the UI can show how thin the evidence is.
 *
 * UMD: window.PatternMemory in browsers, module.exports in Node (deterministic).
 */
(function PatternMemoryUMD(root, factory) {
    const api = factory(root);
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.PatternMemory = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildPatternMemory() {
    'use strict';

    const INTERVAL_SECONDS = {
        '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400
    };

    const HOUR_HORIZON = 4;        // 1h candles -> 4 hour forward window
    const MINUTE_HORIZON = 3;      // 5m candles -> 15 minute forward window
    const DAY_HORIZONS = [4, 24];  // hours after the matched moment
    const MOTIF_HORIZON = 3;       // 5m candles forward
    const MIN_FAMILY_SAMPLES = 12;
    const MOTIF_MIN_SAMPLES = 20;
    const ANALOG_TOP_K = 25;
    const MAX_FINDINGS = 6;
    const SERIES_CAP = { '1m': 2000, '5m': 3000, '15m': 4000, '1h': 4000, '4h': 2000, '1d': 2000 };

    // ------------------------------------------------------------- utilities

    function clamp(x, lo, hi) {
        if (!Number.isFinite(x)) return 0;
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

    function clamp11(x) { return clamp(x, -1, 1); }

    function soft(x) {
        if (!Number.isFinite(x)) return 0;
        return x / (1 + Math.abs(x));
    }

    function mean(values) {
        let sum = 0;
        let n = 0;
        for (let i = 0; i < values.length; i++) {
            if (Number.isFinite(values[i])) { sum += values[i]; n++; }
        }
        return n > 0 ? sum / n : 0;
    }

    function pctChange(from, to) {
        if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return NaN;
        return (to - from) / from;
    }

    function localHour(timeSeconds) {
        try { return new Date(timeSeconds * 1000).getHours(); } catch (e) { return -1; }
    }

    function localDateKey(timeSeconds) {
        try {
            const d = new Date(timeSeconds * 1000);
            const m = d.getMonth() + 1;
            const day = d.getDate();
            return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
        } catch (e) { return 'unknown'; }
    }

    function pad2(v) { return (v < 10 ? '0' : '') + v; }

    function clockLabel(timeSeconds) {
        const h = localHour(timeSeconds);
        if (h < 0) return '--:--';
        const d = new Date(timeSeconds * 1000);
        return pad2(h) + ':' + pad2(d.getMinutes());
    }

    function fmtPct(x, digits) {
        if (!Number.isFinite(x)) return '—';
        const d = Number.isFinite(digits) ? digits : 2;
        const v = x * 100;
        return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
    }

    function fmtRatio(x) {
        if (!Number.isFinite(x)) return '—';
        return Math.round(x * 100) + '%';
    }

    function directionOf(bias) {
        if (!Number.isFinite(bias)) return 'NEUTRAL';
        if (bias > 0.12) return 'LONG';
        if (bias < -0.12) return 'SHORT';
        return 'NEUTRAL';
    }

    function hourBand(hour) {
        if (hour < 0) return 'UNKNOWN';
        if (hour < 8) return 'ASIA';
        if (hour < 13) return 'LONDON-PAGI';
        if (hour < 16) return 'LONDON-NY';
        if (hour < 21) return 'NEW YORK';
        return 'MALAM';
    }

    /** Move magnitude bucket, used to describe "big vs small" moves. */
    function moveBucket(pct, edges, labels) {
        if (!Number.isFinite(pct)) return 'UNKNOWN';
        for (let i = 0; i < edges.length; i++) {
            if (pct >= edges[i][0]) return labels[i];
        }
        return labels[labels.length - 1];
    }

    const PREV_DAY_EDGES = [[0.03, 'UP'], [0.0075, 'up'], [-0.0075, 'flat'], [-0.03, 'down']];
    const PREV_DAY_LABELS = ['kemarin naik tajam', 'kemarin naik', 'kemarin datar', 'kemarin turun', 'kemarin turun dalam'];
    const TODAY_EDGES = [[0.02, 'UP'], [0.005, 'up'], [-0.005, 'flat'], [-0.02, 'down']];
    const TODAY_LABELS = ['hari ini naik tajam', 'hari ini naik', 'hari ini datar', 'hari ini turun', 'hari ini turun dalam'];
    const MOTIF_EDGES = [[0.006, 'UP'], [0.0015, 'up'], [-0.0015, 'flat'], [-0.006, 'down']];
    const MOTIF_LABELS = ['naik tajam', 'naik', 'datar', 'turun', 'turun dalam'];

    // ------------------------------------------------------- series handling

    function normalizeSeries(candles, tf) {
        if (!Array.isArray(candles)) return [];
        const interval = INTERVAL_SECONDS[tf] || 0;
        const out = [];
        let lastTime = -Infinity;
        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            if (!c) continue;
            const time = Number.isFinite(c.time) ? c.time : NaN;
            const close = Number.isFinite(c.close) ? c.close : NaN;
            if (!Number.isFinite(time) || !Number.isFinite(close) || close <= 0) continue;
            if (time <= lastTime) continue;
            if (interval > 0 && Number.isFinite(c.closeTime) && c.closeTime > Math.floor(Date.now() / 1000)) continue;
            lastTime = time;
            out.push({
                time: time,
                open: Number.isFinite(c.open) ? c.open : close,
                high: Number.isFinite(c.high) ? c.high : close,
                low: Number.isFinite(c.low) ? c.low : close,
                close: close,
                vol: Number.isFinite(c.vol) ? c.vol : 0
            });
        }
        out.sort(function (a, b) { return a.time - b.time; });
        const cap = SERIES_CAP[tf] || 3000;
        return out.length > cap ? out.slice(out.length - cap) : out;
    }

    // ------------------------------------------------------ family: hourProfile

    function hourProfile(series1h, options) {
        const opts = options || {};
        const horizon = Number.isFinite(opts.horizon) ? opts.horizon : HOUR_HORIZON;
        const buckets = [];
        for (let i = 0; i < 24; i++) buckets.push({ hour: i, n: 0, up: 0, sum: 0, absSum: 0 });
        const n = series1h.length;
        if (n < horizon + 24) return { ok: false, reason: 'INSUFFICIENT_DATA', samples: 0 };

        for (let i = 0; i + horizon < n; i++) {
            const hour = localHour(series1h[i].time);
            if (hour < 0) continue;
            const fwd = pctChange(series1h[i].close, series1h[i + horizon].close);
            if (!Number.isFinite(fwd)) continue;
            const b = buckets[hour];
            b.n++;
            b.sum += fwd;
            b.absSum += Math.abs(fwd);
            if (fwd > 0) b.up++;
        }

        const currentHour = localHour(series1h[n - 1].time);
        const current = buckets[currentHour] || null;
        const total = buckets.reduce(function (acc, b) { return acc + b.n; }, 0);
        if (!current || current.n < MIN_FAMILY_SAMPLES) {
            return { ok: false, reason: 'THIN_SAMPLES', samples: current ? current.n : 0, hour: currentHour, buckets: buckets };
        }

        const upFraction = current.up / current.n;
        const avgMove = current.sum / current.n;
        const avgAbs = current.n > 0 ? current.absSum / current.n : 0;
        // Zero dispersion means the sample carries no directional information.
        if (!(avgAbs > 0)) {
            return { ok: false, reason: 'NO_VARIANCE', samples: current.n, hour: currentHour, buckets: buckets };
        }
        const scale = avgAbs;
        const magnitude = clamp(avgMove / (scale * 2), -1, 1);
        const sampleConfidence = clamp(current.n / 60, 0, 1);
        const bias = clamp11((((upFraction - 0.5) * 2) * 0.6 + magnitude * 0.4) * (0.45 + 0.55 * sampleConfidence));

        return {
            ok: true,
            samples: current.n,
            totalSamples: total,
            hour: currentHour,
            upFraction: upFraction,
            avgMove: avgMove,
            bias: bias,
            buckets: buckets,
            strength: clamp(Math.abs(bias) * (0.4 + 0.6 * sampleConfidence), 0, 1)
        };
    }

    // ---------------------------------------------------- family: minuteProfile

    function minuteProfile(series5m, options) {
        const opts = options || {};
        const horizon = Number.isFinite(opts.horizon) ? opts.horizon : MINUTE_HORIZON;
        const bucketSize = 5;
        const bucketCount = 12;
        const buckets = [];
        for (let i = 0; i < bucketCount; i++) buckets.push({ idx: i, n: 0, up: 0, sum: 0, absSum: 0 });
        const n = series5m.length;
        if (n < horizon + 60) return { ok: false, reason: 'INSUFFICIENT_DATA', samples: 0 };

        for (let i = 0; i + horizon < n; i++) {
            let minute = -1;
            try { minute = new Date(series5m[i].time * 1000).getMinutes(); } catch (e) { minute = -1; }
            if (minute < 0) continue;
            const idx = Math.min(bucketCount - 1, Math.floor(minute / bucketSize));
            const fwd = pctChange(series5m[i].close, series5m[i + horizon].close);
            if (!Number.isFinite(fwd)) continue;
            const b = buckets[idx];
            b.n++;
            b.sum += fwd;
            b.absSum += Math.abs(fwd);
            if (fwd > 0) b.up++;
        }

        let currentMinute = -1;
        try { currentMinute = new Date(series5m[n - 1].time * 1000).getMinutes(); } catch (e) { currentMinute = -1; }
        const currentIdx = currentMinute >= 0 ? Math.min(bucketCount - 1, Math.floor(currentMinute / bucketSize)) : -1;
        const current = currentIdx >= 0 ? buckets[currentIdx] : null;
        if (!current || current.n < MIN_FAMILY_SAMPLES) {
            return { ok: false, reason: 'THIN_SAMPLES', samples: current ? current.n : 0, buckets: buckets };
        }

        const upFraction = current.up / current.n;
        const avgMove = current.sum / current.n;
        const avgAbs = current.absSum / current.n;
        if (!(avgAbs > 0)) {
            return { ok: false, reason: 'NO_VARIANCE', samples: current.n, buckets: buckets };
        }
        const scale = avgAbs;
        const magnitude = clamp(avgMove / (scale * 2), -1, 1);
        const sampleConfidence = clamp(current.n / 120, 0, 1);
        const bias = clamp11((((upFraction - 0.5) * 2) * 0.65 + magnitude * 0.35) * (0.4 + 0.6 * sampleConfidence));

        return {
            ok: true,
            samples: current.n,
            bucketStart: current.idx * bucketSize,
            bucketEnd: current.idx * bucketSize + bucketSize - 1,
            minute: currentMinute,
            upFraction: upFraction,
            avgMove: avgMove,
            bias: bias,
            strength: clamp(Math.abs(bias) * (0.4 + 0.6 * sampleConfidence), 0, 1)
        };
    }

    // ----------------------------------------------------- family: dayContext

    function buildDayContext(series1h, options) {
        const opts = options || {};
        const horizons = Array.isArray(opts.horizons) ? opts.horizons : DAY_HORIZONS;
        const maxHorizon = Math.max.apply(null, horizons);
        const annotate = opts.annotate === true;
        const n = series1h.length;
        if (n < maxHorizon + 48) return { ok: false, reason: 'INSUFFICIENT_DATA', samples: 0 };

        // Annotate every candle with its day context (day open, previous-day
        // move, position inside the day).
        const dayOrder = [];
        const dayIndexByKey = {};
        const annotated = new Array(n);
        let prevDayClose = NaN;
        let prevDayOpen = NaN;
        let currentKey = null;
        let dayOpen = NaN;

        for (let i = 0; i < n; i++) {
            const key = localDateKey(series1h[i].time);
            if (key !== currentKey) {
                if (currentKey !== null) {
                    prevDayClose = series1h[i - 1].close;
                    prevDayOpen = dayOpen;
                }
                currentKey = key;
                dayIndexByKey[key] = dayOrder.length;
                dayOrder.push({ key: key, from: i, to: i, open: series1h[i].open, close: series1h[i].close, candles: 1 });
                dayOpen = series1h[i].open;
            } else {
                dayOrder[dayOrder.length - 1].to = i;
                dayOrder[dayOrder.length - 1].close = series1h[i].close;
                dayOrder[dayOrder.length - 1].candles++;
            }
            annotated[i] = {
                dayIndex: dayOrder.length - 1,
                dayKey: key,
                dayOpen: dayOpen,
                prevDayMove: pctChange(prevDayOpen, prevDayClose)
            };
        }

        const lastDayIndex = dayOrder.length - 1;
        const samples = [];
        for (let i = 0; i + maxHorizon < n; i++) {
            const info = annotated[i];
            if (!info) continue;
            // Only complete days contribute samples: the running day's outcome
            // is not known yet, so it may never be used as evidence.
            if (info.dayIndex >= lastDayIndex) continue;
            const day = dayOrder[info.dayIndex];
            if (day.candles < 8) continue;
            const moveSoFar = pctChange(info.dayOpen, series1h[i].close);
            if (!Number.isFinite(moveSoFar)) continue;
            const hour = localHour(series1h[i].time);
            if (hour < 0) continue;
            const forward = {};
            let usable = true;
            for (let h = 0; h < horizons.length; h++) {
                const value = pctChange(series1h[i].close, series1h[i + horizons[h]].close);
                if (!Number.isFinite(value)) { usable = false; break; }
                forward[horizons[h]] = value;
            }
            if (!usable) continue;
            samples.push({
                time: series1h[i].time,
                hour: hour,
                hourBand: hourBand(hour),
                prevDayMove: info.prevDayMove,
                moveSoFar: moveSoFar,
                forward: forward,
                dayKey: info.dayKey
            });
        }

        if (samples.length < MIN_FAMILY_SAMPLES) {
            return { ok: false, reason: 'THIN_SAMPLES', samples: samples.length };
        }

        // Current situation = last closed 1h candle of the running day.
        const curInfo = annotated[n - 1];
        const curMove = pctChange(curInfo.dayOpen, series1h[n - 1].close);
        const curHour = localHour(series1h[n - 1].time);
        const curPrevMove = curInfo.prevDayMove;
        const curPrevLabel = moveBucket(curPrevMove, PREV_DAY_EDGES, PREV_DAY_LABELS);
        const curMoveLabel = moveBucket(curMove, TODAY_EDGES, TODAY_LABELS);

        function collect(matchHour, requireBand) {
            const out = [];
            for (let i = 0; i < samples.length; i++) {
                const s = samples[i];
                if (moveBucket(s.prevDayMove, PREV_DAY_EDGES, PREV_DAY_LABELS) !== curPrevLabel) continue;
                if (moveBucket(s.moveSoFar, TODAY_EDGES, TODAY_LABELS) !== curMoveLabel) continue;
                if (requireBand) {
                    if (s.hourBand !== hourBand(curHour)) continue;
                } else if (s.hour !== curHour) {
                    continue;
                }
                out.push(s);
            }
            return out;
        }

        let matched = collect(curHour, false);
        let matchedMode = 'jam-sama';
        if (matched.length < MIN_FAMILY_SAMPLES) {
            const bandMatched = collect(curHour, true);
            if (bandMatched.length > matched.length) {
                matched = bandMatched;
                matchedMode = 'sesi-sama';
            }
        }

        if (matched.length < MIN_FAMILY_SAMPLES) {
            return {
                ok: false,
                reason: 'THIN_SAMPLES',
                samples: matched.length,
                totalSamples: samples.length,
                current: { prevDayMove: curPrevMove, moveSoFar: curMove, hour: curHour, prevLabel: curPrevLabel, moveLabel: curMoveLabel }
            };
        }

        const perHorizon = {};
        horizons.forEach(function (h) {
            let up = 0;
            let sum = 0;
            let absSum = 0;
            matched.forEach(function (s) {
                const v = s.forward[h];
                if (!Number.isFinite(v)) return;
                if (v > 0) up++;
                sum += v;
                absSum += Math.abs(v);
            });
            const nS = matched.length;
            perHorizon[h] = {
                horizon: h,
                upFraction: nS > 0 ? up / nS : 0,
                avgMove: nS > 0 ? sum / nS : 0,
                avgAbs: nS > 0 ? absSum / nS : 0
            };
        });

        const primary = perHorizon[horizons[0]];
        if (!(primary.avgAbs > 0)) {
            return { ok: false, reason: 'NO_VARIANCE', samples: matched.length, totalSamples: samples.length };
        }
        const sampleConfidence = clamp(matched.length / 45, 0, 1);
        const scale = primary.avgAbs;
        const magnitude = clamp(primary.avgMove / (scale * 2), -1, 1);
        const bias = clamp11((((primary.upFraction - 0.5) * 2) * 0.6 + magnitude * 0.4) * (0.4 + 0.6 * sampleConfidence));

        return {
            ok: true,
            samples: matched.length,
            totalSamples: samples.length,
            matchMode: matchedMode,
            current: {
                prevDayMove: curPrevMove,
                moveSoFar: curMove,
                hour: curHour,
                prevLabel: curPrevLabel,
                moveLabel: curMoveLabel
            },
            perHorizon: perHorizon,
            upFraction: primary.upFraction,
            avgMove: primary.avgMove,
            bias: bias,
            strength: clamp(Math.abs(bias) * (0.4 + 0.6 * sampleConfidence), 0, 1),
            samplesDetail: annotate ? matched.slice(-40) : undefined
        };
    }

    // --------------------------------------------------------- family: analogs

    function zShape(closes, endIndex, window) {
        const rets = [];
        for (let i = endIndex - window + 1; i <= endIndex; i++) {
            if (i <= 0 || i >= closes.length) return null;
            const r = pctChange(closes[i - 1], closes[i]);
            if (!Number.isFinite(r)) return null;
            rets.push(r);
        }
        const m = mean(rets);
        let variance = 0;
        for (let i = 0; i < rets.length; i++) variance += (rets[i] - m) * (rets[i] - m);
        const sd = Math.sqrt(variance / rets.length) || 1e-9;
        return rets.map(function (r) { return (r - m) / sd; });
    }

    /**
     * Shape matching over a wide series. Candidates whose forward outcome is
     * not fully in the past are excluded, so nothing looks ahead.
     */
    function analogSearch(series, options) {
        const opts = options || {};
        const window = Number.isFinite(opts.window) ? opts.window : 12;
        const horizons = Array.isArray(opts.horizons) ? opts.horizons : [4, 12];
        const topK = Number.isFinite(opts.topK) ? opts.topK : ANALOG_TOP_K;
        const minSeparation = Number.isFinite(opts.minSeparation) ? opts.minSeparation : Math.max(3, Math.floor(window / 2));
        const n = series.length;
        const maxHorizon = Math.max.apply(null, horizons);
        if (n < window * 3 + maxHorizon) return { ok: false, reason: 'INSUFFICIENT_DATA', samples: 0 };

        const closes = series.map(function (c) { return c.close; });
        const currentShape = zShape(closes, n - 1, window);
        if (!currentShape) return { ok: false, reason: 'BAD_SHAPE', samples: 0 };

        const candidates = [];
        const lastUsable = n - 1 - maxHorizon;
        for (let i = window; i <= lastUsable; i++) {
            if (i > n - 1 - window) continue; // keep the search away from the live window
            const shape = zShape(closes, i, window);
            if (!shape) continue;
            let distance = 0;
            for (let k = 0; k < window; k++) {
                const d = shape[k] - currentShape[k];
                distance += d * d;
            }
            candidates.push({ index: i, distance: Math.sqrt(distance) });
        }
        if (candidates.length < 20) return { ok: false, reason: 'THIN_SAMPLES', samples: candidates.length };

        candidates.sort(function (a, b) { return a.distance - b.distance; });
        const picked = [];
        for (let i = 0; i < candidates.length && picked.length < topK; i++) {
            const cand = candidates[i];
            let tooClose = false;
            for (let k = 0; k < picked.length; k++) {
                if (Math.abs(picked[k].index - cand.index) < minSeparation) { tooClose = true; break; }
            }
            if (tooClose) continue;
            picked.push(cand);
        }
        if (picked.length < 8) return { ok: false, reason: 'THIN_SAMPLES', samples: picked.length };

        const perHorizon = {};
        horizons.forEach(function (h) {
            let up = 0;
            let sum = 0;
            let absSum = 0;
            let worst = 0;
            picked.forEach(function (p) {
                const fwd = pctChange(closes[p.index], closes[p.index + h]);
                if (!Number.isFinite(fwd)) return;
                if (fwd > 0) up++;
                sum += fwd;
                absSum += Math.abs(fwd);
                if (fwd < worst) worst = fwd;
            });
            const count = picked.length;
            perHorizon[h] = {
                horizon: h,
                upFraction: count > 0 ? up / count : 0,
                avgMove: count > 0 ? sum / count : 0,
                avgAbs: count > 0 ? absSum / count : 0,
                worst: worst
            };
        });

        const primary = perHorizon[horizons[0]];
        if (!(primary.avgAbs > 0)) {
            return { ok: false, reason: 'NO_VARIANCE', samples: picked.length, scanned: candidates.length };
        }
        const sampleConfidence = clamp(picked.length / topK, 0, 1);
        const scale = primary.avgAbs;
        const magnitude = clamp(primary.avgMove / (scale * 2), -1, 1);
        const bias = clamp11((((primary.upFraction - 0.5) * 2) * 0.6 + magnitude * 0.4) * (0.45 + 0.55 * sampleConfidence));
        const avgDistance = mean(picked.map(function (p) { return p.distance; }));

        return {
            ok: true,
            samples: picked.length,
            scanned: candidates.length,
            window: window,
            horizons: horizons,
            perHorizon: perHorizon,
            upFraction: primary.upFraction,
            avgMove: primary.avgMove,
            avgDistance: avgDistance,
            bias: bias,
            strength: clamp(Math.abs(bias) * (0.35 + 0.65 * sampleConfidence), 0, 1),
            matches: picked.slice(0, 8).map(function (p) {
                return {
                    time: series[p.index].time,
                    clock: clockLabel(series[p.index].time),
                    distance: p.distance,
                    forwardPrimary: perHorizon[horizons[0]] ? pctChange(closes[p.index], closes[p.index + horizons[0]]) : NaN
                };
            })
        };
    }

    // ---------------------------------------------------------- family: motifs

    function classifyCandle(candle, atrRef) {
        const range = Math.max(candle.high - candle.low, 1e-12);
        const body = (candle.close - candle.open) / range;
        const scale = atrRef > 0 ? (candle.high - candle.low) / atrRef : 1;
        const strength = clamp(scale, 0, 3);
        if (body > 0.35 && strength > 0.8) return 'naik tajam';
        if (body > 0.15) return 'naik';
        if (body < -0.35 && strength > 0.8) return 'turun dalam';
        if (body < -0.15) return 'turun';
        return 'datar';
    }

    function motifProfile(series5m, options) {
        const opts = options || {};
        const horizon = Number.isFinite(opts.horizon) ? opts.horizon : MOTIF_HORIZON;
        const n = series5m.length;
        if (n < 120) return { ok: false, reason: 'INSUFFICIENT_DATA', samples: 0 };

        // ATR proxy: average range of the last 200 candles.
        let rangeSum = 0;
        let rangeN = 0;
        for (let i = Math.max(0, n - 200); i < n; i++) {
            rangeSum += series5m[i].high - series5m[i].low;
            rangeN++;
        }
        const atrRef = rangeN > 0 ? rangeSum / rangeN : 0;

        const table = {};
        const states = new Array(n);
        for (let i = 0; i < n; i++) states[i] = classifyCandle(series5m[i], atrRef);

        for (let i = 2; i + horizon < n; i++) {
            const key = states[i - 2] + '|' + states[i - 1] + '|' + states[i];
            const fwd = pctChange(series5m[i].close, series5m[i + horizon].close);
            if (!Number.isFinite(fwd)) continue;
            const entry = table[key] || (table[key] = { key: key, n: 0, up: 0, sum: 0, absSum: 0 });
            entry.n++;
            entry.sum += fwd;
            entry.absSum += Math.abs(fwd);
            if (fwd > 0) entry.up++;
        }

        const currentKey = states[n - 1] + '|' + states[n - 2] + '|' + states[n - 3];
        const current = table[currentKey];
        if (!current || current.n < MOTIF_MIN_SAMPLES) {
            return { ok: false, reason: 'THIN_SAMPLES', samples: current ? current.n : 0, key: currentKey, tableSize: Object.keys(table).length };
        }

        const upFraction = current.up / current.n;
        const avgMove = current.sum / current.n;
        const avgAbs = current.absSum / current.n;
        if (!(avgAbs > 0)) {
            return { ok: false, reason: 'NO_VARIANCE', samples: current.n, key: currentKey };
        }
        const scale = avgAbs;
        const magnitude = clamp(avgMove / (scale * 2), -1, 1);
        const sampleConfidence = clamp(current.n / 120, 0, 1);
        const bias = clamp11((((upFraction - 0.5) * 2) * 0.6 + magnitude * 0.4) * (0.45 + 0.55 * sampleConfidence));

        return {
            ok: true,
            samples: current.n,
            key: currentKey,
            tableSize: Object.keys(table).length,
            upFraction: upFraction,
            avgMove: avgMove,
            bias: bias,
            strength: clamp(Math.abs(bias) * (0.4 + 0.6 * sampleConfidence), 0, 1)
        };
    }

    // ------------------------------------------------------------- aggregation

    function blend(biases, weights) {
        let sum = 0;
        let wSum = 0;
        for (let i = 0; i < biases.length; i++) {
            const b = biases[i];
            if (!Number.isFinite(b)) continue;
            const w = Number.isFinite(weights[i]) ? weights[i] : 1;
            sum += b * w;
            wSum += w;
        }
        return wSum > 0 ? clamp11(sum / wSum) : 0;
    }

    function agreement(biases) {
        const valid = biases.filter(function (b) { return Number.isFinite(b) && Math.abs(b) > 1e-6; });
        if (valid.length < 2) return valid.length === 1 ? 0.5 : 0;
        const longCount = valid.filter(function (b) { return b > 0; }).length;
        const shortCount = valid.length - longCount;
        const share = Math.max(longCount, shortCount) / valid.length;
        return clamp((share - 0.5) * 2, 0, 1);
    }

    function buildFindings(families, ctx) {
        const findings = [];

        if (families.dayContext && families.dayContext.ok) {
            const f = families.dayContext;
            const cur = f.current;
            const primary = f.perHorizon[DAY_HORIZONS[0]] || null;
            const horizonLabel = (DAY_HORIZONS[0]) + ' jam';
            findings.push({
                id: 'day-context',
                title: 'Konteks harian + jam',
                detail: cur.prevLabel + ', ' + cur.moveLabel + ' di jam ' + pad2(cur.hour) + ':00 → ' +
                    fmtRatio(f.upFraction) + ' dari ' + f.samples + ' kejadian serupa berbalik ' +
                    (primary && primary.avgMove > 0 ? 'naik' : 'turun') + ' dalam ' + horizonLabel +
                    ' (rata-rata ' + fmtPct(primary ? primary.avgMove : NaN) + ').',
                direction: directionOf(f.bias),
                strength: f.strength,
                samples: f.samples,
                source: 'gabungan 1 jam × ' + (ctx.counts['1h'] || 0) + ' candle',
                bias: f.bias
            });
        }

        if (families.hourProfile && families.hourProfile.ok) {
            const f = families.hourProfile;
            findings.push({
                id: 'hour-profile',
                title: 'Pola jam ke-' + pad2(f.hour) + ':00',
                detail: 'Sejarah jam ' + pad2(f.hour) + ':00 (' + f.samples + ' sampel) menunjukkan ' +
                    fmtRatio(f.upFraction) + ' candle naik dalam ' + HOUR_HORIZON +
                    ' jam berikutnya, rata-rata ' + fmtPct(f.avgMove) + '.',
                direction: directionOf(f.bias),
                strength: f.strength,
                samples: f.samples,
                source: '1 jam × ' + (ctx.counts['1h'] || 0) + ' candle',
                bias: f.bias
            });
        }

        if (families.minuteProfile && families.minuteProfile.ok) {
            const f = families.minuteProfile;
            findings.push({
                id: 'minute-profile',
                title: 'Pola menit ' + pad2(f.minute) + ' (blok ' + pad2(f.bucketStart) + '-' + pad2(f.bucketEnd) + ')',
                detail: 'Pada blok menit ini, ' + fmtRatio(f.upFraction) + ' dari ' + f.samples +
                    ' kejadian historis bergerak naik dalam 15 menit berikutnya (rata-rata ' + fmtPct(f.avgMove) + ').',
                direction: directionOf(f.bias),
                strength: f.strength,
                samples: f.samples,
                source: '5 menit × ' + (ctx.counts['5m'] || 0) + ' candle',
                bias: f.bias
            });
        }

        (families.analogs || []).forEach(function (entry) {
            const f = entry.result;
            if (!f || !f.ok) return;
            const labels = entry.horizons.map(function (h) {
                return h + ' bar (' + (entry.tf === '1h' ? h + ' jam' : '15m × ' + h) + ')';
            });
            findings.push({
                id: 'analog-' + entry.tf,
                title: 'Kemiripan bentuk ' + entry.label,
                detail: 'Bentuk ' + entry.windowLabel + ' terakhir paling mirip dengan ' + f.samples +
                    ' momen historis (dari ' + f.scanned + ' kandidat). Setelahnya: ' +
                    fmtRatio(f.upFraction) + ' naik pada ' + labels[0] +
                    ' (rata-rata ' + fmtPct(f.avgMove) + ').',
                direction: directionOf(f.bias),
                strength: f.strength,
                samples: f.samples,
                source: entry.tf + ' × ' + (ctx.counts[entry.tf] || 0) + ' candle',
                bias: f.bias
            });
        });

        if (families.motif && families.motif.ok) {
            const f = families.motif;
            findings.push({
                id: 'motif-3-candle',
                title: 'Motif 3 candle (5 menit)',
                detail: 'Urutan candle "' + f.key + '" sudah terjadi ' + f.samples + ' kali; ' +
                    fmtRatio(f.upFraction) + ' di antaranya naik dalam 15 menit (rata-rata ' + fmtPct(f.avgMove) + ').',
                direction: directionOf(f.bias),
                strength: f.strength,
                samples: f.samples,
                source: '5 menit × ' + (ctx.counts['5m'] || 0) + ' candle',
                bias: f.bias
            });
        }

        findings.sort(function (a, b) { return b.strength - a.strength; });
        return findings.slice(0, MAX_FINDINGS);
    }

    function statusLabel(analysis) {
        if (!analysis) return 'BELUM ADA DATA';
        if (!analysis.ok) return 'DATA KURANG';
        if (analysis.partial) return 'PARSIAL';
        if (analysis.findings.length === 0) return 'TIDAK ADA POLA';
        return analysis.stats.families + ' keluarga pola';
    }

    /**
     * Mine every family from a wide corpus.
     * corpus: { pair, series: { '1m': [...], '5m': [...], '15m': [...], '1h': [...], '4h': [...], '1d': [...] }, fetchedAt }
     */
    function build(corpus, options) {
        const opts = options || {};
        const source = corpus && corpus.series ? corpus.series : {};
        const series = {
            '1m': normalizeSeries(source['1m'], '1m'),
            '5m': normalizeSeries(source['5m'], '5m'),
            '15m': normalizeSeries(source['15m'], '15m'),
            '1h': normalizeSeries(source['1h'], '1h'),
            '4h': normalizeSeries(source['4h'], '4h'),
            '1d': normalizeSeries(source['1d'], '1d')
        };
        const counts = {};
        Object.keys(series).forEach(function (tf) { counts[tf] = series[tf].length; });

        const total = Object.keys(counts).reduce(function (acc, tf) { return acc + counts[tf]; }, 0);
        if (total < 300) {
            return {
                ok: false,
                reason: 'INSUFFICIENT_DATA',
                pair: corpus ? corpus.pair : null,
                builtAt: Date.now(),
                counts: counts,
                findings: [],
                features: zeroFeatures(),
                stats: { families: 0, samples: 0, candles: total }
            };
        }

        const families = {};
        function safe(name, fn) {
            try {
                const value = fn();
                families[name] = value || { ok: false, reason: 'EMPTY' };
            } catch (e) {
                families[name] = { ok: false, reason: 'ERROR' };
            }
        }

        safe('dayContext', function () { return buildDayContext(series['1h'], { annotate: opts.annotate === true }); });
        safe('hourProfile', function () { return hourProfile(series['1h']); });
        safe('minuteProfile', function () { return minuteProfile(series['5m']); });
        safe('motif', function () { return motifProfile(series['5m']); });

        const analogRuns = [];
        if (series['1h'].length >= 400) {
            analogRuns.push({
                tf: '1h', series: series['1h'], window: 12, horizons: [12, 36],
                label: '1 jam', windowLabel: '12 jam'
            });
        }
        if (series['15m'].length >= 400) {
            analogRuns.push({
                tf: '15m', series: series['15m'], window: 16, horizons: [8, 16],
                label: '15 menit', windowLabel: '4 jam'
            });
        }
        if (analogRuns.length === 0 && series['5m'].length >= 400) {
            analogRuns.push({ tf: '5m', series: series['5m'], window: 24, horizons: [12, 36], label: '5 menit', windowLabel: '2 jam' });
        }
        const analogs = analogRuns.map(function (run) {
            let result;
            try {
                result = analogSearch(run.series, { window: run.window, horizons: run.horizons });
            } catch (e) {
                result = { ok: false, reason: 'ERROR' };
            }
            return { tf: run.tf, label: run.label, windowLabel: run.windowLabel, horizons: run.horizons, result: result };
        });
        families.analogs = analogs;

        const analogBiases = analogs.filter(function (a) { return a.result && a.result.ok; })
            .map(function (a) { return a.result.bias; });
        const analogWeights = analogs.filter(function (a) { return a.result && a.result.ok; })
            .map(function (a) { return 0.6 + 0.4 * (a.result.strength || 0); });
        const analogBias = blend(analogBiases, analogWeights);
        const analogAgreement = agreement(analogBiases);

        const familyBiases = [
            families.hourProfile && families.hourProfile.ok ? families.hourProfile.bias : NaN,
            families.minuteProfile && families.minuteProfile.ok ? families.minuteProfile.bias : NaN,
            families.dayContext && families.dayContext.ok ? families.dayContext.bias : NaN,
            families.motif && families.motif.ok ? families.motif.bias : NaN,
            analogBiases.length > 0 ? analogBias : NaN
        ];
        const validBiases = familyBiases.filter(function (b) { return Number.isFinite(b); });
        const alignment = validBiases.length > 0 ? clamp11(mean(validBiases) * 0.5 + (agreement(validBiases) * Math.sign(mean(validBiases)) * 0.5)) : 0;

        let sampleTotal = 0;
        const familyCount = [];
        Object.keys(families).forEach(function (name) {
            const fam = families[name];
            if (name === 'analogs') {
                analogs.forEach(function (a) {
                    if (a.result && a.result.ok) { sampleTotal += a.result.samples; familyCount.push(name + ':' + a.tf); }
                });
                return;
            }
            if (fam && fam.ok) { sampleTotal += fam.samples; familyCount.push(name); }
        });

        const sampleConfidence = clamp(sampleTotal / 240, 0, 1);
        const features = {
            patAnalogBias: clamp11(analogBias),
            patAnalogEdge: clamp11(analogAgreement * (0.5 + 0.5 * sampleConfidence)),
            patHourBias: families.hourProfile && families.hourProfile.ok ? clamp11(families.hourProfile.bias) : 0,
            patMinuteBias: families.minuteProfile && families.minuteProfile.ok ? clamp11(families.minuteProfile.bias) : 0,
            patDayBias: families.dayContext && families.dayContext.ok ? clamp11(families.dayContext.bias) : 0,
            patMotifBias: families.motif && families.motif.ok ? clamp11(families.motif.bias) : 0,
            patSamples: sampleConfidence,
            patAlignment: alignment
        };

        const findings = buildFindings(families, { counts: counts });
        const analysis = {
            ok: true,
            pair: corpus ? corpus.pair : null,
            builtAt: Date.now(),
            partial: !!(corpus && corpus.partial),
            counts: counts,
            families: families,
            findings: findings,
            features: features,
            stats: {
                families: familyCount.length,
                familyIds: familyCount,
                samples: sampleTotal,
                candles: total,
                analogAgreement: analogAgreement,
                horizons: { hour: HOUR_HORIZON, minute: MINUTE_HORIZON, day: DAY_HORIZONS, motif: MOTIF_HORIZON }
            }
        };
        return analysis;
    }

    function zeroFeatures() {
        return {
            patAnalogBias: 0,
            patAnalogEdge: 0,
            patHourBias: 0,
            patMinuteBias: 0,
            patDayBias: 0,
            patMotifBias: 0,
            patSamples: 0,
            patAlignment: 0
        };
    }

    return {
        SERIES_CAP: SERIES_CAP,
        MIN_FAMILY_SAMPLES: MIN_FAMILY_SAMPLES,
        MOTIF_MIN_SAMPLES: MOTIF_MIN_SAMPLES,
        INTERVAL_SECONDS: INTERVAL_SECONDS,
        moveBucket: moveBucket,
        hourBand: hourBand,
        zShape: zShape,
        hourProfile: hourProfile,
        minuteProfile: minuteProfile,
        buildDayContext: buildDayContext,
        analogSearch: analogSearch,
        motifProfile: motifProfile,
        statusLabel: statusLabel,
        zeroFeatures: zeroFeatures,
        build: build
    };
});
