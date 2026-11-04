/* ----------------------------------------------------------------------
 * Chart render window.
 *
 * `AppState.candles` is the ENGINE history (wide context for indicators and
 * the animal neural system). The chart series only ever holds the most recent
 * `AppState.chartWindow` candles, which keeps panning cheap. Scrolling left
 * grows the window from data that is already in memory, so it is instant and
 * needs no indicator recomputation.
 * -------------------------------------------------------------------- */
const CHART_RENDER_WINDOW = 1500;
const CHART_WINDOW_STEP = 600;
const CHART_WINDOW_MIN = 200;
const HISTORY_TRIGGER_BARS = 60;

function getChartWindowCount() {
    const requested = Number(AppState.chartWindow);
    const w = Number.isFinite(requested) && requested > 0 ? requested : CHART_RENDER_WINDOW;
    return Math.max(CHART_WINDOW_MIN, Math.floor(w));
}

function getChartWindowStart() {
    const n = AppState.candles.length;
    return Math.max(0, n - Math.min(n, getChartWindowCount()));
}

function getChartCandles() {
    const start = getChartWindowStart();
    return start === 0 ? AppState.candles : AppState.candles.slice(start);
}

function getChartIndicatorSeries(key) {
    const arr = AppState.indicators ? AppState.indicators[key] : null;
    if (!Array.isArray(arr) || arr.length === 0) return [];
    // Indicator points are meaningless without candles to sit on. Guarding here
    // keeps the overlay aligned with the candle window even if the two arrays
    // are momentarily out of sync.
    if (!AppState.candles || AppState.candles.length === 0) return [];
    const start = Math.max(0, arr.length - Math.min(arr.length, getChartWindowCount()));
    return start === 0 ? arr : arr.slice(start);
}

/**
 * Grow the rendered window by `extra` candles using history already in
 * memory. Returns how many candles were actually added (0 = nothing to add).
 */
function extendChartWindow(extra) {
    const step = Number.isFinite(extra) && extra > 0 ? Math.floor(extra) : CHART_WINDOW_STEP;
    const total = AppState.candles.length;
    const current = getChartWindowCount();
    const next = Math.min(total, current + step);
    if (next <= current) return 0;
    AppState.chartWindow = next;
    return next - current;
}

/** Back to the default window (used on pair/timeframe change). */
function resetChartWindow() {
    AppState.chartWindow = CHART_RENDER_WINDOW;
}

if (typeof window !== 'undefined') {
    window.getChartCandles = getChartCandles;
    window.getChartIndicatorSeries = getChartIndicatorSeries;
    window.extendChartWindow = extendChartWindow;
    window.resetChartWindow = resetChartWindow;
    window.CHART_RENDER_WINDOW = CHART_RENDER_WINDOW;
    window.CHART_WINDOW_STEP = CHART_WINDOW_STEP;
    window.CHART_WINDOW_MIN = CHART_WINDOW_MIN;
}

const PolyLineManager = {
    lines: {},
    draw(p) { 
        if (!series || !series.candle) return; 
        if (!this.lines[p.id]) { 
            this.lines[p.id] = series.candle.createPriceLine({ 
                price: p.startPrice, 
                color: p.direction === 'LONG' ? '#4ade80' : '#f87171', 
                lineWidth: 2, 
                lineStyle: 0, 
                axisLabelVisible: true, 
                title: `Poly ${p.direction.charAt(0)}` 
            }); 
        } 
    },
    update(p, currentPrice) { 
        let line = this.lines[p.id]; 
        if (!line) return; 
        let isWin = (p.direction === 'LONG' && currentPrice >= p.startPrice) || (p.direction === 'SHORT' && currentPrice <= p.startPrice); 
        line.applyOptions({ 
            title: `Poly ${p.direction.charAt(0)} | ${isWin ? 'WIN' : 'LOSS'}`, 
            color: isWin ? '#4ade80' : '#ef4444' 
        }); 
    },
    remove(id) { 
        if (this.lines[id] && series.candle) { 
            try { series.candle.removePriceLine(this.lines[id]); } catch(e) { console.warn('Chart cleanup warning', e); } 
            delete this.lines[id]; 
        } 
    },
    clear() { 
        for (let id in this.lines) { this.remove(id); } 
        this.lines = {}; 
    }
};

let chart, rsiChart, resizeObserver = null, series = {};
let chartContainerDom = null;
let boundResizeHandler = null;
let boundOrientationHandler = null;
let boundViewportHandler = null;
let candleLookupByTime = new Map();
let rsiLookupByTime = new Map();
let chartRenderQueued = false;
let isUserPanningChart = false;
let resumeAutoFollowTimer = null;
let returnButtonSyncQueued = false;

function safeBadge(className, text) {
    return { tag: 'span', className: `mtf-badge-container ${className}`, text };
}

function safeMetric(className, text) {
    return { tag: 'span', className, text };
}

const queueReturnToLiveButtonSync = () => {
    if (returnButtonSyncQueued) return;
    returnButtonSyncQueued = true;
    requestAnimationFrame(() => {
        returnButtonSyncQueued = false;
        if (typeof syncReturnToLiveButton === 'function') syncReturnToLiveButton();
    });
};

const markManualPan = () => {
    isUserPanningChart = true;
    if (resumeAutoFollowTimer) clearTimeout(resumeAutoFollowTimer);
    resumeAutoFollowTimer = setTimeout(() => {
        isUserPanningChart = false;
    }, 1500);
};

let realtimeFollowQueued = false;
function smoothScrollToRealtime(force = false) {
    if (realtimeFollowQueued || (!force && isUserPanningChart) || !chart || !rsiChart) return;
    realtimeFollowQueued = true;

    const targetPosition = 0;
    const durationMs = force ? 220 : 0;
    const startAt = performance.now();
    const startPosition = chart.timeScale().scrollPosition();

    const step = (now) => {
        const elapsed = now - startAt;
        const progress = durationMs > 0 ? Math.min(1, elapsed / durationMs) : 1;
        const eased = 1 - Math.pow(1 - progress, 3);
        const nextPos = startPosition + ((targetPosition - startPosition) * eased);

        try { chart.timeScale().scrollToPosition(nextPos, false); } catch (e) {}
        try { rsiChart.timeScale().scrollToPosition(nextPos, false); } catch (e) {}

        if (progress < 1) {
            requestAnimationFrame(step);
            return;
        }

        realtimeFollowQueued = false;
        queueReturnToLiveButtonSync();
    };

    requestAnimationFrame(step);
}

function scheduleChartRender(force = false) {
    if (chartRenderQueued && !force) return;
    // Never queue a render when the chart is not ready; the lifecycle boot
    // performs the first render synchronously after historical data lands.
    if (typeof chart === 'undefined' || !chart || !series || !series.candle) return;
    chartRenderQueued = true;
    requestAnimationFrame(() => {
        chartRenderQueued = false;
        if (typeof renderFullChart === 'function') renderFullChart();
    });
}

window.scheduleChartRender = scheduleChartRender;

function applyChartSize() {
    const containerDom = chartContainerDom || (typeof document !== 'undefined' ? document.getElementById('chart-container') : null);
    if (!containerDom) return false;
    let h = containerDom.clientHeight, w = containerDom.clientWidth;
    // Desktop: flex parent kadang melaporkan 0 pada frame pertama (font/layout
    // belum settle) -> pakai viewport sebagai fallback agar chart tetap muncul,
    // bukan stuck loading. Mobile sudah punya height eksplisit via CSS.
    if ((!(w > 0) || !(h > 0)) && typeof window !== 'undefined') {
        const vw = window.innerWidth || 0;
        const vh = window.innerHeight || 0;
        if (!(w > 0) && vw > 0) w = Math.max(320, vw - (vw > 768 ? 360 : 0));
        if (!(h > 0) && vh > 0) h = Math.max(420, Math.floor(vh * 0.62));
    }
    if (!(h > 0) || !(w > 0) || !chart || !rsiChart) return false;
    try {
        chart.applyOptions({ width: w, height: Math.max(h - 140, 100) });
        rsiChart.applyOptions({ width: w, height: 140 });
    } catch (e) {
        return false;
    }
    return true;
}

window.applyChartSize = applyChartSize;

function unbindChartResizeHandlers() {
    try {
        if (boundResizeHandler) window.removeEventListener('resize', boundResizeHandler);
        if (boundOrientationHandler) window.removeEventListener('orientationchange', boundOrientationHandler);
        if (boundViewportHandler && window.visualViewport) window.visualViewport.removeEventListener('resize', boundViewportHandler);
    } catch (e) { /* noop */ }
    boundResizeHandler = null;
    boundOrientationHandler = null;
    boundViewportHandler = null;
}

function disposeChartInstances() {
    if (resizeObserver) { try { resizeObserver.disconnect(); } catch (e) {} resizeObserver = null; }
    unbindChartResizeHandlers();
    if (typeof chart !== 'undefined' && chart) { try { chart.remove(); } catch(e){} chart = null; }
    if (typeof rsiChart !== 'undefined' && rsiChart) { try { rsiChart.remove(); } catch(e){} rsiChart = null; }
    series = {};
}

window.disposeChartInstances = disposeChartInstances;

/**
 * Pastikan LightweightCharts tersedia. Di desktop, adblock/DNS kadang
 * memblokir unpkg sehingga `LightweightCharts` undefined -> chart stuck loading
 * (di mobile lolos karena cache). Fallback ke jsdelivr, lalu ke unpkg versi pin.
 * Mengembalikan Promise<boolean>; resolve false kalau semua CDN gagal.
 */
function ensureLightweightCharts() {
    try {
        if (typeof LightweightCharts !== 'undefined' && LightweightCharts && LightweightCharts.createChart) {
            return Promise.resolve(true);
        }
    } catch (e) { /* lanjut ke fallback */ }
    if (typeof document === 'undefined') return Promise.resolve(false);
    // Jangan inject dua kali.
    if (document.querySelector && document.querySelector('script[data-lwc-fallback]')) {
        return new Promise(function (resolve) {
            var tries = 0;
            var timer = setInterval(function () {
                tries++;
                try {
                    if (typeof LightweightCharts !== 'undefined' && LightweightCharts.createChart) {
                        clearInterval(timer);
                        resolve(true);
                    } else if (tries > 50) {
                        clearInterval(timer);
                        resolve(false);
                    }
                } catch (e) {}
            }, 100);
        });
    }
    var urls = [
        'https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js',
        'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js'
    ];
    return new Promise(function (resolve) {
        var i = 0;
        function next() {
            if (i >= urls.length) { resolve(false); return; }
            var s = document.createElement('script');
            s.src = urls[i++];
            s.async = false;
            if (s.setAttribute) s.setAttribute('data-lwc-fallback', '1');
            s.onload = function () {
                try {
                    if (typeof LightweightCharts !== 'undefined' && LightweightCharts.createChart) resolve(true);
                    else next();
                } catch (e) { next(); }
            };
            s.onerror = next;
            document.head.appendChild(s);
        }
        next();
        // Timeout keras 12 detik: jangan pernah stuck tanpa jawaban.
        setTimeout(function () {
            try {
                if (typeof LightweightCharts !== 'undefined' && LightweightCharts.createChart) resolve(true);
            } catch (e) {}
        }, 12000);
    });
}

if (typeof window !== 'undefined') {
    window.ensureLightweightCharts = ensureLightweightCharts;
}

/**
 * Penyebab kegagalan setupChart terakhir (dibaca lifecycle untuk pesan error
 * + telemetri `pair_fetch_repeated_failure`, supaya log server langsung
 * menyebut LIB_MISSING / CREATE_EXCEPTION:<pesan> bukan kode generik).
 */
var lastChartCreateError = null;

function setLastChartCreateError(code) {
    if (code === null || code === undefined || code === '') {
        lastChartCreateError = null;
        try {
            if (typeof window !== 'undefined') window.__MASAKO_CHART_CREATE_ERROR__ = null;
        } catch (e) { /* noop */ }
        return null;
    }
    lastChartCreateError = String(code).slice(0, 160);
    try {
        if (typeof window !== 'undefined') window.__MASAKO_CHART_CREATE_ERROR__ = lastChartCreateError;
    } catch (e) { /* noop */ }
    return lastChartCreateError;
}

function getLastChartCreateError() {
    try {
        if (typeof window !== 'undefined' && window.__MASAKO_CHART_CREATE_ERROR__) {
            return String(window.__MASAKO_CHART_CREATE_ERROR__).slice(0, 160);
        }
    } catch (e) { /* noop */ }
    return lastChartCreateError;
}

if (typeof window !== 'undefined') {
    window.getLastChartCreateError = getLastChartCreateError;
}

function setupChart() {
    try {
        if (typeof LightweightCharts === 'undefined') {
            setLastChartCreateError('LIB_MISSING_CDN_BLOCKED');
            // Coba fallback CDN secara async; lifecycle akan retry setelah load.
            try {
                if (typeof ensureLightweightCharts === 'function') {
                    ensureLightweightCharts().then(function (ok) {
                        if (ok && window.ChartLifecycle && typeof window.ChartLifecycle.retryNow === 'function') {
                            var st = window.ChartLifecycle.getState();
                            if (!st || st.phase !== 'LIVE') window.ChartLifecycle.retryNow();
                        }
                    });
                }
            } catch (e) {}
            return false;
        }
        if (!LightweightCharts.createChart) {
            setLastChartCreateError('LIB_NO_CREATE_FN');
            return false;
        }
        const mainChartDom = typeof document !== 'undefined' ? document.getElementById('main-chart') : null;
        const rsiChartDom = typeof document !== 'undefined' ? document.getElementById('rsi-chart') : null;
        const containerDom = typeof document !== 'undefined' ? document.getElementById('chart-container') : null;
        if (!mainChartDom || !rsiChartDom || !containerDom) {
            setLastChartCreateError('NODES_MISSING');
            return false;
        }

        // Safety: never leak a previous instance if teardown was skipped.
        disposeChartInstances();
        chartContainerDom = containerDom;

        let h = containerDom.clientHeight;
        let w = containerDom.clientWidth;

        if (w === 0) w = window.innerWidth || 800;
        if (h === 0) h = window.innerHeight ? window.innerHeight * 0.6 : 400;

    chart = LightweightCharts.createChart(mainChartDom, {
        width: w, 
        height: Math.max(h - 140, 100), 
        layout: { background: { type: 'solid', color: '#000000' }, textColor: '#a1a1aa', fontSize: 11 },
        grid: { vertLines: { color: 'rgba(39, 39, 42, 0.2)' }, horzLines: { color: 'rgba(39, 39, 42, 0.2)' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal }, 
        rightPriceScale: { borderColor: '#27272a', autoScale: true, scaleMargins: { top: 0.1, bottom: 0.2 } }, 
        timeScale: { borderColor: '#27272a', timeVisible: true, rightOffset: 8, minBarSpacing: 2 },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, kineticScroll: { touch: true, mouse: true } },
        handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true }
    });
    
    series.vol = chart.addHistogramSeries({ color: 'rgba(38, 166, 154, 0.5)', priceFormat: { type: 'volume' }, priceScaleId: 'volume_scale' });
    chart.priceScale('volume_scale').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    series.candle = chart.addCandlestickSeries({ 
        upColor: '#000000', downColor: '#ffffff', borderUpColor: '#ffffff', borderDownColor: '#ffffff', wickUpColor: '#ffffff', wickDownColor: '#ffffff',
        priceFormat: { type: 'custom', minMove: 0.00000001, formatter: (price) => formatPrice(price) } 
    });
    
    rsiChart = LightweightCharts.createChart(rsiChartDom, {
        width: w, height: 140, 
        layout: { background: { type: 'solid', color: '#000000' }, textColor: '#71717a', fontSize:10 },
        grid: { vertLines: { color: 'rgba(39, 39, 42, 0.5)' }, horzLines: { color: 'rgba(39, 39, 42, 0.5)' } }, 
        rightPriceScale: { borderColor: '#27272a', autoScale: true, entireTextOnly: false }, 
        timeScale: { visible: false, rightOffset: 8, minBarSpacing: 2 },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false, kineticScroll: { touch: true, mouse: true } },
        handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true }
    });
    
    series.rsi = rsiChart.addLineSeries({ color: '#00e5ff', lineWidth: 2, crosshairMarkerVisible: false, priceLineVisible: false });
    series.stochK = rsiChart.addLineSeries({ color: '#ffff00', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false });
    series.stochD = rsiChart.addLineSeries({ color: '#d500f9', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false });
    series.wr = rsiChart.addLineSeries({ color: '#ff1744', lineWidth: 1, crosshairMarkerVisible: false, priceLineVisible: false });
    
    series.rsi.createPriceLine({ price: 70, color: 'rgba(239, 68, 68, 0.5)', lineWidth: 1, lineStyle: 2 });
    series.rsi.createPriceLine({ price: 30, color: 'rgba(34, 197, 94, 0.5)', lineWidth: 1, lineStyle: 2 });
    series.wr.createPriceLine({ price: -20, color: 'rgba(239, 68, 68, 0.2)', lineWidth: 1, lineStyle: 2 });
    series.wr.createPriceLine({ price: -80, color: 'rgba(34, 197, 94, 0.2)', lineWidth: 1, lineStyle: 2 });
    
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => { 
        markManualPan();
        queueReturnToLiveButtonSync();
        if (AppState.syncingScales) return;
        AppState.syncingScales = true;
        rsiChart.timeScale().setVisibleLogicalRange(range);
        AppState.syncingScales = false;
    });
    
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(range => { 
        markManualPan();
        queueReturnToLiveButtonSync();
        if (AppState.syncingScales) return;
        AppState.syncingScales = true;
        chart.timeScale().setVisibleLogicalRange(range);
        AppState.syncingScales = false;
    });
    
    // Left-edge handler: extend the rendered window from history that is
    // already in memory first (instant, no recompute, no layout jump), and
    // only ask the exchange for more pages once that is exhausted.
    chart.timeScale().subscribeVisibleLogicalRangeChange((newRange) => {
        if (!newRange || !Number.isFinite(newRange.from) || newRange.from >= HISTORY_TRIGGER_BARS) return;
        const added = extendChartWindow(CHART_WINDOW_STEP);
        if (added > 0) {
            renderChartWindow({ preserveRange: true, addedBars: added });
            return;
        }
        if (typeof requestMoreHistory === 'function') requestMoreHistory();
    });

    chart.subscribeCrosshairMove(param => {
        if (param.time === undefined || param.point.x < 0 || param.point.x > mainChartDom.clientWidth || param.point.y < 0 || param.point.y > mainChartDom.clientHeight) {
            rsiChart.clearCrosshairPosition();
        } else {
            const rsiValue = rsiLookupByTime.get(param.time) || 50;
            rsiChart.setCrosshairPosition(rsiValue, param.time, series.rsi);
        }
    });

    rsiChart.subscribeCrosshairMove(param => {
        if (param.time === undefined || param.point.x < 0 || param.point.x > rsiChartDom.clientWidth || param.point.y < 0 || param.point.y > rsiChartDom.clientHeight) {
            chart.clearCrosshairPosition();
        } else {
            const cData = candleLookupByTime.get(param.time);
            if (cData) chart.setCrosshairPosition(cData.close, param.time, series.candle);
        }
    });


    resizeObserver = new ResizeObserver(entries => {
        if (entries.length === 0 || entries[0].target !== containerDom) return;
        applyChartSize();
    });
    resizeObserver.observe(containerDom);

        boundResizeHandler = () => requestAnimationFrame(applyChartSize);
        boundOrientationHandler = () => {
            setTimeout(() => requestAnimationFrame(applyChartSize), 100);
        };
        window.addEventListener('resize', boundResizeHandler, { passive: true });
        window.addEventListener('orientationchange', boundOrientationHandler, { passive: true });
        if (window.visualViewport) {
            boundViewportHandler = () => requestAnimationFrame(applyChartSize);
            window.visualViewport.addEventListener('resize', boundViewportHandler, { passive: true });
        }

        if (!series.candle || !series.vol || !series.rsi) {
            setLastChartCreateError('SERIES_INCOMPLETE');
            disposeChartInstances();
            return false;
        }
        setLastChartCreateError(null);
        return true;
    } catch (e) {
        var detail = (e && (e.message || e.name)) ? String(e.name ? e.name + ': ' : '') + String(e.message || e) : String(e);
        setLastChartCreateError('CREATE_EXCEPTION:' + detail);
        console.error('setupChart failed', e);
        try { disposeChartInstances(); } catch (cleanupErr) { /* noop */ }
        return false;
    }
}

function rebuildCandleLookup(candles) {
    candleLookupByTime = new Map(candles.map(c => [c.time, c]));
}

// Binary search: last swing strictly before `time` (swings are chronological).
function lastSwingBefore(list, time) {
    if (!Array.isArray(list) || list.length === 0) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].time < time) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return found >= 0 ? list[found] : null;
}

/**
 * Push the rendered window into the series.
 * `data` is the window slice; `windowStart` is its absolute index inside
 * `AppState.candles` so parallel arrays (volSMA/atrSMA) stay aligned.
 */
function pushChartData(data, windowStart) {
    const volData = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        volData[i] = {
            time: c.time,
            value: c.vol,
            color: c.close >= c.open ? 'rgba(74, 222, 128, 0.3)' : 'rgba(248, 113, 113, 0.3)'
        };
    }
    if (series.candle) series.candle.setData(data);
    if (series.vol) series.vol.setData(volData);

    const rsi = getChartIndicatorSeries('rsi');
    if (rsi.length > 0) {
        if (series.rsi) series.rsi.setData(rsi);
        const stochK = getChartIndicatorSeries('stochK');
        const stochD = getChartIndicatorSeries('stochD');
        const wr = getChartIndicatorSeries('wr');
        if (series.stochK && stochK.length > 0) series.stochK.setData(stochK);
        if (series.stochD && stochD.length > 0) series.stochD.setData(stochD);
        if (series.wr && wr.length > 0) series.wr.setData(wr);
    }
    return windowStart;
}

function buildChartMarkers(data, windowStart) {
    AppState.markers = [];
    if (data.length === 0) return [];

    // Confirmed AI signals use a moon glyph. Add them before the other marker
    // types so their distinct moon shape wins when two annotations share a bar.
    const moonIndicator = typeof window !== 'undefined' ? window.MoonSignalIndicator : null;
    if (moonIndicator && typeof moonIndicator.getMarkers === 'function') {
        moonIndicator.getMarkers(AppState.g_pair).forEach((marker) => AppState.markers.push(marker));
    }

    const scanFrom = Math.max(11, data.length - 50);
    let lastBullBOS = null;
    let lastBearBOS = null;

    for (let i = scanFrom; i < data.length - 1; i++) {
        const c = data[i];
        const isUp = c.close >= c.open;
        const volAvg = AppState.volSMA[windowStart + i] || 1;
        if (c.vol <= volAvg * 1.5) continue;
        const rH = lastSwingBefore(AppState.swings.highs, c.time);
        const rL = lastSwingBefore(AppState.swings.lows, c.time);
        if (rH && c.close > rH.val && isUp) {
            lastBullBOS = { time: c.time, position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'BOS Bull' };
        }
        if (rL && c.close < rL.val && !isUp) {
            lastBearBOS = { time: c.time, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'BOS Bear' };
        }
    }

    if (lastBullBOS) AppState.markers.push(lastBullBOS);
    if (lastBearBOS) AppState.markers.push(lastBearBOS);

    const highs = AppState.swings.highs;
    const lows = AppState.swings.lows;
    if (highs.length > 0) {
        AppState.markers.push({ time: highs[highs.length - 1].time, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'Res' });
    }
    if (lows.length > 0) {
        AppState.markers.push({ time: lows[lows.length - 1].time, position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: 'Sup' });
    }

    if (Array.isArray(AppState.aiSignalMarkers)) {
        AppState.aiSignalMarkers.forEach((m) => {
            if (m && m.pair === AppState.g_pair) AppState.markers.push(m);
        });
    }

    // Group markers that share a time+position and drop anything outside the
    // rendered window (lightweight-charts ignores them anyway, but sorting
    // thousands of stale markers on every render is wasted work).
    const firstTime = data[0].time;
    const lastTime = data[data.length - 1].time;
    const grouped = new Map();
    for (let i = 0; i < AppState.markers.length; i++) {
        const m = AppState.markers[i];
        if (!m || !Number.isFinite(m.time) || m.time < firstTime || m.time > lastTime) continue;
        const key = m.time + '_' + m.position;
        const existing = grouped.get(key);
        if (existing) {
            if (!existing.text.includes(m.text)) existing.text += ' | ' + m.text;
        } else {
            grouped.set(key, Object.assign({}, m));
        }
    }
    return Array.from(grouped.values()).sort((a, b) => a.time - b.time);
}

/**
 * Render the current chart window.
 * opts.preserveRange keeps the visible logical range stable when candles are
 * prepended, so scrolling left never jumps.
 */
function renderChartWindow(opts = {}) {
    try {
        if (typeof chart === 'undefined' || !chart || !rsiChart) return false;
        if (!series || !series.candle || !series.vol || !series.rsi) return false;
        if (typeof AppState === 'undefined' || !AppState.candles || AppState.candles.length === 0) return false;

        const windowStart = getChartWindowStart();
        const data = getChartCandles();
        if (data.length === 0) return false;

        let previousRange = null;
        if (opts.preserveRange) {
            try {
                const r = chart.timeScale().getVisibleLogicalRange();
                if (r && Number.isFinite(r.from) && Number.isFinite(r.to)) previousRange = r;
            } catch (e) { /* noop */ }
        }

        pushChartData(data, windowStart);
        if (series.candle) series.candle.setMarkers(buildChartMarkers(data, windowStart));

        if (previousRange) {
            const shift = Number.isFinite(opts.addedBars) ? opts.addedBars : 0;
            try {
                chart.timeScale().setVisibleLogicalRange({
                    from: previousRange.from + shift,
                    to: previousRange.to + shift
                });
            } catch (e) { /* non-fatal */ }
        }
        return true;
    } catch (e) {
        console.error('renderChartWindow failed', e);
        return false;
    }
}

window.renderChartWindow = renderChartWindow;

function renderFullChart() {
    try {
        if (typeof chart === 'undefined' || !chart || !rsiChart) return false;
        if (!series || !series.candle || !series.vol || !series.rsi) return false;
        if (typeof AppState === 'undefined' || !AppState.candles || AppState.candles.length === 0) return false;
        if (!AppState.indicators || !AppState.indicators.e200) return false;
        if (AppState.indicators.e200.length !== AppState.candles.length) {
            if (typeof calculateAllIndicators === 'function') calculateAllIndicators();
            else return false;
        }

        rebuildCandleLookup(AppState.candles);
        if (!renderChartWindow()) return false;

        // Analysis always runs on the FULL engine history (the last index is
        // identical), so widening the context improves the signal for free.
        if (typeof IntelligenceEngine !== 'undefined' && IntelligenceEngine && typeof IntelligenceEngine.analyze === 'function') {
            const res = IntelligenceEngine.analyze(AppState.candles.length - 1);
            if (typeof applyUIVisuals === 'function') applyUIVisuals(res);
        }

        try {
            if (typeof polymarketLog !== 'undefined' && Array.isArray(polymarketLog)) {
                polymarketLog.filter(p => p.status === 'PENDING' && p.pair === AppState.g_pair).forEach(p => PolyLineManager.draw(p));
            }
        } catch (e) { /* overlay best-effort */ }
        try {
            if (typeof FuturesEngine !== 'undefined' && FuturesEngine && typeof FuturesEngine.drawChartLines === 'function') {
                FuturesEngine.drawChartLines();
            }
        } catch (e) { /* overlay best-effort */ }
        return true;
    } catch (e) {
        console.error('renderFullChart failed', e);
        return false;
    }
}

function applyUIVisuals(res) {
    let sC = "signal-hold"; 
    if (res.signal === "STRONG BUY") sC = "signal-buy"; 
    else if (res.signal === "STRONG SELL") sC = "signal-sell";
    
    setSafeText('signal', res.signal); 
    const sigEl = document.getElementById('signal'); 
    if (sigEl) sigEl.className = `value-large ${sC}`;
    
    setSafeText('confidence', res.prob > 0 ? res.prob.toFixed(1) + "%" : "0%"); 
    setSafeText('reasoning', `[Model: ${res.dominantStrategy}] ` + res.insightArr.join(" + "));
    setSafeText('badge-regime', res.regime); 
    setSafeText('badge-vol', `Vol: ${res.volRegime}`); 
    setSafeText('badge-liq', `Liq: ${AppState.marketState.liquidity}`); 
    
    const rBadge = document.getElementById('badge-risk');
    if (rBadge) { 
        rBadge.textContent = "RISK: " + res.risk; 
        rBadge.classList.remove('badge-risk-low', 'badge-risk-high', 'badge-risk-med');
        rBadge.classList.add(res.risk === "LOW" ? 'badge-risk-low' : (res.risk === "HIGH" ? 'badge-risk-high' : 'badge-risk-med')); 
    }

    const data = AppState.candles;
    const ind = AppState.indicators;
    
    if (data.length > 0) {
        const lIdx = data.length-1; 
        setSafeText('price', formatPrice(data[lIdx].close));
        
        if (ind.st[lIdx]) setSafeText('st-status', ind.st[lIdx].trend === 1 ? safeBadge('mtf-up-box', 'UPTREND') : safeBadge('mtf-dn-box', 'DOWNTREND'), undefined, 'nodes');
        if (ind.macd[lIdx]) {
            let mVal = ind.macd[lIdx].value; 
            setSafeText('macd-val', mVal > 0 ? safeBadge('mtf-up-box', 'BULLISH') : safeBadge('mtf-dn-box', 'BEARISH'), undefined, 'nodes');
        }
        if (ind.e200[lIdx]) setSafeText('vwap-status', data[lIdx].close > ind.e200[lIdx].value ? safeBadge('mtf-up-box', 'ABOVE') : safeBadge('mtf-dn-box', 'BELOW'), undefined, 'nodes');
        if (ind.rsi[lIdx] && ind.rsi21[lIdx]) setSafeText('rsi-val', [safeMetric('metric-cyan', ind.rsi[lIdx].value.toFixed(1)), ' / ', safeMetric('metric-gray', ind.rsi21[lIdx].value.toFixed(1))], undefined, 'nodes');
        if (ind.stochK[lIdx] && ind.stochD[lIdx]) setSafeText('stoch-val', [safeMetric('metric-yellow', ind.stochK[lIdx].value.toFixed(1)), ' / ', safeMetric('metric-magenta', ind.stochD[lIdx].value.toFixed(1))], undefined, 'nodes');
        if (ind.wr[lIdx]) setSafeText('wr-val', safeMetric('metric-red', ind.wr[lIdx].value.toFixed(1)), undefined, 'nodes');

        if (AppState.candles.length > 5) {
            let cVolAvg = AppState.volSMA[lIdx] || 0, pVolAvg = AppState.volSMA[lIdx - 5] || 0;
            if (cVolAvg > pVolAvg * 1.05) setSafeText('vol-trend-val', safeBadge('mtf-up-box', 'UPTREND'), undefined, 'nodes');
            else if (cVolAvg < pVolAvg * 0.95) setSafeText('vol-trend-val', safeBadge('mtf-dn-box', 'DOWNTREND'), undefined, 'nodes');
            else setSafeText('vol-trend-val', safeBadge('mtf-neutral-box', 'SIDEWAYS'), undefined, 'nodes');
        }

        if(ind.cvd[lIdx] && ind.obv[lIdx]) setSafeText('cvd-obv-val', `${formatNum(ind.cvd[lIdx].value)} / ${formatNum(ind.obv[lIdx].value)}`);
        if(ind.mfi[lIdx] && ind.volosc[lIdx]) setSafeText('mfi-volosc-val', `${ind.mfi[lIdx].value.toFixed(1)} / ${ind.volosc[lIdx].value.toFixed(1)}`);
        if(ind.bb[lIdx]) setSafeText('bb-val', `${formatPrice(ind.bb[lIdx].lower)} | ${formatPrice(ind.bb[lIdx].upper)}`);
        if(ind.ichimoku[lIdx]) setSafeText('ichi-val', `${formatPrice(ind.ichimoku[lIdx].tenkan)} / ${formatPrice(ind.ichimoku[lIdx].kijun)}`);
        if(ind.poc[lIdx] && ind.psar[lIdx]) setSafeText('poc-psar-val', `${formatPrice(ind.poc[lIdx].value)} / ${formatPrice(ind.psar[lIdx].value)}`);
        if(ind.linreg[lIdx]) setSafeText('linreg-val', `${formatPrice(ind.linreg[lIdx].value)} (S: ${ind.linreg[lIdx].slope.toFixed(4)})`);
    }

    if (res.fData) {
        let sVol = Math.min(1, data[data.length-1].vol / (AppState.volSMA[data.length-1] || 1));
        let dev = (res.fData.retail - 0.5) * sVol; 
        
        setSafeText('rs-val', `${((0.5+dev) * 100).toFixed(1)}% R / ${((0.5-dev) * 100).toFixed(1)}% S`);
        setSafeText('fo-val', `${(res.fData.funding * 100).toFixed(4)}% | ${formatNum(res.fData.oi)}`);
        setSafeText('cf-val', Math.abs(dev*2).toFixed(4));
        setSafeText('taker-val', `${(res.fData.takerRatio || 0).toFixed(2)}`);
        setSafeText('ls-acc-val', `${(res.fData.retail || 0).toFixed(2)}`);
        setSafeText('ls-ratio-val', `${(res.fData.lsRatio || 0).toFixed(2)}`);
        setSafeText('ls-pos-val', `${(res.fData.smart || 0).toFixed(2)}`);
        setSafeText('bs-vol-val', `${(res.fData.takerRatio || 0).toFixed(2)}`);
        
        let dNode = res.fData.dominance === "LONG" ? safeBadge('mtf-up-box', 'LONG') : (res.fData.dominance === "SHORT" ? safeBadge('mtf-dn-box', 'SHORT') : safeBadge('mtf-neutral-box', 'NEUTRAL'));
        setSafeText('dom-ls-val', dNode, undefined, 'nodes');
        
        let basis = res.fData.markPrice > 0 ? (res.fData.markPrice - AppState.price).toFixed(2) : 0;
        setSafeText('oi-basis-val', `${formatNum(res.fData.oi)} / ${basis}`);
    }

    const scoreBar = document.getElementById('score-bar');
    if (scoreBar && Math.abs(res.score) > 10) {
        scoreBar.classList.remove('is-hidden');
        let totalScore = Math.abs(AI_STATS.trend.w) + Math.abs(AI_STATS.liquidity.w) + Math.abs(AI_STATS.whale.w);
        if (totalScore > 0) {
            document.getElementById('sb-trend').style.width = `${(Math.abs(AI_STATS.trend.w) / totalScore) * 100}%`;
            document.getElementById('sb-liq').style.width = `${(Math.abs(AI_STATS.liquidity.w) / totalScore) * 100}%`;
            document.getElementById('sb-whale').style.width = `${(Math.abs(AI_STATS.whale.w) / totalScore) * 100}%`;
        }
    } else if (scoreBar) { 
        scoreBar.classList.add('is-hidden'); 
    }
}
