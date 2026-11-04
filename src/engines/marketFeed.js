
class TickCandleAggregator {
    constructor(intervalMs = 60_000, tf = null) {
        this.intervalMs = intervalMs;
        this.tf = tf;
        this.current = null;
    }

    bucketStart(tsMs) {
        if (this.tf && typeof MarketFeedManager !== 'undefined' && typeof MarketFeedManager.bucketStartMs === 'function') {
            return MarketFeedManager.bucketStartMs(this.tf, tsMs);
        }
        return Math.floor(tsMs / this.intervalMs) * this.intervalMs;
    }

    setIntervalMs(intervalMs) {
        this.intervalMs = Math.max(1000, intervalMs || 60_000);
    }

    reset() {
        this.current = null;
    }

    seed(lastCandle) {
        if (!lastCandle) return;
        this.current = {
            time: lastCandle.time,
            open: lastCandle.open,
            high: lastCandle.high,
            low: lastCandle.low,
            close: lastCandle.close,
            vol: Number(lastCandle.vol) || 0,
            takerVol: Number(lastCandle.takerVol) || 0,
            _bucketStart: this.bucketStart(lastCandle.time * 1000)
        };
    }

    ingest(tick) {
        if (!tick || !Number.isFinite(tick.price) || !Number.isFinite(tick.tsMs)) return null;

        const bucketStart = this.bucketStart(tick.tsMs);
        const bucketTime = bucketStart / 1000;
        const qty = Number.isFinite(tick.qty) && tick.qty > 0 ? tick.qty : 0;
        const takerBuyQty = Number.isFinite(tick.takerBuyQty) && tick.takerBuyQty > 0 ? tick.takerBuyQty : 0;

        if (!this.current) {
            this.current = {
                time: bucketTime,
                open: tick.price,
                high: tick.price,
                low: tick.price,
                close: tick.price,
                vol: qty,
                takerVol: takerBuyQty,
                _bucketStart: bucketStart
            };
            return { candle: { ...this.current }, isClosed: false };
        }

        if (bucketStart < this.current._bucketStart) {
            return null;
        }

        if (bucketStart > this.current._bucketStart) {
            this.current = {
                time: bucketTime,
                open: tick.price,
                high: tick.price,
                low: tick.price,
                close: tick.price,
                vol: qty,
                takerVol: takerBuyQty,
                _bucketStart: bucketStart
            };
            return { candle: { ...this.current }, isClosed: true };
        }

        this.current.high = Math.max(this.current.high, tick.price);
        this.current.low = Math.min(this.current.low, tick.price);
        this.current.close = tick.price;
        this.current.vol += qty;
        this.current.takerVol += takerBuyQty;

        return { candle: { ...this.current }, isClosed: false };
    }
}

class MarketFeedManager {
    constructor() {
        this.sources = {
            BINANCE: {
                name: 'BINANCE',
                label: 'Binance',
                urlFor: (pair, tf) => `wss://fstream.binance.com/market/ws/${pair.toLowerCase()}@aggTrade`,
                socket: null,
                reconnectTimer: null,
                reconnectDelay: 1000,
                heartbeatTimer: null,
                lastPingAt: 0,
                lastPongAt: 0,
                pingRttMs: Infinity,
                ready: false,
                lastReceiveMs: 0,
                lastServerTs: 0,
                lastPrice: 0,
                latencyMs: Infinity,
                samples: 0,
                staleCount: 0,
                status: 'DISCONNECTED'
            },
            BYBIT: {
                name: 'BYBIT',
                label: 'Bybit',
                urlFor: () => `wss://stream.bybit.com/v5/public/linear`,
                socket: null,
                reconnectTimer: null,
                reconnectDelay: 1000,
                ready: false,
                lastReceiveMs: 0,
                lastServerTs: 0,
                lastPrice: 0,
                latencyMs: Infinity,
                samples: 0,
                staleCount: 0,
                status: 'DISCONNECTED',
                pingTimer: null
            },
            // VISION: REST poller ke mirror anti-blokir (bukan WebSocket).
            // Hanya aktif saat KEDUA WebSocket mati (mis. ISP memblokir
            // *.binance.com + *.bybit.com di DNS). Cadence 10 detik.
            VISION: {
                name: 'VISION',
                label: 'Vision REST',
                urlFor: (pair, tf) => `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${tf === '1y' ? '1M' : tf}&limit=5`,
                socket: null,
                reconnectTimer: null,
                reconnectDelay: 1000,
                ready: false,
                lastReceiveMs: 0,
                lastServerTs: 0,
                lastPrice: 0,
                latencyMs: Infinity,
                samples: 0,
                staleCount: 0,
                status: 'DISCONNECTED',
                pingTimer: null
            }
        };
        this._visionTimer = null;
        this._visionPollMs = 10000;
        this._visionPolling = false;
        this.pair = null;
        this.tf = '15m';
        this.activeSource = 'BINANCE';
        this.lockedSource = 'BINANCE';
        this.booted = false;
        this.aggregator = new TickCandleAggregator(15 * 60 * 1000);
        this._switchHistory = [];
        this._healthTimer = null;
        this._session = 0;
        this.callbacks = {
            onTick: null,
            onStatus: null
        };
    }

    static tfToMs(tf) {
        const map = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000, '1y': 31_536_000_000 };
        return map[tf] || 900_000;
    }

    /**
     * Awal bucket candle untuk timestamp (UTC). Untuk 1d ke bawah, bucket
     * epoch == bucket kalender. Untuk 1w/1M/1y harus kalender eksplisit:
     * minggu exchange mulai Senin, bulan mulai tanggal 1, tahun mulai
     * 1 Jan (bucket epoch akan meleset — minggu epoch mulai Kamis, dan
     * "bulan 30 hari" akan drift terhadap kalender nyata).
     */
    static bucketStartMs(tf, tsMs) {
        const d = new Date(tsMs);
        if (tf === '1w') {
            const daysSinceMonday = (d.getUTCDay() + 6) % 7;
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday);
        }
        if (tf === '1M') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
        if (tf === '1y') return Date.UTC(d.getUTCFullYear(), 0, 1);
        const ms = MarketFeedManager.tfToMs(tf);
        return Math.floor(tsMs / ms) * ms;
    }

    setCallbacks(callbacks = {}) {
        this.callbacks = { ...this.callbacks, ...callbacks };
    }

    start({ pair, tf, history = [] } = {}) {
        if (!pair) return;
        this.stop();
        this.pair = pair;
        this.tf = tf || '15m';
        this.aggregator = new TickCandleAggregator(MarketFeedManager.tfToMs(this.tf), this.tf);
        if (Array.isArray(history) && history.length > 0) {
            this.aggregator.seed(history[history.length - 1]);
        }
        this._session += 1;
        this.booted = true;
        this._emitStatus({ status: 'CONNECTING', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
        this._connect('BINANCE', this._session);
        this._connect('BYBIT', this._session);
        this._startVisionPoller(this._session);
        this._healthTimer = setInterval(() => this._evaluateHealth(this._session), 700);
    }

    stop() {
        this.pair = null;
        this._clearReconnect('BINANCE');
        this._clearReconnect('BYBIT');
        for (const key of Object.keys(this.sources)) {
            const src = this.sources[key];
            if (src.pingTimer) { clearInterval(src.pingTimer); src.pingTimer = null; }
            if (src.heartbeatTimer) { clearInterval(src.heartbeatTimer); src.heartbeatTimer = null; }
            if (src.socket) {
                try { src.socket.close(); } catch (_) {}
            }
            src.socket = null;
            src.ready = false;
            src.status = 'DISCONNECTED';
            src.latencyMs = Infinity;
            src.samples = 0;
            src.staleCount = 0;
        }
        if (this._healthTimer) {
            clearInterval(this._healthTimer);
            this._healthTimer = null;
        }
        if (this._visionTimer) {
            clearInterval(this._visionTimer);
            this._visionTimer = null;
        }
        this._visionPolling = false;
    }

    _clearReconnect(name) {
        const src = this.sources[name];
        if (src && src.reconnectTimer) {
            clearTimeout(src.reconnectTimer);
            src.reconnectTimer = null;
        }
    }

    _scheduleReconnect(name, session, reason = 'reconnect') {
        const src = this.sources[name];
        if (!src || session !== this._session) return;
        this._clearReconnect(name);
        src.reconnectDelay = Math.min(Math.max(src.reconnectDelay * 2, 1000), 30_000);
        src.status = reason === 'error' ? 'ERROR' : 'RECONNECTING';
        this._emitStatus({ status: src.status, activeSource: this.activeSource, pair: this.pair, tf: this.tf });
        src.reconnectTimer = setTimeout(() => this._connect(name, session), src.reconnectDelay);
    }

    _connect(name, session) {
        if (session !== this._session || !this.pair) return;
        const src = this.sources[name];
        if (!src) return;
        if (src.pingTimer) {
            clearInterval(src.pingTimer);
            src.pingTimer = null;
        }
        this._clearReconnect(name);
        if (src.socket) {
            try { src.socket.close(); } catch (_) {}
            src.socket = null;
        }

        let ws = null;
        if (name === 'BINANCE') {
            const url = src.urlFor(this.pair, this.tf);
            ws = new WebSocket(url);
            ws.onopen = () => {
                src.ready = true;
                src.status = 'LIVE';
                src.reconnectDelay = 1000;
                src.lastReceiveMs = performance.now();
                
                src.heartbeatTimer = setInterval(() => {
                    if (!src.socket) return;
                    const staleMs = performance.now() - (src.lastReceiveMs || 0);
                    if (staleMs > 12_000) {
                        try { src.socket.close(); } catch (_) {}
                    }
                }, 3000);
                this._emitStatus({ status: 'LIVE', source: 'BINANCE', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
            };
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (!msg || msg.s !== this.pair || !Number.isFinite(+msg.p)) return;
                    const receiveMs = performance.now();
                    const tsMs = Number(msg.T || msg.E || Date.now());
                    this._handleTick('BINANCE', {
                        price: +msg.p,
                        qty: +msg.q || 0,
                        takerBuyQty: msg.m ? 0 : (+msg.q || 0),
                        tsMs,
                        receiveMs,
                        raw: msg
                    });
                } catch (err) {
                    console.warn('BINANCE feed parse failed', err);
                }
            };
            ws.onerror = () => {
                src.status = 'ERROR';
                this._emitStatus({ status: 'ERROR', source: 'BINANCE', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
            };
            ws.onclose = () => {
                src.ready = false;
                src.socket = null;
                src.status = 'DISCONNECTED';
                this._emitStatus({ status: 'DISCONNECTED', source: 'BINANCE', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
                this._scheduleReconnect('BINANCE', session, 'close');
            };
            src.socket = ws;
            return;
        }

        if (name === 'BYBIT') {
            const url = src.urlFor(this.pair, this.tf);
            ws = new WebSocket(url);
            ws.onopen = () => {
                src.ready = true;
                src.status = 'LIVE';
                src.reconnectDelay = 1000;
                src.lastReceiveMs = performance.now();
                try {
                    ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${this.pair}`] }));
                } catch (_) {}
                src.pingTimer = setInterval(() => {
                    if (!src.socket || src.socket.readyState !== WebSocket.OPEN) return;
                    try {
                        src.lastPingAt = performance.now(); src.socket.send(JSON.stringify({ op: 'ping' }));
                    } catch (_) {}
                }, 20_000);
                this._emitStatus({ status: 'LIVE', source: 'BYBIT', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
            };
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg?.op === 'pong' || msg?.type === 'pong' || msg?.ret_msg === 'pong') {
                        if (src.lastPingAt > 0) { src.lastPongAt = performance.now(); src.pingRttMs = Math.max(0, src.lastPongAt - src.lastPingAt); }
                        return;
                    }
                    if (!msg || msg.topic !== `publicTrade.${this.pair}` || !Array.isArray(msg.data)) return;
                    const receiveMs = performance.now();
                    const serverTs = Number(msg.ts || Date.now());
                    for (const t of msg.data) {
                        const price = Number(t.p || t.price);
                        if (!Number.isFinite(price)) continue;
                        const qty = Number(t.v || t.size || t.q || 0) || 0;
                        const side = String(t.S || t.side || '').toLowerCase();
                        const takerBuyQty = side === 'buy' ? qty : 0;
                        const tsMs = Number(t.T || t.ts || serverTs || Date.now());
                        this._handleTick('BYBIT', {
                            price,
                            qty,
                            takerBuyQty,
                            tsMs,
                            receiveMs,
                            raw: t,
                            serverTs
                        });
                    }
                } catch (err) {
                    console.warn('BYBIT feed parse failed', err);
                }
            };
            ws.onerror = () => {
                src.status = 'ERROR';
                this._emitStatus({ status: 'ERROR', source: 'BYBIT', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
            };
            ws.onclose = () => {
                src.ready = false;
                src.socket = null;
                if (src.pingTimer) {
                    clearInterval(src.pingTimer);
                    src.pingTimer = null;
                }
                src.status = 'DISCONNECTED';
                this._emitStatus({ status: 'DISCONNECTED', source: 'BYBIT', activeSource: this.activeSource, pair: this.pair, tf: this.tf });
                this._scheduleReconnect('BYBIT', session, 'close');
            };
            src.socket = ws;
        }
    }

    /** WebSocket dianggap segar bila pernah menerima data < 15 detik lalu. */
    _wsFresh(src) {
        return !!(src && src.ready && Number.isFinite(src.lastReceiveMs) &&
            (performance.now() - src.lastReceiveMs) < 15000);
    }

    _startVisionPoller(session) {
        if (this._visionTimer) {
            clearInterval(this._visionTimer);
            this._visionTimer = null;
        }
        this._visionPolling = false;
        this._visionTimer = setInterval(() => this._pollVision(session), this._visionPollMs);
        // Poll pertama segera (async, tidak menghambat boot WebSocket).
        this._pollVision(session);
    }

    /**
     * Fallback REST 10-detik ke mirror anti-blokir. Hanya mengambil alih saat
     * KEDUA WebSocket mati; saat WS sehat poller standby agar hemat kuota.
     * Lilin tertutup yang baru ikut di-emit (throw-no-data tidak terjadi),
     * lilin pembentuk terakhir di-emit sebagai update.
     */
    async _pollVision(session) {
        if (session !== this._session || !this.pair) return;
        if (this._visionPolling) return;
        if (this._wsFresh(this.sources.BINANCE) || this._wsFresh(this.sources.BYBIT)) {
            const standby = this.sources.VISION;
            if (standby && standby.status !== 'STANDBY' && !standby.ready) standby.status = 'STANDBY';
            return;
        }
        if (typeof document !== 'undefined' && document.hidden) return;
        const pair = this.pair;
        const tf = this.tf;
        this._visionPolling = true;
        const startedAt = performance.now();
        try {
            const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 10000) : null;
            let res = null;
            try {
                res = await fetch(this.sources.VISION.urlFor(pair, tf), ctrl ? { signal: ctrl.signal } : undefined);
            } finally {
                if (timer) clearTimeout(timer);
            }
            if (!res || !res.ok) return;
            const rows = await res.json();
            if (session !== this._session || this.pair !== pair) return;
            if (!Array.isArray(rows) || rows.length === 0) return;
            // 1y: poller menarik 1M lalu agregasi ke tahunan (sama seperti
            // historyLoader) supaya candle yang di-emit tetap tahunan.
            let emitRows = rows;
            if (tf === '1y') {
                const agg = (typeof window !== 'undefined' && window.HistoryLoader && window.HistoryLoader.aggregateYearlyRows);
                if (typeof agg !== 'function') return;
                emitRows = agg(rows);
                if (emitRows.length === 0) return;
            }
            const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
            const lastKnown = (this.aggregator && this.aggregator.current && Number.isFinite(this.aggregator.current.time))
                ? this.aggregator.current.time : -Infinity;
            let emitted = 0;
            for (let i = 0; i < emitRows.length; i++) {
                const r = emitRows[i];
                if (!Array.isArray(r) || r.length < 6) continue;
                const t = Math.floor(Number(r[0]) / 1000);
                const o = Number(r[1]), h = Number(r[2]), l = Number(r[3]), c = Number(r[4]);
                if (!Number.isFinite(t) || t < lastKnown) continue;
                if (![o, h, l, c].every(Number.isFinite) || !(c > 0)) continue;
                this._emitVisionCandle({
                    time: t, open: o, high: h, low: l, close: c,
                    vol: Number(r[5]) || 0, takerVol: Number(r[9]) || 0
                }, i === emitRows.length - 1, latencyMs);
                emitted++;
            }
            if (emitted > 0) {
                const vis = this.sources.VISION;
                vis.ready = true;
                vis.status = 'LIVE';
                vis.lastReceiveMs = performance.now();
                vis.lastServerTs = Date.now();
                vis.lastPrice = Number(emitRows[emitRows.length - 1][4]) || vis.lastPrice;
                vis.latencyMs = latencyMs;
                vis.samples += emitted;
                vis.staleCount = 0;
                vis.reconnectDelay = 1000;
                // Titik ini hanya tercapai saat kedua WS tidak segar (cek di
                // awal _pollVision), jadi VISION memang sumber aktif.
                // Saat WS pulih, _maybeSwitchActiveSource mengembalikannya.
                if (!this._wsFresh(this.sources.BINANCE) && !this._wsFresh(this.sources.BYBIT)) {
                    this.activeSource = 'VISION';
                }
            }
        } catch (_) {
            const vis = this.sources.VISION;
            if (vis && !vis.ready) vis.status = 'DISCONNECTED';
        } finally {
            this._visionPolling = false;
        }
    }

    _emitVisionCandle(candle, isForming, latencyMs) {
        try {
            if (typeof AppState !== 'undefined' && AppState) {
                AppState.venueQuotes = AppState.venueQuotes || {};
                AppState.venueQuotes.VISION = {
                    price: candle.close, tsMs: Date.now(), latencyMs: latencyMs, receiveMs: performance.now()
                };
            }
        } catch (_) { /* cache quote opsional */ }
        // Selaraskan agregator agar recovery WebSocket nanti bersih.
        try { this.aggregator.seed(candle); } catch (_) {}
        let spreadPct = 0;
        try {
            if (typeof AppState !== 'undefined' && AppState && AppState.venueQuotes) {
                const others = [AppState.venueQuotes.BINANCE, AppState.venueQuotes.BYBIT]
                    .filter((q) => q && Number.isFinite(q.price) && q.price > 0);
                if (others.length > 0) {
                    const ref = others[0].price;
                    spreadPct = (Math.abs(ref - candle.close) / ((ref + candle.close) / 2)) * 100;
                }
            }
        } catch (_) {}
        const status = this._buildStatusPayload({ spreadPct: spreadPct });
        this._emitTick({
            time: candle.time, open: candle.open, high: candle.high, low: candle.low,
            close: candle.close, vol: candle.vol, takerVol: candle.takerVol,
            isClosed: !isForming, source: 'VISION', latencyMs: latencyMs, spreadPct: spreadPct,
            sourceQuotes: this._visionQuotes()
        }, status);
    }

    _visionQuotes() {
        try {
            if (typeof AppState !== 'undefined' && AppState && AppState.venueQuotes) {
                return {
                    BINANCE: AppState.venueQuotes.BINANCE || null,
                    BYBIT: AppState.venueQuotes.BYBIT || null,
                    VISION: AppState.venueQuotes.VISION || null
                };
            }
        } catch (_) {}
        return { BINANCE: null, BYBIT: null, VISION: null };
    }

    _handleTick(sourceName, tick) {
        const src = this.sources[sourceName];
        if (!src || !Number.isFinite(tick.price)) return;

        src.ready = true;
        src.status = 'LIVE';
        src.lastReceiveMs = tick.receiveMs || performance.now();
        src.lastServerTs = tick.tsMs || Number(tick.serverTs || tick.receiveMs || Date.now());
        src.lastPrice = tick.price;
        const exchLatency = Math.max(0, (tick.receiveMs || performance.now()) - src.lastServerTs);
        src.latencyMs = Number.isFinite(src.pingRttMs) ? Math.round((exchLatency + src.pingRttMs) / 2) : exchLatency;
        src.samples += 1;
        src.staleCount = 0;

        if (window.AppState) {
            AppState.venueQuotes[sourceName] = {
                price: tick.price,
                tsMs: src.lastServerTs,
                latencyMs: src.latencyMs,
                receiveMs: src.lastReceiveMs
            };
        }

        const switched = this._maybeSwitchActiveSource();
        if (sourceName !== this.activeSource && !switched) {
            this._emitStatus(this._buildStatusPayload());
            return;
        }

        const out = this.aggregator.ingest(tick);
        if (!out || !out.candle) {
            this._emitStatus(this._buildStatusPayload());
            return;
        }

        const other = this.activeSource === 'BINANCE' ? 'BYBIT' : 'BINANCE';
        const otherQuote = AppState?.venueQuotes?.[other];
        const spreadPct = otherQuote && Number.isFinite(otherQuote.price)
            ? (Math.abs(otherQuote.price - tick.price) / ((otherQuote.price + tick.price) / 2)) * 100
            : 0;

        const payload = {
            ...out.candle,
            isClosed: out.isClosed,
            source: sourceName,
            latencyMs: src.latencyMs,
            spreadPct,
            sourceQuotes: {
                BINANCE: AppState?.venueQuotes?.BINANCE || null,
                BYBIT: AppState?.venueQuotes?.BYBIT || null
            }
        };
        this._emitTick(payload, this._buildStatusPayload({ spreadPct }));
    }

    _buildStatusPayload(extra = {}) {
        if (this.lockedSource && this.sources[this.lockedSource] && this.sources[this.lockedSource].ready) {
            this.activeSource = this.lockedSource;
        }
        const bin = this.sources.BINANCE;
        const byb = this.sources.BYBIT;
        const vis = this.sources.VISION;
        const active = this.sources[this.activeSource] || bin;
        const spreadPct = Number.isFinite(extra.spreadPct)
            ? extra.spreadPct
            : (AppState?.venueQuotes?.BINANCE?.price && AppState?.venueQuotes?.BYBIT?.price)
                ? (Math.abs(AppState.venueQuotes.BINANCE.price - AppState.venueQuotes.BYBIT.price) / ((AppState.venueQuotes.BINANCE.price + AppState.venueQuotes.BYBIT.price) / 2)) * 100
                : 0;
        return {
            status: active?.status || 'WAIT',
            error: extra.error || null,
            activeSource: this.activeSource,
            primarySource: this.activeSource,
            pair: this.pair,
            tf: this.tf,
            latencyMs: active?.latencyMs || 0,
            spreadPct,
            binance: {
                status: bin.status,
                latencyMs: Number.isFinite(bin.latencyMs) ? bin.latencyMs : 0,
                price: bin.lastPrice || 0
            },
            bybit: {
                status: byb.status,
                latencyMs: Number.isFinite(byb.latencyMs) ? byb.latencyMs : 0,
                price: byb.lastPrice || 0
            },
            vision: {
                status: (vis && vis.status) || 'DISCONNECTED',
                latencyMs: (vis && Number.isFinite(vis.latencyMs)) ? vis.latencyMs : 0,
                price: (vis && vis.lastPrice) || 0
            }
        };
    }

    _emitTick(candle, statusPayload = null) {
        if (typeof this.callbacks.onTick === 'function') {
            this.callbacks.onTick(candle, statusPayload || this._buildStatusPayload());
        }
        this._emitStatus(statusPayload || this._buildStatusPayload());
    }

    _emitStatus(payload = {}) {
        if (typeof this.callbacks.onStatus === 'function') {
            this.callbacks.onStatus(payload);
        }
    }

    _healthyScore(src) {
        if (!src || !src.ready || !Number.isFinite(src.lastReceiveMs)) return Infinity;
        const staleMs = performance.now() - src.lastReceiveMs;
        const stalePenalty = Math.max(0, staleMs - 1000) * 0.35;
        return (Number.isFinite(src.latencyMs) ? src.latencyMs : 9999) + stalePenalty;
    }

    _maybeSwitchActiveSource() {
        if (this.lockedSource && this.sources[this.lockedSource] && this.sources[this.lockedSource].ready) {
            this.activeSource = this.lockedSource;
            return false;
        }
        // Kembali dari mode VISION-REST ke WebSocket yang pulih.
        if (this.activeSource === 'VISION') {
            const revived = ['BINANCE', 'BYBIT']
                .map((n) => ({ name: n, src: this.sources[n] }))
                .filter((c) => c.src && c.src.ready && (performance.now() - (c.src.lastReceiveMs || 0)) < 15000);
            if (revived.length > 0) {
                revived.sort((a, b) => this._healthyScore(a.src) - this._healthyScore(b.src));
                this.activeSource = revived[0].name;
                this._switchHistory.push({ at: Date.now(), activeSource: this.activeSource });
                if (this._switchHistory.length > 20) this._switchHistory.shift();
                this._emitStatus(this._buildStatusPayload({ status: 'SWITCHED' }));
                return true;
            }
            return false;
        }
        const bin = this.sources.BINANCE;
        const byb = this.sources.BYBIT;
        const active = this.sources[this.activeSource];
        const activeScore = this._healthyScore(active);
        const binScore = this._healthyScore(bin);
        const bybScore = this._healthyScore(byb);
        const bestSource = binScore <= bybScore ? 'BINANCE' : 'BYBIT';
        const best = this.sources[bestSource];
        const activeStale = active ? (performance.now() - (active.lastReceiveMs || 0)) : Infinity;
        const bestStale = best ? (performance.now() - (best.lastReceiveMs || 0)) : Infinity;

        const shouldSwitch =
            !active ||
            !active.ready ||
            activeStale > 2500 ||
            (!Number.isFinite(activeScore) || !Number.isFinite(best ? this._healthyScore(best) : Infinity) ? false : (this._healthyScore(best) + 75 < activeScore && bestStale < 2500));

        if (shouldSwitch && best && best.ready && best.lastPrice > 0 && bestSource !== this.activeSource) {
            this.activeSource = bestSource;
            this._switchHistory.push({ at: Date.now(), activeSource: this.activeSource });
            if (this._switchHistory.length > 20) this._switchHistory.shift();
            this._emitStatus(this._buildStatusPayload({ status: 'SWITCHED' }));
            return true;
        }
        return false;
    }

    _evaluateHealth(session) {
        if (session !== this._session) return;
        const active = this.sources[this.activeSource];
        if (active && active.ready && (performance.now() - active.lastReceiveMs) < 3000) {
            this._emitStatus(this._buildStatusPayload());
            return;
        }
        this._maybeSwitchActiveSource();
        this._emitStatus(this._buildStatusPayload());
    }
}

if (typeof window !== 'undefined') window.MarketFeedManager = MarketFeedManager;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MarketFeedManager: MarketFeedManager, TickCandleAggregator: TickCandleAggregator };
}
