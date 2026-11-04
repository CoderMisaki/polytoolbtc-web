function getMarketSession() { 
    const h = new Date().getUTCHours(); 
    if (h >= 13 && h < 16) return "LONDON + NEW YORK"; 
    if (h >= 8 && h < 13) return "LONDON"; 
    if (h >= 16 && h < 21) return "NEW YORK"; 
    return "ASIAN"; 
}

let globalAlertHideTimer = null;
let globalAlertTargetPair = null;
const boundGlobalAlertElements = new WeakSet();

function handleGlobalAlertClick() {
    if (!globalAlertTargetPair) return;
    const pairSelect = document.getElementById('pair');
    if (!pairSelect) return;
    pairSelect.value = globalAlertTargetPair;
    changeConfig();
}

function ensureGlobalAlertClickHandler(alertElement) {
    if (boundGlobalAlertElements.has(alertElement)) return;
    alertElement.addEventListener('click', handleGlobalAlertClick);
    boundGlobalAlertElements.add(alertElement);
}

function triggerGlobalAlertIfNeeded() { 
    const a = document.getElementById('global-pos-alert'); 
    if (!a) return;
    ensureGlobalAlertClickHandler(a);
    const o = FuturesEngine.state.positions.find(p => p.pair !== AppState.g_pair); 
    if (globalAlertHideTimer) {
        clearTimeout(globalAlertHideTimer);
        globalAlertHideTimer = null;
    }
    if (o) { 
        globalAlertTargetPair = o.pair;
        a.innerText = `⚠️ Ada Posisi Aktif di ${o.pair} (Klik untuk pindah)`; 
        a.classList.remove('is-hidden'); 
        globalAlertHideTimer = setTimeout(() => {
            a.classList.add('is-hidden');
        }, 2000);
    } else { 
        globalAlertTargetPair = null;
        a.classList.add('is-hidden'); 
    }
}

function formatSignedUsd(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '$0.00';
    const abs = Math.abs(n);
    // Avoid "-$0.00" for values that round to zero.
    const sign = n > 0 && abs >= 0.005 ? '+' : (n < 0 && abs >= 0.005 ? '-' : '');
    return `${sign}$${abs.toFixed(2)}`;
}

function pnlColorVar(value) {
    if (value > 0.004) return 'var(--color-correct)';
    if (value < -0.004) return 'var(--color-wrong)';
    return 'var(--accent-white)';
}

// Live account readout. "Saldo Demo" is the account EQUITY (wallet + floating
// PNL of every open position, ISOLATED and CROSS alike), so it rises and falls
// with the market on each tick like a real exchange account.
function updateEquityDisplay() { 
    const summary = FuturesEngine.getAccountSummary();
    const balEl = document.getElementById('demo-balance');
    setSafeText('demo-balance', `$${summary.equity.toFixed(2)}`, summary.positionCount > 0 ? pnlColorVar(summary.unrealizedPnl) : 'var(--accent-white)');
    if (balEl) balEl.title = 'Equity = saldo wallet + PNL floating semua posisi aktif';

    const liveRow = document.getElementById('demo-live-row');
    if (liveRow) liveRow.classList.toggle('is-hidden', summary.positionCount === 0);
    if (summary.positionCount > 0) {
        setSafeText('demo-wallet', `$${summary.wallet.toFixed(2)}`);
        setSafeText('demo-upnl', formatSignedUsd(summary.unrealizedPnl), pnlColorVar(summary.unrealizedPnl));
    }
}



function setChartLoading(active, message = "Memuat chart...") {
    const loadingEl = document.getElementById('chart-loading');
    const textEl = document.getElementById('chart-loading-text');
    if (textEl && message) textEl.innerText = message;
    if (!loadingEl) return;
    loadingEl.classList.toggle('active', !!active);
}

/* Feed badge rendering.
 *
 * The WebSocket delivers many ticks per second and `updateFeedStatus` used to
 * run a full set of DOM class/text writes on every one of them (twice per tick
 * on some paths). State is still updated on every call; only the DOM writes
 * are coalesced into one animation frame with a minimum interval.
 */
const FEED_STATUS_MIN_INTERVAL_MS = 350;
let lastFeedStatusRenderAt = 0;
let feedStatusRenderQueued = false;
let lastFeedStatusInfo = null;

function renderFeedStatus(info) {
    const feed = AppState.feed || {};
    const active = info.activeSource || feed.activeVenue || 'BINANCE';
    const latency = Number.isFinite(info.latencyMs) ? info.latencyMs : (Number.isFinite(feed.latencyMs) ? feed.latencyMs : 0);
    const isError = info.status === 'ERROR' || feed.status === 'ERROR';
    const sourceText = isError ? `${active} ERROR` : (active ? `${active}` : '-');
    const latencyText = Number.isFinite(latency) ? `${Math.max(0, Math.round(latency))}ms` : '—';
    setSafeText('badge-source', `Feed: ${sourceText}`);
    setSafeText('badge-latency', latencyText);
    const sourceBadge = document.getElementById('badge-source');
    const latencyBadge = document.getElementById('badge-latency');
    if (sourceBadge) {
        sourceBadge.classList.remove('badge-source-error', 'badge-source-bybit', 'badge-source-default');
        sourceBadge.classList.add(isError ? 'badge-source-error' : ((active === 'BYBIT' || active === 'VISION') ? 'badge-source-bybit' : 'badge-source-default'));
        if (info.error) sourceBadge.title = info.error;
    }
    if (latencyBadge) {
        latencyBadge.classList.remove('badge-latency-high', 'badge-latency-med', 'badge-latency-low');
        latencyBadge.classList.add(latency > 1200 ? 'badge-latency-high' : (latency > 500 ? 'badge-latency-med' : 'badge-latency-low'));
    }
    lastFeedStatusRenderAt = Date.now();
}

function scheduleFeedStatusRender(info) {
    lastFeedStatusInfo = info;
    if (feedStatusRenderQueued) return;
    const run = () => {
        feedStatusRenderQueued = false;
        const gap = Date.now() - lastFeedStatusRenderAt;
        if (gap < FEED_STATUS_MIN_INTERVAL_MS && lastFeedStatusRenderAt > 0) {
            // Not yet due: try again for the remainder of the interval.
            scheduleFeedStatusRender(lastFeedStatusInfo || {});
            return;
        }
        renderFeedStatus(lastFeedStatusInfo || {});
    };
    feedStatusRenderQueued = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
}

function updateFeedStatus(info = {}, force = false) {
    const feed = AppState.feed || {};
    const active = info.activeSource || feed.activeVenue || 'BINANCE';
    const latency = Number.isFinite(info.latencyMs) ? info.latencyMs : (Number.isFinite(feed.latencyMs) ? feed.latencyMs : 0);
    const spread = Number.isFinite(info.spreadPct) ? info.spreadPct : (Number.isFinite(feed.spreadPct) ? feed.spreadPct : 0);
    const isError = info.status === 'ERROR' || feed.status === 'ERROR';

    // State first: consumers read AppState.feed, never the DOM.
    feed.activeVenue = active;
    feed.primaryVenue = active;
    feed.secondaryVenue = active === 'BINANCE' ? 'BYBIT' : 'BINANCE';
    feed.latencyMs = latency;
    feed.spreadPct = spread;
    feed.lastUpdate = Date.now();
    feed.status = info.status || feed.status || 'LIVE';
    if (info.error) feed.lastError = info.error;
    feed.sourceStatus = {
        BINANCE: info.binance?.status || feed.sourceStatus?.BINANCE || 'DISCONNECTED',
        BYBIT: info.bybit?.status || feed.sourceStatus?.BYBIT || 'DISCONNECTED'
    };
    AppState.feed = feed;

    if (force || isError) {
        // Errors must surface immediately, never behind a throttle.
        lastFeedStatusInfo = info;
        lastFeedStatusRenderAt = 0;
        renderFeedStatus(info);
        return;
    }
    scheduleFeedStatusRender(info);
}

function updatePolyButtons() { 
    const p5 = polymarketLog.some((p) => p.status === 'PENDING' && p.pair === AppState.g_pair && p.tfLabel === '5m');
    const p15 = polymarketLog.some((p) => p.status === 'PENDING' && p.pair === AppState.g_pair && p.tfLabel === '15m');
    const b5 = document.getElementById('btn-poly-5');
    const b15 = document.getElementById('btn-poly-15'); 
    let b = AppState.g_base || 'COIN';
    
    if (b5) { 
        b5.disabled = p5; 
        b5.innerText = p5 ? '5m (Run)' : `Predict 5M ${b}`; 
        b5.style.opacity = p5 ? '0.5' : '1';
        b5.style.cursor = p5 ? 'not-allowed' : 'pointer';
    } 
    if (b15) { 
        b15.disabled = p15; 
        b15.innerText = p15 ? '15m (Run)' : `Predict 15M ${b}`; 
        b15.style.opacity = p15 ? '0.5' : '1';
        b15.style.cursor = p15 ? 'not-allowed' : 'pointer';
    } 
}

function createModalElement(tag, { className = '', text = '', attrs = {}, checked = undefined } = {}) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = String(text);
    if (checked !== undefined) element.checked = !!checked;
    Object.entries(attrs).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        element.setAttribute(key, String(value));
    });
    return element;
}

function appendModalChildren(parent, children) {
    children.filter(Boolean).forEach((child) => parent.appendChild(child));
    return parent;
}

function replaceChildrenById(id, children) {
    const element = document.getElementById(id);
    if (!element) return null;
    element.replaceChildren(...children.filter(Boolean));
    return element;
}

function createModalInputField({ wrapperClass = 'modal-field', label, inputAttrs = {}, value = '' }) {
    // Must be a real <input>: `document.createElement('change')` yields an
    // unknown element with no value/checked semantics.
    const input = createModalElement('input', { attrs: inputAttrs });
    input.value = value === undefined || value === null ? '' : String(value);
    return appendModalChildren(createModalElement('div', { className: wrapperClass }), [
        createModalElement('label', { className: 'modal-label', text: label }),
        input
    ]);
}

function createPartialCloseModalBody() {
    const slider = createModalElement('input', {
        className: 'partial-slider',
        attrs: { type: 'range', id: 'partial-close-slider', min: '1', max: '100', value: '100' }
    });
    const sliderRow = appendModalChildren(createModalElement('div', { className: 'partial-slider-row' }), [
        slider,
        createModalElement('span', { className: 'partial-value', text: '100%', attrs: { id: 'partial-close-val' } })
    ]);
    const percentageButtons = appendModalChildren(createModalElement('div', { className: 'btn-group modal-field' }), [
        createModalElement('button', { className: 'btn btn-secondary', text: '10%', attrs: { type: 'button', 'data-partial-close-pct': '10' } }),
        createModalElement('button', { className: 'btn btn-secondary', text: '25%', attrs: { type: 'button', 'data-partial-close-pct': '25' } }),
        createModalElement('button', { className: 'btn btn-secondary', text: '50%', attrs: { type: 'button', 'data-partial-close-pct': '50' } }),
        createModalElement('button', { className: 'btn btn-secondary', text: 'All', attrs: { type: 'button', 'data-partial-close-pct': '100' } })
    ]);
    return [
        appendModalChildren(createModalElement('div', { className: 'modal-field' }), [
            createModalElement('label', { className: 'modal-label', text: 'Persentase Penutupan (%)' }),
            sliderRow
        ]),
        percentageButtons,
        createModalElement('button', {
            className: 'btn btn-danger w-100',
            text: 'Konfirmasi Tutup',
            attrs: { type: 'button', 'data-action': 'partial-close-confirm' }
        })
    ];
}

function createEditTpSlModalBody(id, pos) {
    const hedgeCheckbox = createModalElement('input', {
        checked: !!pos.autoHedgeTrail,
        attrs: { type: 'checkbox', id: 'edit-hedge-ts' }
    });
    return [
        createModalElement('button', {
            className: 'btn btn-secondary w-100 modal-field text-warning',
            text: '✨ Hitung Otomatis TP/SL (ATR Base)',
            attrs: { type: 'button', 'data-action': 'auto-tpsl', 'data-position-id': id }
        }),
        createModalInputField({
            wrapperClass: 'modal-field-sm',
            label: 'Target Price (TP)',
            inputAttrs: { type: 'number', id: 'edit-tp-val', placeholder: 'Masukkan TP valid' },
            value: pos.tp || ''
        }),
        createModalInputField({
            label: 'Stop Loss Price (SL)',
            inputAttrs: { type: 'number', id: 'edit-sl-val', placeholder: 'Masukkan SL valid' },
            value: pos.sl || ''
        }),
        appendModalChildren(createModalElement('label', { className: 'checkbox-container modal-field-sm' }), [
            hedgeCheckbox,
            createModalElement('span', { text: 'Automatic Hedging Trailing Stop' })
        ]),
        createModalInputField({
            label: 'Hedge Callback %',
            inputAttrs: { type: 'number', id: 'edit-hedge-callback', placeholder: 'Contoh: 1' },
            value: pos.tsCallback || ''
        }),
        createModalElement('button', {
            className: 'btn btn-primary w-100',
            text: 'Simpan Pembaruan',
            attrs: { type: 'button', 'data-action': 'save-tpsl' }
        })
    ];
}

const MarketFeed = window.MarketFeedManager ? new window.MarketFeedManager() : null;
window.MarketFeed = MarketFeed;
if (MarketFeed) {
    MarketFeed.setCallbacks({
        onTick: (candle, meta) => updateLiveTick(candle, meta),
        onStatus: (meta) => updateFeedStatus(meta)
    });
}

window.logPolymarketAction = function(minutes) {
    // Predictions are a local demo feature: no login required.
    try {
        if (!AppState.price) {
            showToast('Data harga belum siap.', true, 5000);
            return;
        }

        if (polymarketLog.some(p => p.status === 'PENDING' && p.pair === AppState.g_pair && p.tfLabel === minutes + 'm')) {
            showToast('Masih ada prediksi aktif di timeframe ini.', true, 5000);
            return;
        }

        let direction = AppState.live.signal === 'STRONG SELL' ? 'SHORT' : (AppState.live.signal === 'STRONG BUY' ? 'LONG' : null);

        if (!direction) {
            // Fallback: use score direction so the button always works (user request 2026-10-09).
            // Score > 0 = bullish = LONG, score < 0 = bearish = SHORT, score = 0 = use last signal or LONG.
            const score = Number(AppState.live.score);
            if (Number.isFinite(score) && score !== 0) {
                direction = score > 0 ? 'LONG' : 'SHORT';
            } else if (AppState.aiMode === 'AGG') {
                direction = score >= 0 ? 'LONG' : 'SHORT';
                showToast('Polymarket: mode agresif membuat simulasi arah berdasarkan skor saat ini.', false);
            } else {
                // Last resort: use the most recent non-WAIT signal, default LONG
                const lastSig = AppState.live.prevSignal;
                direction = lastSig === 'STRONG SELL' ? 'SHORT' : 'LONG';
                showToast('Polymarket: sinyal belum kuat, pakai arah default berdasarkan skor.', false);
            }
        }

        const p = {
            id: Date.now(),
            pair: AppState.g_pair,
            tfLabel: minutes + 'm',
            direction: direction,
            startPrice: AppState.price,
            requestTime: Math.floor(Date.now() / 1000),
            targetTime: Math.floor(Date.now() / 1000) + (minutes * 60),
            status: 'PENDING'
        };

        polymarketLog.push(p);
        if (polymarketLog.length > 200) polymarketLog = polymarketLog.slice(-200);
        saveState();

        PolyLineManager.draw(p);
        updatePolyButtons();
        updateLedgerUI();
        showToast(`Posisi prediksi terbuka: ${AppState.g_pair} ${direction} (${minutes}m)`, false, 3000);
    } catch (error) {
        console.error('logPolymarketAction failed:', error);
        showToast(`Gagal membuka prediksi: ${error.message}`, true, 5000);
    }
};

window.cancelPrediction = function(id) { 
    const p = polymarketLog.find(x => x.id === id); 
    if (p && p.status === 'PENDING') { 
        p.status = 'CANCELLED'; 
        PolyLineManager.remove(id); 
        saveState(); 
        updatePolyButtons(); 
        updateLedgerUI(); 
        showToast("Prediksi Polymarket dibatalkan."); 
    } 
};

window.closeActionModal = function(f) { 
    const modal = document.getElementById('action-modal'); 
    if (f === true || (f && f.target && f.target.id === 'action-modal')) { 
        modal.classList.remove('active'); 
        AppState.actionPosId = null; 
    } 
};

window.openPartialCloseModal = function(id) {
    AppState.actionPosId = id; 
    document.getElementById('action-modal-title').innerText = "Tutup Posisi (Sebagian / Semua)";
    replaceChildrenById('action-modal-body', createPartialCloseModalBody());
    document.getElementById('action-modal').classList.add('active');
}

window.executePartialClose = function() {
    const slider = document.getElementById('partial-close-slider');
    const pct = slider ? parseFloat(slider.value) : NaN;
    if (isNaN(pct) || pct <= 0 || pct > 100) {
        showToast('Persentase penutupan harus antara 1% dan 100%.', true);
        return { ok: false, reason: 'INVALID_CLOSE_PERCENTAGE' };
    }
    if (AppState.actionPosId === null || AppState.actionPosId === undefined) {
        showToast('Posisi yang akan ditutup tidak ditemukan. Buka kembali daftar posisi.', true);
        return { ok: false, reason: 'POSITION_NOT_SELECTED' };
    }

    // FuturesEngine settles local state synchronously before attempting any
    // optional backend mirror. A missing login/network can therefore never
    // prevent the confirmed manual close.
    const result = FuturesEngine.closePosition(AppState.actionPosId, false, 'CLOSED', pct);
    if (!result || !result.ok) {
        showToast('Posisi tidak dapat ditutup. Muat ulang daftar posisi lalu coba lagi.', true);
        return result || { ok: false, reason: 'CLOSE_FAILED' };
    }
    FuturesEngine.updateUI();
    updateEquityDisplay();
    updateLedgerUI();
    if (typeof scheduleChartRender === 'function') scheduleChartRender();
    closeActionModal(true);
    return result;
}

window.openEditTpSlModal = function(id) {
    AppState.actionPosId = id; 
    let pos = FuturesEngine.state.positions.find(p => String(p.id) === String(id)); 
    if (!pos) return;
    
    document.getElementById('action-modal-title').innerText = "Edit TP / SL Posisi Aktif";
    replaceChildrenById('action-modal-body', createEditTpSlModalBody(id, pos));
    document.getElementById('action-modal').classList.add('active');
}

window.autoCalculateTpSl = function(id) {
    let pos = FuturesEngine.state.positions.find(p => String(p.id) === String(id)); 
    if (!pos) return;
    
    let atr = AppState.live.atr || (pos.entryPrice * 0.01);
    let tp = pos.type === 'LONG' ? pos.entryPrice + (atr * 2) : pos.entryPrice - (atr * 2);
    let sl = pos.type === 'LONG' ? pos.entryPrice - atr : pos.entryPrice + atr;
    
    document.getElementById('edit-tp-val').value = formatPriceInput(tp); 
    document.getElementById('edit-sl-val').value = formatPriceInput(sl); 
    showToast("Hitung otomatis berhasil (Risk 1 : 2 Reward)");
}

window.executeEditTpSl = function() {
    let tpInput = document.getElementById('edit-tp-val').value;
    let tp = tpInput === "" ? null : parseFloat(tpInput);
    
    let slInput = document.getElementById('edit-sl-val').value;
    let sl = slInput === "" ? null : parseFloat(slInput);
    
    let hedgeEnabledEl = document.getElementById('edit-hedge-ts');
    let hedgeCallbackEl = document.getElementById('edit-hedge-callback');
    let pos = FuturesEngine.state.positions.find(p => String(p.id) === String(AppState.actionPosId));
    
    if (pos) { 
        if (tp === null) pos.tp = null;
        else if (!isNaN(tp) && tp > 0) pos.tp = tp;
        if (sl === null) pos.sl = null;
        else if (!isNaN(sl) && sl > 0) pos.sl = sl;
        pos.autoHedgeTrail = !!(hedgeEnabledEl && hedgeEnabledEl.checked);
        const hedgeCallback = hedgeCallbackEl ? parseFloat(hedgeCallbackEl.value) : NaN;
        
        if (!isNaN(hedgeCallback) && hedgeCallback > 0) {
            pos.tsCallback = hedgeCallback;
            if (pos.autoHedgeTrail) {
                let mates = FuturesEngine.state.positions.filter(p => p.pair === pos.pair && p.type !== pos.type && p.autoHedgeTrail);
                mates.forEach(mate => mate.tsCallback = hedgeCallback);
            }
        }
        
        pos.hedgeLinked = false;
        pos.tsIsActive = false;
        pos.tsExtremePrice = pos.type === 'LONG' ? Math.max(pos.entryPrice, AppState.price || pos.entryPrice) : Math.min(pos.entryPrice, AppState.price || pos.entryPrice);
        if (typeof FuturesEngine.noteLocalMutation === 'function') FuturesEngine.noteLocalMutation();
        FuturesEngine.save();
        FuturesEngine.syncUpdatePosition(pos);
        
        if (pos.autoHedgeTrail) {
            FuturesEngine.syncHedgeTrailingState(pos, AppState.price || pos.entryPrice);
        }
        showToast("TP/SL & Hedging Berhasil Diperbarui!"); 
    }
    closeActionModal(true);
}



/**
 * Pair yang boleh dipilih user.
 *
 * LOCAL ARBITRAGE: sumber utamanya adalah universe dinamis hasil intersection
 * Binance ∩ OKX ∩ Bybit (Top N volume futures 24h). Daftar inti dari
 * shared/pairs.js tetap digabungkan supaya pair yang sedang dipakai tidak
 * pernah hilang saat universe di-refresh (mis. salah satu API venue down).
 */
function getSelectablePairs() {
    const core = Array.isArray(window.MASAKO_ALLOWED_PAIRS) ? window.MASAKO_ALLOWED_PAIRS : ['BTCUSDT'];
    let dynamic = [];
    try {
        if (window.MarketUniverse) dynamic = window.MarketUniverse.getPairs() || [];
    } catch (e) { dynamic = []; }

    const merged = [];
    const seen = new Set();
    // Keep positions and the last selected dynamic pair accessible before the
    // exchange universe has loaded (or while its API is offline).
    const savedPair = loadPreference('masako_pref_pair', '');
    const portfolioPairs = (FuturesEngine.state.positions || []).map((p) => p.pair);
    const retained = portfolioPairs.concat(savedPair).filter((pair) => window.MASAKO_PAIRS.isUsdtPerpetualPair(pair));
    dynamic.concat(core, retained).forEach((pair) => {
        const key = String(pair || '').toUpperCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(key);
    });
    return merged.length > 0 ? merged : ['BTCUSDT'];
}

function populatePairDropdown() {
    const pairSelect = document.getElementById('pair');
    if (!pairSelect) return;
    const pairs = getSelectablePairs();
    // Tanda tangan daftar: dropdown hanya dibangun ulang saat isinya benar-benar
    // berubah, jadi refresh universe tidak mereset pilihan user.
    const signature = pairs.join(',');
    if (pairSelect.getAttribute('data-pairs-signature') === signature) return;

    const previous = pairSelect.value;
    pairSelect.innerHTML = '';
    pairs.forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p.replace('USDT', '/USDT');
        pairSelect.appendChild(opt);
    });
    pairSelect.setAttribute('data-pairs-signature', signature);
    if (previous && pairs.includes(previous)) pairSelect.value = previous;
    updateUniverseBadge();
}

/**
 * Badge LOCAL ARBITRAGE di header: jumlah coin hasil intersection selalu
 * terlihat tanpa harus membuka modal scanner.
 */
function updateUniverseBadge() {
    const badge = document.getElementById('pair-universe-badge');
    if (!badge) return;
    if (!window.MarketUniverse) {
        badge.textContent = 'LOCAL ARBITRAGE · nonaktif';
        return;
    }
    let snapshot = null;
    try { snapshot = window.MarketUniverse.getSnapshot(); } catch (e) { snapshot = null; }
    const count = snapshot && Array.isArray(snapshot.coins) ? snapshot.coins.length : 0;
    if (count > 0) {
        badge.textContent = `LOCAL ARBITRAGE · ${count} coin`;
        badge.classList.remove('is-stale');
    } else if (snapshot && snapshot.refreshing) {
        badge.textContent = 'LOCAL ARBITRAGE · memuat universe…';
        badge.classList.add('is-stale');
    } else {
        badge.textContent = 'LOCAL ARBITRAGE · universe kosong';
        badge.classList.add('is-stale');
    }
    const venues = snapshot ? snapshot.venueStatus : {};
    const detail = ['Binance', 'OKX', 'Bybit']
        .map((venue) => `${venue}: ${venues[venue] || 'idle'}`).join(' · ');
    badge.title = `LOCAL ARBITRAGE — Top ${snapshot ? snapshot.universeMax : 200} volume futures 24h ∩ Binance·OKX·Bybit\n`
        + `${detail}\nKlik untuk membuka Funding Arbitrage Scanner.`;
}

/** Sinkronkan kontrol universe LOCAL ARBITRAGE dengan nilai tersimpan. */
function syncUniverseControls() {
    if (!window.MarketUniverse) return;
    const apply = (id, value) => {
        const el = document.getElementById(id);
        if (el && value !== undefined && value !== null) el.value = String(value);
    };
    apply('arb-universe-top', window.MarketUniverse.getUniverseMax());
    apply('arb-universe-min-vol', window.MarketUniverse.getMinTurnover());
    apply('arb-universe-max-spread', window.MarketUniverse.getMaxSpreadBps());
}

/**
 * Pindahkan chart + futures engine ke pair yang muncul di kartu arbitrase.
 * Berlaku untuk KEDUA modal (strategi ALL maupun lokal): bila pair belum ada
 * di dropdown (mis. coin ALL di luar universe), opsi dibuat otomatis supaya
 * tombol "Buka chart" selalu berfungsi, bukan hanya di mode local.
 */
// Points the pair selector (and therefore the chart) at `pair`. Returns the
// normalized symbol, or '' when it cannot be resolved.
function switchChartPair(pair) {
    const pairSelect = document.getElementById('pair');
    if (!pairSelect) return '';
    let target = String(pair || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!target) return '';
    if (!target.endsWith('USDT')) target += 'USDT';
    const hasOption = Array.prototype.some.call(pairSelect.options || [], (o) => String(o.value || '').toUpperCase() === target);
    if (!hasOption) {
        try {
            const opt = document.createElement('option');
            opt.value = target;
            opt.textContent = target.replace('USDT', '/USDT');
            pairSelect.appendChild(opt);
            pairSelect.setAttribute('data-pairs-signature', '');
        } catch (e) {}
    }
    if (pairSelect.value !== target) {
        pairSelect.value = target;
        if (typeof changeConfig === 'function') changeConfig();
    }
    return target;
}

function openArbitragePair(pair) {
    const target = switchChartPair(pair);
    if (!target) return;
    document.getElementById('arbitrage-modal')?.classList.remove('active');
    document.getElementById('local-arbitrage-modal')?.classList.remove('active');
    if (typeof refreshTradeFundingRate === 'function') refreshTradeFundingRate();
    showToast(`Chart dipindah ke ${target}. Pilih exchange LONG/SHORT di panel Futures Execution.`, false, 4000);
}

function openStrategyModal() {
    document.getElementById('local-arbitrage-modal')?.classList.remove('active');
    document.getElementById('arbitrage-modal')?.classList.add('active');
    if (window.ArbitrageScanner) window.ArbitrageScanner.start();
}

function openLocalModal() {
    document.getElementById('arbitrage-modal')?.classList.remove('active');
    document.getElementById('local-arbitrage-modal')?.classList.add('active');
    if (window.ArbitrageScanner) window.ArbitrageScanner.start();
}

function closeArbitrageModals() {
    document.getElementById('arbitrage-modal')?.classList.remove('active');
    document.getElementById('local-arbitrage-modal')?.classList.remove('active');
    // Polling berhenti hanya bila kedua modal tertutup.
    const s = document.getElementById('arbitrage-modal');
    const l = document.getElementById('local-arbitrage-modal');
    const anyOpen = (s && s.classList.contains('active')) || (l && l.classList.contains('active'));
    if (!anyOpen && window.ArbitrageScanner) window.ArbitrageScanner.stop();
}

/**
 * Funding rate per venue untuk pair apa pun. Cache ArbitrageScanner dipakai
 * lebih dulu (paling segar, polling 10 detik); universe LOCAL ARBITRAGE jadi
 * fallback karena symbol mapping-nya sudah dinormalisasi per venue.
 */
function resolveFundingRate(exchange, pair) {
    const coin = String(pair || 'BTCUSDT').replace('USDT', '');
    try {
        if (window.ArbitrageScanner) {
            const data = window.ArbitrageScanner.getExchangeData(exchange);
            if (data && Number.isFinite(data[coin])) return data[coin];
        }
    } catch (e) { /* noop */ }
    try {
        if (window.MarketUniverse) {
            const funding = window.MarketUniverse.getFunding(pair);
            if (funding && Number.isFinite(funding[exchange])) return funding[exchange];
        }
    } catch (e) { /* noop */ }
    return null;
}

function refreshTradeFundingRate() {
    const exSel = document.getElementById('trade-exchange');
    const rateEl = document.getElementById('trade-funding-rate');
    if (!exSel || !rateEl) return;
    const ex = exSel.value;
    let rate = resolveFundingRate(ex, AppState.g_pair || 'BTCUSDT');
    if (!Number.isFinite(rate)) rate = AppState.fusion?.funding || 0;
    if (!Number.isFinite(rate)) rate = 0;
    const cls = rate > 0 ? 'pnl-negative' : (rate < 0 ? 'pnl-positive' : 'value-strong');
    // LONG membayar fee jika rate positif (merah), SHORT menerima. Sebaliknya
    // rate negatif = LONG dibayar (hijau).
    rateEl.textContent = (rate >= 0 ? '+' : '') + (rate * 100).toFixed(4) + '%';
    rateEl.className = 'value-strong ' + cls;
}

function initApp() {
    // LOCAL ARBITRAGE: universe coin dinamis (Top N volume futures 24h yang
    // tersedia bersamaan di Binance, OKX, dan Bybit). Tidak ada daftar coin
    // yang di-hardcode — universe di-refresh berkala dan pair selector ikut
    // bertambah/berkurang mengikuti ketersediaan market di exchange.
    if (window.MarketUniverse) {
        window.MarketUniverse.start();
        window.MarketUniverse.subscribe(() => {
            populatePairDropdown();
            updateUniverseBadge();
        });
    }
    populatePairDropdown();
    syncUniverseControls();
    const savedPair = loadPreference('masako_pref_pair', null);
    const savedTf = loadPreference('masako_pref_tf', null);
    const allowedPairs = getSelectablePairs();
    const allowedTfs = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M', '1y'];
    const savedAiMode = loadPreference('masako_pref_ai_mode', 'CONS');
    const savedLev = parseInt(loadPreference('masako_pref_leverage', '25'), 10);
    const savedMarginMode = loadPreference('masako_pref_margin_mode', 'ISOLATED');
    const savedExchange = loadPreference('masako_pref_exchange', 'Binance');
    
    const nextPair = allowedPairs.includes(savedPair) ? savedPair : (window.MASAKO_DEFAULT_PAIR || 'BTCUSDT');
    const nextTf = allowedTfs.includes(savedTf) ? savedTf : '15m';
    document.getElementById('pair').value = nextPair;
    document.getElementById('tf').value = nextTf;
    const exSel = document.getElementById('trade-exchange');
    if (exSel && ['Binance', 'OKX', 'Bybit'].includes(savedExchange)) exSel.value = savedExchange;
    // normalizeTradingState already validates the stored balance. Zero is a
    // real balance (including fully reserved margin), not a reason to reset it.
    updateEquityDisplay(); 
    const lev = Number.isFinite(savedLev) ? Math.min(125, Math.max(1, savedLev)) : 25;
    document.getElementById('leverage-slider').value = lev; 
    updateLevUI(lev); 
    document.getElementById('margin-mode').value = ['CROSS', 'ISOLATED'].includes(savedMarginMode) ? savedMarginMode : 'ISOLATED';
    setAiMode(savedAiMode);
    // Boot only after DOM is parsed AND one layout frame has been produced,
    // so #chart-container measurements are meaningful on initial load.
    const bootNow = () => {
        try { changeConfig(); }
        catch (e) { console.error('initApp boot failed', e); }
    };
    const bootOnFrame = () => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(bootNow);
        else setTimeout(bootNow, 16);
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootOnFrame, { once: true });
    } else {
        bootOnFrame();
    }
}

window.setAiMode = function(mode) {
    AppState.aiMode = mode;
    safeStore('masako_pref_ai_mode', mode, APP_SCHEMA_VERSION);
    document.getElementById('mode-cons').classList.toggle('active-cons', mode === 'CONS'); 
    document.getElementById('mode-agg').classList.toggle('active-agg', mode === 'AGG');
    document.getElementById('ai-mode-desc').innerText = mode === 'CONS' ? "Delay Filter ON. Sabar." : "Delay Filter OFF. Agresif.";
};

window.changeConfig = function() {
    AppState.g_pair = document.getElementById('pair').value; 
    AppState.g_tf = document.getElementById('tf').value; 
    AppState.g_base = AppState.g_pair.replace("USDT", "");
    AppState.configSessionId += 1;

    // Cancel any in-flight boot/fetch from the previous pair/timeframe so a
    // stale async response can never overwrite the new state.
    try {
        if (window.ChartLifecycle && typeof window.ChartLifecycle.abort === 'function') {
            window.ChartLifecycle.abort('change-config');
        }
    } catch (e) { /* noop */ }

    safeStore('masako_pref_pair', AppState.g_pair, APP_SCHEMA_VERSION);
    safeStore('masako_pref_tf', AppState.g_tf, APP_SCHEMA_VERSION);
    safeStore('masako_pref_leverage', document.getElementById('leverage-slider').value, APP_SCHEMA_VERSION);
    safeStore('masako_pref_margin_mode', document.getElementById('margin-mode').value, APP_SCHEMA_VERSION);
    
    AppState.isIntentionalClose = true;
    if (MarketFeed) MarketFeed.stop();
    
    if (AppState.wsKline) { AppState.wsKline.close(); AppState.wsKline = null; }
    if (AppState.reconnectTimer) clearTimeout(AppState.reconnectTimer);
    if (AppState.retryTimer) { clearTimeout(AppState.retryTimer); AppState.retryTimer = null; }
    if (window.mtfTimer) clearInterval(window.mtfTimer);
    
    FuturesEngine.clearChartLines(); 
    FuturesEngine.posLines = {}; 
    series = {};
    candleLookupByTime.clear();
    rsiLookupByTime.clear();
    
    AppState.fusion = null; 
    AppState.price = 0; 
    AppState.venueQuotes = { BINANCE: null, BYBIT: null };
    AppState.feed = { activeVenue: 'BINANCE', primaryVenue: 'BINANCE', secondaryVenue: 'BYBIT', latencyMs: 0, spreadPct: 0, lastUpdate: 0, status: 'WAIT', sourceStatus: { BINANCE: 'DISCONNECTED', BYBIT: 'DISCONNECTED' } };
    AppState.hasMoreHistory = true;
    
    try {
        if (typeof disposeChartInstances === 'function') disposeChartInstances();
        else {
            if (typeof resizeObserver !== 'undefined' && resizeObserver) { try { resizeObserver.disconnect(); } catch (e) {} resizeObserver = null; }
            if (typeof chart !== 'undefined' && chart) { try { chart.remove(); } catch(e){} chart = null; }
            if (typeof rsiChart !== 'undefined' && rsiChart) { try { rsiChart.remove(); } catch(e){} rsiChart = null; }
            series = {};
        }
    } catch (e) { /* noop */ }
    
    document.getElementById('main-chart').replaceChildren();
    document.getElementById('rsi-chart').replaceChildren();
    
    AppState.candles = []; 
    Object.keys(AppState.indicators).forEach((key) => { AppState.indicators[key] = []; });
    AppState.volSMA = [];
    AppState.atrSMA = [];
    AppState.markers = []; 
    AppState.swings = { highs: [], lows: [] };
    if (typeof resetChartWindow === 'function') resetChartWindow();
    if (window.HistoryLoader && typeof window.HistoryLoader.abort === 'function') window.HistoryLoader.abort();
    historyExtensionRunning = false;
    AppState.hasMoreHistory = true;
    updateHistoryBadge();
    
    PolyLineManager.clear();
    // Chart creation is owned by the lifecycle boot: it waits for a valid
    // layout first, then creates the chart, fetches history, renders, fits,
    // and only then connects the realtime feed.
    refreshTradeFundingRate();
    setChartLoading(true, "Memuat chart...");
    FuturesEngine.updateUI(); 
    updatePolyButtons(); 
    triggerGlobalAlertIfNeeded(); 
    fetchDataAndStart(); 
    
    fetchMTFData();
    window.mtfTimer = setInterval(fetchMTFData, 60000);

    // Patterns belong to a pair: drop the previous pair's findings, then reload
    // the wide corpus for the new one. The interval keeps it fresh while the
    // page is open (the loader itself reuses a 10 minute cache).
    try {
        if (window.AnimalNeuralSystem && typeof window.AnimalNeuralSystem.clearPatterns === 'function') {
            window.AnimalNeuralSystem.clearPatterns();
        }
        refreshPatternPanels();
    } catch (e) { /* pattern panel is optional */ }
    if (window.patternTimer) clearInterval(window.patternTimer);
    window.patternTimer = setInterval(() => {
        if (document.hidden) return;
        loadPatternData({});
    }, PATTERN_REFRESH_MS);
    schedulePatternRefresh(3000);
};

function saveState() { 
    safeStore('masako_poly_v44', polymarketLog, APP_SCHEMA_VERSION); 
}

window.openModal = function() { 
    document.getElementById('history-modal').classList.add('active'); 
    updateLedgerUI(); 
};

window.closeModal = function(f) { 
    if (f === true || (f && f.target && f.target.id === 'history-modal')) { 
        document.getElementById('history-modal').classList.remove('active'); 
    } 
};

window.handleSetFilter = function(f, el) { 
    AppState.currentFilter = f; 
    document.querySelectorAll('#filter-tabs-modal .tab-btn').forEach(b => b.classList.remove('active')); 
    if (el) el.classList.add('active'); 
    updateLedgerUI(); 
};

window.setFuturesMode = function(mode) {
    document.getElementById('tab-manual').classList.toggle('active', mode === 'MANUAL'); 
    document.getElementById('tab-ai').classList.toggle('active', mode === 'AI');
    document.getElementById('futures-manual-btns').style.display = mode === 'MANUAL' ? 'flex' : 'none'; 
    document.getElementById('manual-tpsl-box').style.display = mode === 'MANUAL' ? 'grid' : 'none';
    document.getElementById('manual-auto-rr-box').style.display = mode === 'MANUAL' ? 'block' : 'none'; 
    document.getElementById('futures-ai-btn').style.display = mode === 'AI' ? 'block' : 'none';
    document.getElementById('ai-controls').style.display = mode === 'AI' ? 'block' : 'none';
};

window.updateLevUI = function(val) { 
    const input = document.getElementById('lev-val-input');
    if (input) input.value = val;
    const slider = document.getElementById('leverage-slider');
    if (slider && slider.value !== String(val)) slider.value = val;
};


function fetchWithTimeout(url, options = {}, timeoutMs = 15000, externalSignal = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let onExternalAbort = null;
    if (externalSignal) {
        if (externalSignal.aborted) {
            clearTimeout(timer);
            return Promise.reject(new Error('ABORTED'));
        }
        onExternalAbort = () => { try { controller.abort(); } catch (e) {} };
        try { externalSignal.addEventListener('abort', onExternalAbort, { once: true }); } catch (e) {}
    }
    const cleanup = () => {
        clearTimeout(timer);
        if (externalSignal && onExternalAbort && externalSignal.removeEventListener) {
            try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (e) {}
        }
    };
    return fetch(url, { ...options, signal: controller.signal })
        .then((res) => { cleanup(); return res; },
              (err) => { cleanup(); throw err; });
}


const PAIR_FETCH_ALERT_THRESHOLD = 3;
const PAIR_FETCH_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

function emitPairFetchAlert(pair, retryCount, failureCount, message) {
    const telemetry = AppState.telemetry || { pairFetchFailures: {}, lastPairFetchAlertAt: {} };
    const now = Date.now();
    const lastAt = telemetry.lastPairFetchAlertAt[pair] || 0;
    if (now - lastAt < PAIR_FETCH_ALERT_COOLDOWN_MS) return;
    telemetry.lastPairFetchAlertAt[pair] = now;
    AppState.telemetry = telemetry;

    const payload = {
        event: 'pair_fetch_repeated_failure',
        pair,
        retryCount,
        failureCount,
        source: 'frontend',
        message
    };

    console.error('[pair-fetch-alert]', payload);
    try {
        const body = JSON.stringify(payload);
        if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
        } else {
            fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
        }
    } catch (err) {
        console.warn('pair fetch telemetry send failed', err);
    }
}

function recordPairFetchFailure(pair, message) {
    const telemetry = AppState.telemetry || { pairFetchFailures: {}, lastPairFetchAlertAt: {} };
    const failures = telemetry.pairFetchFailures || {};
    failures[pair] = (failures[pair] || 0) + 1;
    telemetry.pairFetchFailures = failures;
    telemetry.lastPairFetchAlertAt = telemetry.lastPairFetchAlertAt || {};
    AppState.telemetry = telemetry;

    if (failures[pair] >= PAIR_FETCH_ALERT_THRESHOLD) {
        emitPairFetchAlert(pair, AppState.retryCount, failures[pair], message);
    }
}

function resetPairFetchFailure(pair) {
    const telemetry = AppState.telemetry;
    if (!telemetry || !telemetry.pairFetchFailures) return;
    telemetry.pairFetchFailures[pair] = 0;
}

function markFeedHttpError(message = 'Market data sementara tidak tersedia') {
    const feed = AppState.feed || {};
    feed.status = 'ERROR';
    feed.lastError = message;
    feed.latencyMs = Number.isFinite(feed.latencyMs) ? feed.latencyMs : 0;
    AppState.feed = feed;
    updateFeedStatus({ status: 'ERROR', activeSource: feed.activeVenue || 'BINANCE', latencyMs: feed.latencyMs, error: message });
}

const ExchangeEngine = {
    async fetchAll() {
        const reqPair = AppState.g_pair;
        try {
            const sym = reqPair;
            const [fundRes, oiRes, globRes, topRes, takerRes, exInfoRes] = await Promise.all([
                fetchWithTimeout(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`), 
                fetchWithTimeout(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`),
                fetchWithTimeout(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`), 
                fetchWithTimeout(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${sym}&period=5m&limit=1`),
                fetchWithTimeout(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=1`),
                fetchWithTimeout(`https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${sym}`)
            ]);
            
            if (AppState.g_pair !== reqPair) return;
            
            if (fundRes.ok) { const data = await fundRes.json(); AppState.fusionBase.funding = parseFloat(data.lastFundingRate || 0); AppState.fusionBase.markPrice = parseFloat(data.markPrice || AppState.price); }
            if (oiRes.ok) { const data = await oiRes.json(); AppState.fusionBase.oi = parseFloat(data.openInterest || 0); }
            if (globRes.ok) { const data = await globRes.json(); if (data.length > 0) { AppState.fusionBase.retail = parseFloat(data[0].longAccount); AppState.fusionBase.lsRatio = parseFloat(data[0].longShortRatio); } }
            if (topRes.ok) { const data = await topRes.json(); if (data.length > 0) AppState.fusionBase.smart = parseFloat(data[0].longAccount); }
            if (takerRes.ok) { const data = await takerRes.json(); if (data.length > 0) AppState.fusionBase.takerRatio = parseFloat(data[0].buySellRatio); }

            if (exInfoRes.ok) {
                const ex = await exInfoRes.json();
                const symInfo = Array.isArray(ex.symbols) ? ex.symbols[0] : null;
                if (symInfo) {
                    const pf = Number(symInfo.pricePrecision);
                    const pfSafe = Number.isFinite(pf) ? pf : 2;
                    const tickFilter = Array.isArray(symInfo.filters) ? symInfo.filters.find(f => f.filterType === 'PRICE_FILTER') : null;
                    const tickSize = tickFilter ? Number(tickFilter.tickSize) : 0.01;
                    AppState.marketMeta = { tickSize: Number.isFinite(tickSize) ? tickSize : 0.01, pricePrecision: pfSafe };
                }
            }
            
            AppState.fusionBase.conflict = Math.abs(AppState.fusionBase.retail - AppState.fusionBase.smart);
            let domScore = 0;
            if (AppState.fusionBase.retail < 0.5) domScore += 1; else domScore -= 1;
            if (AppState.fusionBase.smart > 0.5) domScore += 1; else domScore -= 1;
            if (AppState.fusionBase.takerRatio > 1) domScore += 1; else domScore -= 1;
            if (AppState.fusionBase.lsRatio < 1) domScore += 1; else domScore -= 1; 
            
            AppState.fusionBase.dominance = domScore > 0 ? "LONG" : (domScore < 0 ? "SHORT" : "NEUTRAL");
            AppState.fusion = { ...AppState.fusionBase };
        } catch (e) { 
            if (AppState.g_pair === reqPair) { AppState.fusion = { ...AppState.fusionBase }; markFeedHttpError('Orderflow Binance gagal dimuat; memakai state terakhir.'); } 
        }
    }
};

/**
 * Fetch klines dengan fallback mirror anti-blokir: bila api.binance.com mati
 * (DNS-hijack/geoblock), coba host yang sama di data-api.binance.vision
 * (shape respons identik, CORS *). Mengembalikan response-like (.ok/.json).
 */
async function fetchKlinesWithVisionFallback(url, timeoutMs) {
    const budget = Number.isFinite(timeoutMs) ? timeoutMs : 15000;
    try {
        const res = await fetchWithTimeout(url, {}, budget);
        if (res && res.ok) return res;
    } catch (e) { /* lanjut ke mirror */ }
    const mirror = String(url).replace('https://api.binance.com/', 'https://data-api.binance.vision/');
    if (mirror !== url) {
        try {
            const res2 = await fetchWithTimeout(mirror, {}, budget);
            if (res2) return res2;
        } catch (e2) { /* jatuh ke respons gagal di bawah */ }
    }
    return { ok: false, status: 0, json: async () => [] };
}

async function fetchMTFData() {
    const reqPair = AppState.g_pair;
    const reqSessionId = AppState.configSessionId;
    try {
        let res1 = await fetchKlinesWithVisionFallback(`https://api.binance.com/api/v3/klines?symbol=${reqPair}&interval=1h&limit=100`);
        if (AppState.g_pair !== reqPair || reqSessionId !== AppState.configSessionId) return;
        if (res1.ok) {
            let c1 = (await res1.json()).map(c => ({time: c[0]/1000, close: +c[4]})); 
            if (c1.length > 0) AppState.mtf['1h'] = (c1[c1.length-1].close > calcEMA(c1, 50, 'close').pop().value) ? 'UP' : 'DOWN'; 
        }
        
        let res2 = await fetchKlinesWithVisionFallback(`https://api.binance.com/api/v3/klines?symbol=${reqPair}&interval=15m&limit=100`);
        if (AppState.g_pair !== reqPair || reqSessionId !== AppState.configSessionId) return;
        if (res2.ok) {
            let c2 = (await res2.json()).map(c => ({time: c[0]/1000, close: +c[4]})); 
            if (c2.length > 0) AppState.mtf['15m'] = (c2[c2.length-1].close > calcEMA(c2, 50, 'close').pop().value) ? 'UP' : 'DOWN'; 
        }
        
        let res3 = await fetchKlinesWithVisionFallback(`https://api.binance.com/api/v3/klines?symbol=${reqPair}&interval=1d&limit=50`);
        if (AppState.g_pair !== reqPair || reqSessionId !== AppState.configSessionId) return;
        if (res3.ok) {
            let c3 = (await res3.json()).map(c => ({time: c[0]/1000, close: +c[4]})); 
            if (c3.length > 0) AppState.mtf['1d'] = (c3[c3.length-1].close > calcEMA(c3, 20, 'close').pop().value) ? 'UP' : 'DOWN'; 
        }

        const d = document.getElementById('mtf-1d');
        const h = document.getElementById('mtf-1h');
        const m = document.getElementById('mtf-15m');
        
        if (d) { d.className = 'mtf-badge-container'; d.classList.add(AppState.mtf['1d'] === 'UP' ? 'mtf-up-box' : 'mtf-dn-box'); d.innerText = AppState.mtf['1d'] === 'UP' ? 'UPTREND' : 'DOWNTREND'; }
        if (h) { h.className = 'mtf-badge-container'; h.classList.add(AppState.mtf['1h'] === 'UP' ? 'mtf-up-box' : 'mtf-dn-box'); h.innerText = AppState.mtf['1h'] === 'UP' ? 'UPTREND' : 'DOWNTREND'; }
        if (m) { m.className = 'mtf-badge-container'; m.classList.add(AppState.mtf['15m'] === 'UP' ? 'mtf-up-box' : 'mtf-dn-box'); m.innerText = AppState.mtf['15m'] === 'UP' ? 'UPTREND' : 'DOWNTREND'; }
    } catch(e) { markFeedHttpError('MTF Binance gagal dimuat; badge memakai status terakhir.'); console.warn('fetchMTFData failed', e); }
}

async function fetchCandlesWithFallback(pair, tf, opts = {}) {
    const abortSignal = opts && opts.signal ? opts.signal : null;
    // 1y tidak didukung exchange mana pun: tarik candle bulanan (1M) lalu
    // agregasi ke tahunan di akhir (HistoryLoader.aggregateYearlyRows).
    const fetchTf = tf === '1y' ? '1M' : tf;
    const endpoints = [
        `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${fetchTf}&limit=1000`,
        `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${fetchTf}&limit=1000`,
        // Mirror publik anti-blokir (lihat historyLoader.js): shape identik.
        `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${fetchTf}&limit=1000`
    ];

    let found = null;
    for (const endpoint of endpoints) {
        try {
            const res = await fetchWithTimeout(endpoint, {}, 10_000);
            if (!res.ok) continue;
            const data = await res.json();
            if (Array.isArray(data) && data.length > 0) { found = data; break; }
        } catch (e) {
            markFeedHttpError('Candle Binance gagal dimuat; mencoba sumber berikutnya.');
        }
    }

    // Fallback terakhir (legacy path): Bybit linear kline, dipetakan ke shape
    // baris Binance ascending supaya kode di bawah tidak berubah.
    // Bybit tidak punya 8h/3d/1y — untuk tf itu fallback ini dilewati
    // (bybitInterval undefined) dan Binance di atas yang menjawab.
    if (!found) {
        try {
            const bybitInterval = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M' }[tf];
            const stepMs = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '12h': 43200000, '1d': 86400000, '1w': 604800000, '1M': 2592000000 }[tf] || 900000;
            if (bybitInterval) {
                const res = await fetchWithTimeout(
                    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${pair}&interval=${bybitInterval}&limit=1000`,
                    {}, 10_000);
                if (res.ok) {
                    const raw = await res.json();
                    const list = raw && raw.result && Array.isArray(raw.result.list) ? raw.result.list : [];
                    if ((raw.retCode === 0 || raw.retCode === '0') && list.length > 0) {
                        const mapped = [];
                        for (const e of list) {
                            if (!Array.isArray(e) || e.length < 7) continue;
                            const startMs = Number(e[0]);
                            if (!Number.isFinite(startMs) || startMs <= 0) continue;
                            mapped.push([startMs, String(e[1]), String(e[2]), String(e[3]), String(e[4]),
                                String(e[5]), startMs + stepMs - 1, String(e[6] || '0'), '0', '0', '0', '0']);
                        }
                        if (mapped.length > 0) {
                            mapped.sort((a, b) => a[0] - b[0]);
                            found = mapped;
                        }
                    }
                }
            }
        } catch (e) {
            markFeedHttpError('Candle Bybit gagal dimuat.');
        }
    }

    if (!found) {
        markFeedHttpError('Candle Binance tidak tersedia; chart memakai fallback aman.');
        throw new Error('CANDLE_FETCH_FAILED');
    }
    if (tf === '1y') {
        const agg = typeof window !== 'undefined' && window.HistoryLoader && window.HistoryLoader.aggregateYearlyRows;
        if (typeof agg !== 'function') throw new Error('CANDLE_FETCH_FAILED');
        return agg(found);
    }
    return found;
}

async function fetchDataAndStart() {
    // Primary path: ordered lifecycle boot (layout -> create -> fetch ->
    // validate -> render -> fit -> loading off -> realtime feed).
    try {
        if (window.ChartLifecycle && typeof window.ChartLifecycle.boot === 'function') {
            showToast("Memuat Data Market...");
            return await window.ChartLifecycle.boot({ reason: 'fetch-data-and-start' });
        }
    } catch (e) {
        console.error('ChartLifecycle boot failed, using legacy path', e);
    }
    return fetchDataAndStartLegacy();
}

async function fetchDataAndStartLegacy() {
    showToast("Memuat Data Market...");
    setChartLoading(true, "Memuat data market...");
    const reqPair = AppState.g_pair;
    const reqTf = AppState.g_tf;
    const reqSessionId = AppState.configSessionId;
    try {
        const data = await fetchCandlesWithFallback(reqPair, reqTf);
        if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf || reqSessionId !== AppState.configSessionId) return;
        let uniqueCandles = [];
        let seenTimes = new Set();
        
        for (let c of data) { 
            let time = c[0]/1000; 
            if (!seenTimes.has(time)) { 
                seenTimes.add(time); 
                uniqueCandles.push({ time: time, open: +c[1], high: +c[2], low: +c[3], close: +c[4], vol: +c[5], takerVol: +c[9] }); 
            } 
        }
        
        AppState.candles = uniqueCandles.sort((a,b) => a.time - b.time);
        if (AppState.candles.length > 0) {
            AppState.price = AppState.candles[AppState.candles.length - 1].close;
            AppState.lastPrices[AppState.g_pair] = AppState.price;
            AppState.feed.lastUpdate = Date.now();
        }

        FuturesEngine.checkOfflineHits();
        await ExchangeEngine.fetchAll();
        if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf || reqSessionId !== AppState.configSessionId) return;

        // Legacy fallback: render synchronously FIRST, fitContent only after
        // candles are inside the series (never before data lands).
        let rendered = false;
        try {
            if (typeof renderFullChart === 'function') rendered = renderFullChart() !== false;
        } catch (renderErr) {
            console.error('Legacy render failed', renderErr);
        }
        if (!rendered) throw new Error('RENDER_FAILED');
        if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf || reqSessionId !== AppState.configSessionId) return;
        try {
            if (typeof chart !== 'undefined' && chart && chart.timeScale) chart.timeScale().fitContent();
        } catch (fitErr) { /* non-fatal */ }
        setChartLoading(false);
        try { connectWebSocket(); } catch (wsErr) { console.warn('Legacy WS connect failed', wsErr); }
        AppState.retryCount = 0;
        resetPairFetchFailure(reqPair);
    } catch(e) {
        if (e && e.message === 'ABORTED') return;
        if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf || reqSessionId !== AppState.configSessionId) return;
        AppState.retryCount++;
        recordPairFetchFailure(reqPair, e && e.message ? e.message : 'Candle fetch failed');
        const delay = Math.min(3000 * AppState.retryCount, 15000);
        showToast(`Koneksi gagal. Coba lagi ${delay/1000}s...`, true);
        setChartLoading(true, `Koneksi gagal, retry ${delay/1000}s...`);
        if (AppState.retryTimer) clearTimeout(AppState.retryTimer);
        AppState.retryTimer = setTimeout(() => {
            if (reqSessionId !== AppState.configSessionId) return;
            fetchDataAndStartLegacy();
        }, delay);
    }
}

/* ----------------------------------------------------------------------
 * Historical context extension (item: wide history for the animal brain).
 *
 * The first page is loaded by the chart lifecycle so the chart paints as soon
 * as possible. Afterwards the remaining context is fetched page by page in the
 * background. Only ONE indicator rebuild is performed, at the end of the run,
 * so the chart is never blocked repeatedly while the context grows.
 * -------------------------------------------------------------------- */
let historyExtensionRunning = false;
let historyRebuildQueued = false;

function scheduleIndicatorRebuild() {
    if (historyRebuildQueued) return;
    historyRebuildQueued = true;
    const run = () => {
        historyRebuildQueued = false;
        if (AppState.candles.length === 0) return;
        try {
            calculateAllIndicators();
            rebuildCandleLookup(AppState.candles);
            renderFullChart();
            updateHistoryBadge();
        } catch (e) {
            console.error('Indicator rebuild after history extension failed', e);
        }
    };
    // Idle-time execution keeps the rebuild off the interactive frame budget.
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 120);
}

function updateHistoryBadge() {
    const HL = window.HistoryLoader;
    if (!HL) return;
    const st = HL.getState();
    AppState.history = {
        target: st.maxCandles,
        loaded: AppState.candles.length,
        pages: st.pages,
        hasMore: st.hasMore,
        loading: st.loading
    };
    AppState.hasMoreHistory = st.hasMore || AppState.candles.length < getChartWindowCount();
    const el = document.getElementById('badge-history');
    if (el) {
        el.textContent = st.loading
            ? `History: ${AppState.candles.length}/${st.maxCandles}`
            : `History: ${AppState.candles.length}`;
        el.title = st.hasMore
            ? 'Konteks historis engine masih diperluas di latar belakang.'
            : 'Konteks historis engine lengkap untuk pair/timeframe ini.';
    }
}

/** Called by ChartLifecycle once the chart is live. */
window.onChartLive = function onChartLive(info) {
    const HL = window.HistoryLoader;
    if (!HL) return;
    updateHistoryBadge();
    // Wide-context pattern data is a background task: the chart is already
    // live, so it must never block or delay the first paints.
    schedulePatternRefresh(2500);
    if (historyExtensionRunning) return;
    if (!HL.getState().hasMore) return;

    const session = (info && Number.isFinite(info.historySession))
        ? info.historySession
        : (window.ChartLifecycle && window.ChartLifecycle.getHistorySession
            ? window.ChartLifecycle.getHistorySession() : HL.getState().session);
    const reqPair = AppState.g_pair;
    const reqTf = AppState.g_tf;

    historyExtensionRunning = true;
    const idleStart = () => {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 });
        else setTimeout(start, 400);
    };
    const start = () => {
        if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf) {
            historyExtensionRunning = false;
            return;
        }
        HL.loadOlder(() => AppState.candles, null, {
            session: session,
            pair: reqPair,
            tf: reqTf,
            target: HL.MAX_CANDLES
        }).then((result) => {
            historyExtensionRunning = false;
            if (!result || !result.ok) {
                updateHistoryBadge();
                return;
            }
            if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf) return;
            // Merge (not assign): live ticks may have arrived while loading.
            const merged = HL.mergeCandles(AppState.candles, result.candles || []);
            const trimmed = HL.trimToMax(merged.candles);
            AppState.candles = trimmed.candles;
            // calculateAllIndicators() rebuilds every parallel array (indicators,
            // volSMA, atrSMA, swings, rsi lookup) from the new candle array, so
            // no manual index bookkeeping is needed here.
            scheduleIndicatorRebuild();
        }).catch((err) => {
            historyExtensionRunning = false;
            console.warn('History extension failed', err);
            updateHistoryBadge();
        });
    };
    idleStart();
};

/** On-demand page fetch used when the rendered window is fully consumed. */
function requestMoreHistory() {
    const HL = window.HistoryLoader;
    if (!HL || AppState.isFetchingHistory) return;
    const st = HL.getState();
    if (!st.hasMore || st.loading) return;

    const reqPair = AppState.g_pair;
    const reqTf = AppState.g_tf;
    AppState.isFetchingHistory = true;
    showToast('Memuat history...', false);

    HL.loadOlder(() => AppState.candles, null, {
        session: st.session,
        pair: reqPair,
        tf: reqTf,
        target: HL.MAX_CANDLES
    }).then((result) => {
        AppState.isFetchingHistory = false;
        if (AppState.g_pair !== reqPair || AppState.g_tf !== reqTf) return;
        if (!result || !result.ok) {
            updateHistoryBadge();
            return;
        }
        const merged = HL.mergeCandles(AppState.candles, result.candles || []);
        const trimmed = HL.trimToMax(merged.candles);
        const added = merged.added;
        AppState.candles = trimmed.candles;
        scheduleIndicatorRebuild();
        if (added > 0) {
            // Immediately show what was just fetched.
            extendChartWindow(Math.min(added, CHART_WINDOW_STEP));
            renderChartWindow({ preserveRange: true, addedBars: 0 });
        }
        updateHistoryBadge();
    }).catch((err) => {
        AppState.isFetchingHistory = false;
        console.error('Fetch history failed', err);
    });
}


function connectWebSocket() {
    if (!MarketFeed) return;
    try {
        MarketFeed.start({
            pair: AppState.g_pair,
            tf: AppState.g_tf,
            history: AppState.candles
        });
    } catch (e) {
        console.warn('MarketFeed start failed; chart keeps historical data', e);
        markFeedHttpError('Realtime feed gagal tersambung; chart memakai data historis.');
    }
}



function syncReturnToLiveButton() {
    const btn = document.getElementById('chart-jump-right');
    if (!btn || !chart) return;
    const range = chart.timeScale().getVisibleLogicalRange();
    const bars = AppState.candles.length;
    if (!range || !Number.isFinite(range.to) || bars < 5) {
        btn.classList.remove('show');
        return;
    }
    const distanceToRight = (bars - 1) - range.to;
    btn.classList.toggle('show', distanceToRight > 8);
}

window.jumpChartToRealtime = function() {
    isUserPanningChart = false;
    if (typeof smoothScrollToRealtime === 'function') smoothScrollToRealtime(true);
    syncReturnToLiveButton();
};

/* ----------------------------------------------------------------------
 * Live tick handling.
 *
 * The WebSocket emits one message per aggregated trade, which on an active
 * pair is easily dozens per second. State is updated on every tick (so nothing
 * is lost), but every DOM write and chart-series update is coalesced into a
 * single animation frame. This is what keeps panning smooth while the feed is
 * live: at most one chart update per frame instead of one per trade.
 * -------------------------------------------------------------------- */
const TICK = {
    queued: false,
    candle: null,
    lastPolyUpdateAt: 0,
    priceFlashTimer: null,
    priceFlashUntil: 0
};
const POLY_OVERLAY_MIN_INTERVAL_MS = 500;

function flushLiveTick() {
    TICK.queued = false;
    const liveC = TICK.candle;
    TICK.candle = null;
    if (!liveC) return;

    if (series && series.candle) {
        try { series.candle.update(liveC); } catch (e) { /* series not ready */ }
    }
    const isUp = liveC.close >= liveC.open;
    if (series && series.vol) {
        try {
            series.vol.update({
                time: liveC.time,
                value: liveC.vol,
                color: isUp ? 'rgba(74, 222, 128, 0.3)' : 'rgba(248, 113, 113, 0.3)'
            });
        } catch (e) { /* series not ready */ }
    }

    // Price readout. One reusable timer for the colour flash instead of a new
    // setTimeout per tick (the old code created one timer per trade, which was
    // both a CPU cost and an unbounded timer leak under a busy feed).
    const pEl = document.getElementById('price');
    if (pEl) {
        pEl.textContent = formatPrice(AppState.price);
        pEl.classList.toggle('price-up', isUp);
        pEl.classList.toggle('price-down', !isUp);
        TICK.priceFlashUntil = Date.now() + 300;
        if (TICK.priceFlashTimer === null) schedulePriceFlashReset();
    }
}

function schedulePriceFlashReset() {
    const wait = Math.max(0, TICK.priceFlashUntil - Date.now());
    TICK.priceFlashTimer = setTimeout(function resetPriceFlash() {
        TICK.priceFlashTimer = null;
        if (Date.now() < TICK.priceFlashUntil) {
            schedulePriceFlashReset();
            return;
        }
        const el = document.getElementById('price');
        if (el) el.classList.remove('price-up', 'price-down');
    }, wait);
}

function scheduleLiveTickFlush() {
    if (TICK.queued) return;
    TICK.queued = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushLiveTick);
    else setTimeout(flushLiveTick, 16);
}

function updatePolyOverlaysThrottled() {
    const now = Date.now();
    if (now - TICK.lastPolyUpdateAt < POLY_OVERLAY_MIN_INTERVAL_MS) return;
    TICK.lastPolyUpdateAt = now;
    const nowSec = Math.floor(now / 1000);
    polymarketLog.forEach((p) => {
        if (p.status !== 'PENDING' || p.pair !== AppState.g_pair) return;
        PolyLineManager.update(p, AppState.price);
        if (nowSec >= p.targetTime) {
            const isWin = (p.direction === 'LONG' && AppState.price >= p.startPrice)
                || (p.direction === 'SHORT' && AppState.price <= p.startPrice);
            p.status = isWin ? 'CORRECT' : 'WRONG';
            PolyLineManager.update(p, AppState.price);
            saveState();
            updatePolyButtons();
            updateLedgerUI();
            showToast(`Prediksi ${p.tfLabel} ${p.direction} selesai: ${p.status}`);
        }
    });
}

function updateLiveTick(liveC, meta = {}) {
    if (!liveC || AppState.candles.length === 0) return;
    const lastIdx = AppState.candles.length - 1;
    const lastTime = AppState.candles[lastIdx].time;

    if (liveC.time < lastTime) return;

    setChartLoading(false);
    AppState.price = liveC.close;
    AppState.lastPrices[AppState.g_pair] = AppState.price;
    AppState.live.price = AppState.price;
    // Keep on-chart positions' lastKnownPrice fresh too (pairs with positions
    // but no chart rely on the off-chart poller; this covers the charted pair).
    if (typeof FuturesEngine !== 'undefined' && FuturesEngine.state && FuturesEngine.state.positions) {
        FuturesEngine.state.positions.forEach((p) => {
            if (p && p.pair === AppState.g_pair) p.lastKnownPrice = AppState.price;
        });
    }

    if (meta && typeof meta === 'object') {
        if (meta.activeSource) AppState.feed.activeVenue = meta.activeSource;
        if (Number.isFinite(meta.latencyMs)) AppState.feed.latencyMs = meta.latencyMs;
        if (Number.isFinite(meta.spreadPct)) AppState.feed.spreadPct = meta.spreadPct;
        if (meta.sourceQuotes) AppState.venueQuotes = meta.sourceQuotes;
        AppState.feed.lastUpdate = Date.now();
        AppState.feed.status = meta.status || AppState.feed.status || 'LIVE';
        updateFeedStatus(meta);
    }

    // SL/TP evaluation stays per tick so simulation accuracy is preserved;
    // it is O(open positions) with at most a handful of positions.
    FuturesEngine.updateLivePNL(AppState.price);

    const isNew = liveC.time > lastTime;
    if (isNew) {
        AppState.candles.push(liveC);
        candleLookupByTime.set(liveC.time, liveC);
        const maxCandles = (window.HistoryLoader && window.HistoryLoader.MAX_CANDLES) || 5000;
        if (AppState.candles.length > maxCandles) {
            const removed = AppState.candles.shift();
            if (removed) candleLookupByTime.delete(removed.time);
            Object.keys(AppState.indicators).forEach((key) => {
                if (Array.isArray(AppState.indicators[key]) && AppState.indicators[key].length > AppState.candles.length) AppState.indicators[key].shift();
            });
            if (AppState.volSMA.length > AppState.candles.length) AppState.volSMA.shift();
            if (AppState.atrSMA.length > AppState.candles.length) AppState.atrSMA.shift();
            // State incremental ikut dipangkas agar update tick berikutnya tetap O(1) tanpa rebuild penuh.
            if (typeof pruneIncrementalIndicatorState === 'function') pruneIncrementalIndicatorState(AppState.candles.length);
        }
        if (AppState.swings.highs.length > 400) AppState.swings.highs.shift();
        if (AppState.swings.lows.length > 400) AppState.swings.lows.shift();
        AppState.live.prevSignal = AppState.live.signal;
        if (meta && meta.status === 'SWITCHED') scheduleChartRender(true);
    } else {
        AppState.candles[lastIdx] = liveC;
        candleLookupByTime.set(liveC.time, liveC);
    }

    if (liveC.vol > 0 && liveC.takerVol) {
        const lTR = liveC.takerVol / liveC.vol;
        const str = Math.min(1, liveC.vol / (AppState.volSMA[lastIdx] || 1));
        const dev = (lTR - 0.5) * str * 0.2;

        if (!AppState.fusion) AppState.fusion = { ...AppState.fusionBase };
        AppState.fusion.retail = Math.max(0.01, Math.min(0.99, AppState.fusionBase.retail - dev));
        AppState.fusion.smart = Math.max(0.01, Math.min(0.99, AppState.fusionBase.smart + dev));
        AppState.fusion.takerRatio = lTR;
    }

    // Chart + DOM updates for this tick: coalesced into one frame.
    TICK.candle = liveC;
    scheduleLiveTickFlush();
    updatePolyOverlaysThrottled();

    const now = Date.now();
    if (liveC.isClosed || now - AppState.lastMathTime > 1200) {
        AppState.lastMathTime = now;
        try { calculateIndicatorsIncremental(); }
        catch (mathErr) { console.error('Incremental indicators failed', mathErr); }

        try {
            const lIdx = AppState.indicators.e200.length - 1;
            if (lIdx >= 0 && series) {
                if (AppState.indicators.rsi[lIdx] && series.rsi) {
                    try { series.rsi.update(AppState.indicators.rsi[lIdx]); } catch (e) {}
                }
                if (AppState.indicators.stochK[lIdx] && series.stochK) {
                    try { series.stochK.update(AppState.indicators.stochK[lIdx]); } catch (e) {}
                }
                if (AppState.indicators.stochD[lIdx] && series.stochD) {
                    try { series.stochD.update(AppState.indicators.stochD[lIdx]); } catch (e) {}
                }
                if (AppState.indicators.wr[lIdx] && series.wr) {
                    try { series.wr.update(AppState.indicators.wr[lIdx]); } catch (e) {}
                }
            }
            const res = IntelligenceEngine.analyze(AppState.candles.length - 1);
            AppState.live = { ...AppState.live, ...res };
            try {
                const moonIndicator = window.MoonSignalIndicator;
                const moonMarker = moonIndicator && typeof moonIndicator.observe === 'function'
                    ? moonIndicator.observe(res, AppState.g_pair, liveC, Date.now())
                    : null;
                if (moonMarker && typeof scheduleChartRender === 'function') scheduleChartRender(true);
            } catch (moonError) { /* signal overlay must never interrupt trading analysis */ }
            applyUIVisuals(AppState.live);
            // Auto Backtest AI: evaluates the fresh signal and, when the user
            // enabled it (login required), opens a demo position itself.
            try {
                if (window.AutoBacktestAI && typeof window.AutoBacktestAI.evaluate === 'function') {
                    window.AutoBacktestAI.evaluate({ isNewCandle: !!isNew });
                    // Forward the live signal so the server-side engine can act
                    // within seconds. The server still owns every entry/exit;
                    // this is telemetry, throttled inside AutoBacktestAI.
                    if (typeof window.AutoBacktestAI.pushSignalToServer === 'function') {
                        window.AutoBacktestAI.pushSignalToServer(window.AutoBacktestAI.readSignal());
                    }
                }
            } catch (abtErr) { /* automated engine is optional */ }
            // Secondary analysis path: never allowed to break the chart/tick loop.
            try {
                if (window.AnimalNeuralSystem && typeof window.AnimalNeuralSystem.onMarketUpdate === 'function') {
                    window.AnimalNeuralSystem.onMarketUpdate({ isNewCandle: !!isNew, meta: meta || {} });
                }
            } catch (neuralErr) { console.warn('AnimalNeuralSystem update skipped', neuralErr); }
            try {
                if (window.NeuralUI && typeof window.NeuralUI.scheduleUpdate === 'function') {
                    window.NeuralUI.scheduleUpdate();
                }
            } catch (uiErr) { /* noop */ }
        } catch (analyzeErr) {
            console.error('Live analysis failed', analyzeErr);
        }
    }
}

window.runBacktestEngine = function() {
    if (AppState.candles.length < 100) { showToast("Data History tidak cukup untuk Backtest", true); return; }
    showToast("Menjalankan OOS Backtest...", false);
    
    let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, peakCap = 1000, cap = 1000, maxDD = 0;
    let oosStartIndex = AppState.candles.length - 100, oosWins = 0, oosLosses = 0;
    
    for (let i = 50; i < AppState.candles.length - 1; i++) {
        const result = IntelligenceEngine.analyze(i);
        if (result.signal === "STRONG BUY" || result.signal === "STRONG SELL") {
            let entryPrice = AppState.candles[i].close;
            let isLong = result.signal === "STRONG BUY";
            
            entryPrice = isLong ? entryPrice*(1+FEES.SLIPPAGE) : entryPrice*(1-FEES.SLIPPAGE);
            let atr = AppState.atrSMA[i] || (entryPrice*0.01);
            let tpPrice = isLong ? entryPrice + (atr*2) : entryPrice - (atr*2);
            let slPrice = isLong ? entryPrice - atr : entryPrice + atr;
            
            let hitTp = false, hitSl = false, exitPrice = entryPrice;

            for (let j = i+1; j < Math.min(i+15, AppState.candles.length); j++) {
                let futureC = AppState.candles[j];
                if (isLong) { 
                    if (futureC.low <= slPrice) { hitSl = true; exitPrice = slPrice; break; } 
                    if (futureC.high >= tpPrice) { hitTp = true; exitPrice = tpPrice; break; } 
                } else { 
                    if (futureC.high >= slPrice) { hitSl = true; exitPrice = slPrice; break; } 
                    if (futureC.low <= tpPrice) { hitTp = true; exitPrice = tpPrice; break; } 
                }
            }
            
            if (!hitTp && !hitSl && i+15 < AppState.candles.length) exitPrice = AppState.candles[i+15].close; 
            exitPrice = isLong ? exitPrice*(1-FEES.SLIPPAGE) : exitPrice*(1+FEES.SLIPPAGE);

            let rawPnl = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
            let pnlPct = rawPnl / entryPrice;
            let pnl = pnlPct - (FEES.TAKER * 2); 
            let pnlAbs = pnl * cap;
            
            if (pnl > 0) { 
                wins++; grossWin += pnlAbs; cap += pnlAbs; 
                if (i >= oosStartIndex) oosWins++; 
            } else { 
                losses++; grossLoss += Math.abs(pnlAbs); cap += pnlAbs; 
                if (i >= oosStartIndex) oosLosses++; 
            }

            if (cap > peakCap) peakCap = cap; 
            let dd = safeDiv((peakCap - cap), peakCap); 
            if (dd > maxDD) maxDD = dd;
            i += 10; 
        }
    }
    
    let total = oosWins + oosLosses;
    let oosWr = total > 0 ? (oosWins/total)*100 : 0;
    let pf = grossLoss > 0 ? safeDiv(grossWin, grossLoss) : (grossWin > 0 ? 99 : 0);
    let exp = total > 0 ? safeDiv((grossWin - grossLoss), total) : 0;
    
    setSafeText('bt-wr', oosWr.toFixed(1) + "%", oosWr > 50 ? 'var(--color-correct)' : 'var(--color-wrong)'); 
    setSafeText('bt-pf', pf.toFixed(2), pf > 1.2 ? 'var(--color-correct)' : 'var(--color-wrong)'); 
    setSafeText('bt-exp', "$" + exp.toFixed(2), exp > 0 ? 'var(--color-correct)' : 'var(--color-wrong)'); 
    setSafeText('bt-dd', "-" + (maxDD*100).toFixed(1) + "%");
}

function calcLiveWR(binType, logType) {
    const nowMs = Date.now(), ms1D = 86400000; 
    let startMs, endMs = nowMs;
    
    if (binType === 'DAILY') startMs = nowMs - ms1D; 
    else if (binType === 'WEEKLY') startMs = nowMs - (7 * ms1D); 
    else if (binType === 'MONTHLY') startMs = nowMs - (30 * ms1D);
    
    let targetLogs = logType === 'FUTURES' ? futuresLog : polymarketLog;
    let isSec = logType === 'POLY';
    
    let logs = targetLogs.filter(p => {
        if (p.pair !== AppState.g_pair) return false;
        if (p.status === 'PENDING' || p.status === 'CANCELLED') return false;
        let logTime = isSec ? p.requestTime * 1000 : (p.closeTime || p.openTime); 
        return logTime >= startMs && logTime <= endMs;
    });
    
    if (logs.length === 0) return "0%"; 
    let wins = logType === 'FUTURES' ? logs.filter(p => p.pnl > 0).length : logs.filter(p => p.status === 'CORRECT').length;
    return ((wins / logs.length) * 100).toFixed(0) + "%";
}

function createLedgerElement(tag, { className = '', text = '', attrs = {} } = {}) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = String(text);
    Object.entries(attrs).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        element.setAttribute(key, String(value));
    });
    return element;
}

function appendLedgerChildren(parent, children) {
    children.filter(Boolean).forEach(child => parent.appendChild(child));
    return parent;
}

function createLedgerMetric(label, value, valueClass = 'value-strong') {
    const metric = document.createElement('div');
    appendLedgerChildren(metric, [
        createLedgerElement('div', { className: 'position-detail-label', text: label }),
        createLedgerElement('div', { className: valueClass, text: value })
    ]);
    return metric;
}

function createFuturesLedgerItem(f) {
    const isWin = f.pnl > 0;
    const isBE = f.pnl === 0;
    const sClass = f.status === 'LIQ' ? 'status-loss' : (isWin ? 'status-win' : (isBE ? 'status-be' : 'status-loss'));
    const sText = f.status === 'LIQ' ? 'LIQUIDATED' : (isWin ? 'WIN' : (isBE ? 'BE' : 'LOSS'));
    const pnlPct = ((f.pnl / f.margin) * 100).toFixed(1);
    // Penanda copy trade (2026-11-02, permintaan user): entry copy tampil
    // "Copy Trade" di Reason + pill COPY di header, supaya jelas bedanya
    // dengan posisi manual. Deteksi mencakup entry lama yang hanya punya
    // closeReason COPY_* (lihat isCopyTradeLedgerEntry di utils/trading).
    const isCopyTrade = isCopyTradeLedgerEntry(f);
    const closeReasonDisplay = ledgerReasonText(f);
    const aiDisplay = isCopyTrade ? 'Copy Trade' : (f.dominantStrategy || 'Manual');
    const item = createLedgerElement('div', { className: 'memory-item' });
    // Tombol X hapus history per item (user request 2026-10-09)
    const delBtn = createLedgerElement('button', {
        className: 'ledger-delete-btn',
        text: '✕',
        attrs: { type: 'button', title: 'Hapus history ini', 'aria-label': `Hapus history ${f.pair} ${f.type}` }
    });
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof window.deleteLedgerEntry === 'function') window.deleteLedgerEntry('FUTURES', f.id, item);
    });
    item.appendChild(delBtn);
    const header = createLedgerElement('div', { className: 'mem-header' });
    const pair = createLedgerElement('span', { className: 'position-pair', text: `${f.pair} ` });
    pair.appendChild(createLedgerElement('span', {
        className: f.type === 'LONG' ? 'market-long' : 'market-short',
        text: `[${f.type} ${f.leverage}x]`
    }));
    const statusSuffix = f.status !== 'LIQ' && !String(f.status).includes('CLOSED') ? ` (${f.status})` : '';
    appendLedgerChildren(header, [
        pair,
        isCopyTrade ? createLedgerElement('span', { className: 'position-mode-pill wt-copy-pill', text: 'COPY' }) : null,
        createLedgerElement('span', { className: `mem-status ${sClass}`, text: `${sText}${statusSuffix}` })
    ]);
    const meta = createLedgerElement('div', { className: 'mem-struct mem-struct-single' });
    meta.appendChild(createLedgerElement('div', {
        className: 'mem-meta',
        text: `Time: ${formatFullDate(f.closeTime)} | AI: ${aiDisplay} | Reason: ${closeReasonDisplay}`
    }));
    const prices = createLedgerElement('div', { className: 'mem-struct' });
    appendLedgerChildren(prices, [
        createLedgerMetric('ENTRY', formatPrice(f.entryPrice)),
        createLedgerMetric('EXIT', formatPrice(f.exitPrice))
    ]);
    const footer = createLedgerElement('div', { className: 'flex-between u-mt-4' });
    const pnlText = createLedgerElement('span', { className: 'pnl-text', text: 'PNL: ' });
    pnlText.appendChild(createLedgerElement('span', {
        className: `pnl-amount ${f.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`,
        text: `${f.pnl >= 0 ? '+' : ''}$${f.pnl.toFixed(2)} (${f.pnl >= 0 ? '+' : ''}${pnlPct}%)`
    }));
    footer.appendChild(pnlText);
    appendLedgerChildren(item, [header, meta, prices, footer]);
    return item;
}

function createPolyLedgerItem(p) {
    let sClass = 'status-run';
    let sText = 'RUNNING';
    if (p.status === 'CORRECT') { sClass = 'status-win'; sText = 'WIN'; }
    else if (p.status === 'WRONG') { sClass = 'status-loss'; sText = 'LOSS'; }
    else if (p.status === 'CANCELLED') { sClass = 'status-be'; sText = 'BATAL'; }

    const item = createLedgerElement('div', { className: 'memory-item' });
    // Tombol X hapus history per item — hanya untuk yang sudah selesai (bukan PENDING)
    if (p.status !== 'PENDING') {
        const delBtn = createLedgerElement('button', {
            className: 'ledger-delete-btn',
            text: '✕',
            attrs: { type: 'button', title: 'Hapus history ini', 'aria-label': `Hapus prediksi ${p.pair} ${p.tfLabel}` }
        });
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof window.deleteLedgerEntry === 'function') window.deleteLedgerEntry('POLY', p.id, item);
        });
        item.appendChild(delBtn);
    }
    const header = createLedgerElement('div', { className: 'mem-header' });
    const pair = createLedgerElement('span', { className: 'position-pair', text: `${p.pair} ${p.tfLabel} ` });
    pair.appendChild(createLedgerElement('span', {
        className: p.direction === 'LONG' ? 'market-long' : 'market-short',
        text: `[${p.direction}]`
    }));
    header.appendChild(pair);
    const struct = createLedgerElement('div', { className: 'mem-struct' });
    appendLedgerChildren(struct, [
        createLedgerMetric('ENTRY', formatPrice(p.startPrice)),
        createLedgerMetric('TARGET', new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date(p.targetTime * 1000)), 'position-detail-value')
    ]);
    const footer = createLedgerElement('div', { className: 'flex-between u-mt-4' });
    const status = createLedgerElement('span', { className: `mem-status ${sClass}`, text: sText });
    if (p.status === 'PENDING') {
        status.appendChild(document.createTextNode(' '));
        status.appendChild(createLedgerElement('button', {
            className: 'cancel-prediction-btn',
            text: '✖',
            attrs: { type: 'button', 'data-cancel-prediction-id': p.id, 'aria-label': 'Batalkan prediksi' }
        }));
    }
    footer.appendChild(status);
    appendLedgerChildren(item, [header, struct, footer]);
    return item;
}

/* ------------------------------------------------------------------ *
 * Posisi Aktif (Trading Ledger)
 * Every coin that has open positions, grouped per coin, with live PNL,
 * "Close Semua" (closes every position of that coin) and "Lihat Chart".
 * ------------------------------------------------------------------ */

const ActivePositionsUI = {
    signature: null,
    refs: { positions: new Map(), groups: new Map(), total: null },
    lastPaint: 0,
    closing: false
};
const ACTIVE_POS_MIN_INTERVAL_MS = 250;
const ACTIVE_POS_CONFIRM_MS = 4000;

function formatPanelPrice(price, pair) {
    if (pair === AppState.g_pair) return formatPrice(price);
    const abs = Math.abs(Number(price));
    if (!Number.isFinite(abs)) return '0';
    const decimals = abs >= 1000 ? 2 : (abs >= 1 ? 4 : (abs >= 0.0001 ? 6 : 8));
    return Number(price).toFixed(decimals).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function pnlClass(value) {
    return value >= 0 ? 'pnl-positive' : 'pnl-negative';
}

function paintActivePnl(el, pnl, pct = null) {
    if (!el) return;
    el.textContent = pct === null ? formatSignedUsd(pnl) : `${formatSignedUsd(pnl)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
    el.classList.remove('pnl-positive', 'pnl-negative');
    el.classList.add(pnlClass(pnl));
}

function createActivePositionRow(pos, refs) {
    const row = createLedgerElement('div', { className: 'active-pos-row' });
    const mode = pos.marginMode === 'CROSS' ? 'Cross' : 'Isolated';
    const side = createLedgerElement('div', { className: 'active-pos-side' });
    const sideChildren = [
        createLedgerElement('span', {
            className: pos.type === 'LONG' ? 'market-long' : 'market-short',
            text: pos.type
        }),
        createLedgerElement('span', { className: 'position-mode-pill', text: `${pos.leverage}x ${mode}` })
    ];
    if (pos.origin === 'COPY_TRADE') {
        sideChildren.push(createLedgerElement('span', { className: 'position-mode-pill wt-copy-pill', text: 'COPY' }));
    }
    appendLedgerChildren(side, sideChildren);
    const prices = createLedgerElement('div', { className: 'active-pos-prices' });
    const markEl = createLedgerElement('span', { className: 'active-pos-mark', text: '-' });
    appendLedgerChildren(prices, [
        createLedgerElement('span', { className: 'active-pos-muted', text: `Entry ${formatPanelPrice(pos.entryPrice, pos.pair)}` }),
        createLedgerElement('span', { className: 'active-pos-muted', text: ' → ' }),
        markEl
    ]);
    const pnlEl = createLedgerElement('div', { className: 'active-pos-pnl', text: '$0.00' });
    appendLedgerChildren(row, [side, prices, pnlEl]);
    // Waktu open posisi — untuk melihat open-nya telat atau tidak.
    // Posisi COPY: bandingkan dengan waktu buka wallet target (copyMeta.targetOpenTime).
    const openTs = Number(pos.openTime);
    let timeText = '🕐 Open ' + formatClockTime(openTs);
    let timeTitle = 'Posisi dibuka: ' + formatFullTime(openTs);
    if (pos.origin === 'COPY_TRADE' && pos.copyMeta && Number(pos.copyMeta.targetOpenTime)) {
        const targetTs = Number(pos.copyMeta.targetOpenTime);
        const lagS = Math.max(0, Math.round((openTs - targetTs) / 1000));
        timeText += ' · target ' + formatClockTime(targetTs) + ' · ' + (lagS <= 2 ? 'pas ✅' : 'telat ' + lagS + ' dtk ⏳');
        timeTitle += '\nWallet target buka: ' + formatFullTime(targetTs) + '\nKeterlambatan mirror: ' + lagS + ' detik';
    }
    const timeEl = createLedgerElement('div', {
        className: 'active-pos-time',
        text: timeText,
        attrs: { title: timeTitle, style: 'grid-column: 1 / -1;' }
    });
    row.appendChild(timeEl);
    refs.positions.set(String(pos.id), { mark: markEl, pnl: pnlEl, pos });
    return row;
}

// Jam HH:MM:SS lokal untuk baris posisi aktif.
function formatClockTime(ts) {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '—';
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function formatFullTime(ts) {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '—';
    try {
        return d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) {
        return d.toString();
    }
}

function createActiveGroup(group, refs) {
    const isCharted = group.pair === AppState.g_pair;
    const card = createLedgerElement('div', { className: `active-pos-group${isCharted ? ' is-charted' : ''}` });

    const longs = group.positions.filter((p) => p.type === 'LONG').length;
    const shorts = group.positions.length - longs;
    const head = createLedgerElement('div', { className: 'active-pos-head' });
    const title = createLedgerElement('div', { className: 'active-pos-coin' });
    appendLedgerChildren(title, [
        createLedgerElement('span', { className: 'position-pair', text: group.pair.replace(/USDT$/, '') }),
        createLedgerElement('span', {
            className: 'active-pos-count',
            text: `${group.positions.length} Posisi Aktif`
        }),
        createLedgerElement('span', { className: 'active-pos-split', text: `${longs} Long · ${shorts} Short` })
    ]);
    const groupPnl = createLedgerElement('div', { className: 'active-pos-pnl active-pos-group-pnl', text: '$0.00' });
    appendLedgerChildren(head, [title, groupPnl]);
    refs.groups.set(group.pair, { pnl: groupPnl, group });

    const list = createLedgerElement('div', { className: 'active-pos-rows' });
    group.positions.forEach((pos) => list.appendChild(createActivePositionRow(pos, refs)));

    const actions = createLedgerElement('div', { className: 'active-pos-actions' });
    // Teks tombol disesuaikan jumlah posisi biar nggak ambigu (user request 2026-10-12)
    const closeBtnText = group.positions.length > 1 ? `Close ${group.positions.length} Posisi` : 'Close Posisi';
    appendLedgerChildren(actions, [
        createLedgerElement('button', {
            className: 'active-pos-btn active-pos-btn-danger',
            text: closeBtnText,
            attrs: { type: 'button', 'data-active-pos-action': 'close-all', 'data-pair': group.pair }
        }),
        createLedgerElement('button', {
            className: 'active-pos-btn active-pos-btn-chart',
            text: isCharted ? '📈 Lihat Chart (aktif)' : '📈 Lihat Chart',
            attrs: { type: 'button', 'data-active-pos-action': 'view-chart', 'data-pair': group.pair }
        })
    ]);
    appendLedgerChildren(card, [head, list, actions]);
    return card;
}

function renderCopyTradeLedgerSection() {
    const host = document.getElementById('wt-ledger-copy-section');
    if (!host) return;
    const info = (typeof window !== 'undefined' && window.WTCopyInfo) ? window.WTCopyInfo : null;
    if (!info) { host.classList.add('is-hidden'); return; }
    let sessions = [];
    try { sessions = info.sessions ? info.sessions() : []; } catch (_) { sessions = []; }
    if (!sessions.length) { host.classList.add('is-hidden'); return; }
    host.classList.remove('is-hidden');
    const tracker = (typeof window !== 'undefined' && window.WalletTracker) ? window.WalletTracker : null;
    const short = (a) => (tracker && tracker.shortAddr) ? tracker.shortAddr(a) : String(a).slice(0, 8) + '…';
    const fmt = (v) => (tracker && tracker.fmtUsd) ? tracker.fmtUsd(v) : '$' + Number(v).toFixed(2);

    let html = '<div class="wt-ledger-copy-title"><span>🟢 Copy Trade Aktif</span><span class="wt-sub wt-sub-muted">' + sessions.length + ' wallet dipantau</span></div>';
    sessions.forEach(function (s) {
        const enabled = s.settings && s.settings.enabled !== false;
        const margin = Number(s.settings.fixedMargin) || 0;
        const lev = Number(s.settings.fixedLeverage) || Number(s.settings.defaultLeverage) || Number(s.settings.leverageCap);
        html += '<div class="wt-ledger-copy-row">';
        html += '<div class="wt-ledger-copy-info"><strong>' + short(s.address) + '</strong>';
        html += ' · <span class="' + (enabled ? 'wt-pos' : 'wt-neg') + '">' + (enabled ? 'ON' : 'OFF') + '</span>';
        html += ' · margin $' + margin.toFixed(2) + '/pos · lev ' + lev + 'x · ' + s.copied.length + ' posisi mirror · Eq target ' + fmt(s.targetEquity);
        html += '</div>';
        html += '<label class="wt-ledger-copy-toggle"><input type="checkbox" data-wt-copy-toggle="' + escAttr(s.address) + '"' + (enabled ? ' checked' : '') + '> ' + (enabled ? 'ON' : 'OFF') + '</label>';
        html += '</div>';
    });
    host.innerHTML = html;
    host.querySelectorAll('input[data-wt-copy-toggle]').forEach(function (cb) {
        cb.addEventListener('change', function () {
            const addr = cb.getAttribute('data-wt-copy-toggle');
            try {
                if (window.CopyTrade && window.CopyTrade.setEnabled) {
                    window.CopyTrade.setEnabled(addr, cb.checked);
                    showToast(cb.checked ? 'Copy trade DIAKTIFKAN' : 'Copy trade DIMATIKAN', false, 2500);
                }
            } catch (e) { showToast('Toggle gagal: ' + e.message, true); }
            renderCopyTradeLedgerSection();
            try { if (window.WalletTrackerUI && window.WalletTrackerUI.renderCopyList) window.WalletTrackerUI.renderCopyList(); } catch (_) {}
        });
    });
}

function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateActivePositionsPanel(force = false) {
    const modal = document.getElementById('history-modal');
    const listEl = document.getElementById('active-pos-list');
    if (!modal || !listEl || !modal.classList.contains('active')) return;
    renderCopyTradeLedgerSection();
    const now = Date.now();
    if (!force && now - ActivePositionsUI.lastPaint < ACTIVE_POS_MIN_INTERVAL_MS) return;
    ActivePositionsUI.lastPaint = now;

    const groups = FuturesEngine.getActiveGroups();
    const signature = groups.map((g) => `${g.pair}:${g.positions.map((p) => p.id).join(',')}`).join('|') + `#${AppState.g_pair}`;

    if (signature !== ActivePositionsUI.signature) {
        ActivePositionsUI.signature = signature;
        const refs = { positions: new Map(), groups: new Map(), total: null };
        ActivePositionsUI.refs = refs;
        listEl.replaceChildren();
        const total = groups.reduce((sum, g) => sum + g.positions.length, 0);
        setSafeText('active-pos-total', `${total} posisi · ${groups.length} koin`);
        const closeEverything = document.getElementById('btn-close-all-coins');
        if (closeEverything) {
            closeEverything.classList.toggle('is-hidden', groups.length < 2);
            closeEverything.textContent = 'Close Semua Koin';
            closeEverything.classList.remove('is-armed');
        }
        if (groups.length === 0) {
            listEl.appendChild(createLedgerElement('div', { className: 'empty-log', text: 'Tidak ada posisi aktif.' }));
            return;
        }
        groups.forEach((group) => listEl.appendChild(createActiveGroup(group, refs)));
    }

    // Live values only: no DOM rebuild while the set of positions is stable.
    let accountPnl = 0;
    ActivePositionsUI.refs.groups.forEach((ref, pair) => {
        let groupPnl = 0;
        ref.group.positions.forEach((pos) => {
            const posRef = ActivePositionsUI.refs.positions.get(String(pos.id));
            if (!posRef) return;
            const info = FuturesEngine.getPositionPnl(pos);
            groupPnl += info.totalPnl;
            posRef.mark.textContent = `Mark ${formatPanelPrice(info.mark, pair)}`;
            posRef.mark.className = `active-pos-mark ${pnlClass(info.totalPnl)}`;
            paintActivePnl(posRef.pnl, info.totalPnl, info.pnlPct);
        });
        accountPnl += groupPnl;
        paintActivePnl(ref.pnl, groupPnl);
    });
    const totalPnlEl = document.getElementById('active-pos-total-pnl');
    if (totalPnlEl && ActivePositionsUI.refs.groups.size > 0) paintActivePnl(totalPnlEl, accountPnl);
    else if (totalPnlEl) totalPnlEl.textContent = '';
}

function showPositionChart(pair) {
    const target = switchChartPair(pair);
    if (!target) return;
    closeModal(true);
    if (typeof refreshTradeFundingRate === 'function') refreshTradeFundingRate();
    const chartEl = document.getElementById('main-chart');
    if (chartEl && typeof chartEl.scrollIntoView === 'function') {
        try { chartEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* older browsers */ }
    }
    showToast(`Chart ${target} ditampilkan.`, false, 2500);
}

// pair === null closes every open position of every coin.
async function closeAllActivePositions(pair = null) {
    if (ActivePositionsUI.closing) return;
    ActivePositionsUI.closing = true;
    try {
        const positions = FuturesEngine.state.positions.filter((p) => !pair || p.pair === pair);
        if (positions.length === 0) {
            showToast('Tidak ada posisi aktif untuk ditutup.', true, 3000);
            return;
        }
        // Coins that are not on the chart have no live socket: pull a fresh
        // price first so the exit is not settled at a stale quote.
        const offChart = Array.from(new Set(positions.map((p) => p.pair))).filter((p) => p !== AppState.g_pair);
        await Promise.all(offChart.map((p) => refreshOffChartPrice(p)));

        const result = FuturesEngine.closeAllPositions(pair, 'CLOSE ALL');
        const label = pair ? pair.replace(/USDT$/, '') : 'semua koin';
        if (result.remaining > 0) {
            showToast(`${label}: ${result.closed} ditutup, ${result.remaining} posisi gagal ditutup. Coba lagi.`, true, 6000);
        } else {
            showToast(`${label}: ${result.closed} posisi ditutup semua. Total PNL ${formatSignedUsd(result.totalPnl)}`, false, 4500);
        }
    } catch (error) {
        console.error('closeAllActivePositions failed:', error);
        showToast(`Gagal menutup posisi: ${error.message}`, true, 5000);
    } finally {
        ActivePositionsUI.closing = false;
        updateActivePositionsPanel(true);
    }
}

// Closing everything is destructive: the first click arms the button, the
// second click (within a few seconds) executes it.
function handleActivePositionsClick(event) {
    const source = event && event.target;
    if (!source || typeof source.closest !== 'function') return;
    const button = source.closest('[data-active-pos-action]');
    if (!button) return;
    const action = button.dataset.activePosAction;
    const pair = button.dataset.pair || null;

    if (action === 'view-chart') {
        showPositionChart(pair);
        return;
    }
    if (action !== 'close-all' && action !== 'close-all-coins') return;
    if (ActivePositionsUI.closing) return;

    if (button.dataset.armed !== '1') {
        const original = button.textContent;
        button.dataset.armed = '1';
        button.textContent = 'Yakin? Klik lagi untuk close';
        button.classList.add('is-armed');
        setTimeout(() => {
            if (!button.isConnected) return;
            button.dataset.armed = '';
            button.textContent = original;
            button.classList.remove('is-armed');
        }, ACTIVE_POS_CONFIRM_MS);
        return;
    }
    button.dataset.armed = '';
    closeAllActivePositions(action === 'close-all-coins' ? null : pair);
}

/* Mark prices for coins that are not on the chart. Only the charted pair has
 * a websocket, so without this a position on another coin would freeze the
 * live balance at its last known price. */
const OFF_CHART_PRICE_POLL_MS = 3000;
const offChartPriceState = { inFlight: false };

async function fetchLastPrice(pair) {
    const symbol = encodeURIComponent(pair);
    const endpoints = [
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
        `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
        `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`
    ];
    for (const endpoint of endpoints) {
        try {
            const res = await fetchWithTimeout(endpoint, {}, 5000);
            if (!res.ok) continue;
            const data = await res.json();
            const price = Number(data && data.price);
            if (Number.isFinite(price) && price > 0) return price;
        } catch (e) { /* try next source */ }
    }
    return 0;
}

async function refreshOffChartPrice(pair) {
    if (!pair || pair === AppState.g_pair) return;
    const price = await fetchLastPrice(pair);
    if (price > 0) {
        AppState.lastPrices[pair] = price;
        // Stamp each position so getMarkPrice() never falls back to a stale quote
        // (user bug report 2026-10-09: posisi koin lain tidak gerak).
        const positions = FuturesEngine.state && FuturesEngine.state.positions ? FuturesEngine.state.positions : [];
        positions.forEach((p) => {
            if (p && p.pair === pair) p.lastKnownPrice = price;
        });
    }
}

async function pollOffChartPositionPrices() {
    if (offChartPriceState.inFlight || (typeof document !== 'undefined' && document.hidden)) return;
    const positions = FuturesEngine.state && FuturesEngine.state.positions ? FuturesEngine.state.positions : [];
    const pairs = Array.from(new Set(positions.map((p) => p.pair))).filter((p) => p && p !== AppState.g_pair);
    if (pairs.length === 0) return;
    offChartPriceState.inFlight = true;
    try {
        await Promise.all(pairs.map((pair) => refreshOffChartPrice(pair)));
        updateEquityDisplay();
        // Force repaint so off-chart positions visibly move even when the chart
        // tick hasn't touched them (user bug report 2026-10-09).
        updateActivePositionsPanel(true);
    } catch (e) { /* next poll retries */ }
    finally { offChartPriceState.inFlight = false; }
}
setInterval(pollOffChartPositionPrices, OFF_CHART_PRICE_POLL_MS);

function updateLedgerUI() {
    updateActivePositionsPanel(true);
    setSafeText('fut-wr-d', calcLiveWR('DAILY', 'FUTURES'));
    setSafeText('fut-wr-w', calcLiveWR('WEEKLY', 'FUTURES'));
    setSafeText('fut-wr-m', calcLiveWR('MONTHLY', 'FUTURES'));
    setSafeText('poly-wr-d', calcLiveWR('DAILY', 'POLY'));
    setSafeText('poly-wr-w', calcLiveWR('WEEKLY', 'POLY'));
    setSafeText('poly-wr-m', calcLiveWR('MONTHLY', 'POLY'));

    const listObj = document.getElementById('memory-list');
    if (!listObj) return;
    listObj.replaceChildren();

    const showPoly = AppState.currentFilter === 'POLY' || AppState.currentFilter === 'WIN' || AppState.currentFilter === 'LOSS';
    const showFutures = AppState.currentFilter === 'FUTURES' || AppState.currentFilter === 'WIN' || AppState.currentFilter === 'LOSS';
    // Ledger shows ALL coins, not just the active pair (user request 2026-10-09)
    setSafeText('ledger-pair-title', 'Semua Koin');

    if (showFutures) {
        futuresLog.forEach(f => {
            const isWin = f.pnl > 0;
            if (AppState.currentFilter === 'WIN' && !isWin) return;
            if (AppState.currentFilter === 'LOSS' && !(f.pnl < 0 || f.status === 'LIQ' || f.status === 'LOSS')) return;
            listObj.appendChild(createFuturesLedgerItem(f));
        });
    }

    if (showPoly) {
        polymarketLog.forEach(p => {
            if (AppState.currentFilter === 'WIN' && p.status !== 'CORRECT') return;
            if (AppState.currentFilter === 'LOSS' && p.status !== 'WRONG') return;
            listObj.appendChild(createPolyLedgerItem(p));
        });
    }

    if (listObj.childElementCount === 0) {
        listObj.appendChild(createLedgerElement('div', { className: 'empty-log', text: 'Log Kosong.' }));
    }
}

// Hapus satu entry history dari ledger (tombol X per item) — user request 2026-10-09
window.deleteLedgerEntry = function(kind, id, itemEl) {
    try {
        // Animasi cepat: fade out 150ms dulu, baru hapus data
        if (itemEl && itemEl.classList) {
            itemEl.classList.add('ledger-removing');
        }
        setTimeout(() => {
            if (kind === 'FUTURES') {
                const before = futuresLog.length;
                futuresLog = futuresLog.filter(f => String(f.id) !== String(id));
                if (futuresLog.length < before) {
                    FuturesEngine.save();
                    updateLedgerUI();
                }
            } else if (kind === 'POLY') {
                const before = polymarketLog.length;
                polymarketLog = polymarketLog.filter(p => String(p.id) !== String(id));
                if (polymarketLog.length < before) {
                    safeStore('masako_poly_v44', polymarketLog, APP_SCHEMA_VERSION);
                    updateLedgerUI();
                }
            }
        }, 150);
    } catch (e) {
        console.error('deleteLedgerEntry failed:', e);
    }
};

window.clearMemoryLogs = function() {
    // Ledger shows all coins, so clear clears all (user request 2026-10-09)
    if (AppState.currentFilter === 'FUTURES') {
        futuresLog = [];
        FuturesEngine.save();
    } else if (AppState.currentFilter === 'POLY') {
        polymarketLog = polymarketLog.filter(p => p.status === 'PENDING');
        safeStore('masako_poly_v44', polymarketLog, APP_SCHEMA_VERSION);
    } else {
        futuresLog = [];
        FuturesEngine.save();
        polymarketLog = polymarketLog.filter(p => p.status === 'PENDING');
        safeStore('masako_poly_v44', polymarketLog, APP_SCHEMA_VERSION); 
    }
    updateLedgerUI(); 
    showToast("Log dibersihkan.");
};


/* ------------------------------------------------------------------ *
 * Wide-context pattern data (animal brains see far more than the chart)
 * ------------------------------------------------------------------ */

const PATTERN_REFRESH_MS = 10 * 60 * 1000;
let patternDataTimer = null;
let patternDataRunning = false;

function patternScopeText() {
    const sys = window.AnimalNeuralSystem;
    if (!sys || typeof sys.getPatterns !== 'function') return '—';
    const patterns = sys.getPatterns();
    if (!patterns.available) {
        const counts = patterns.counts || {};
        const loaded = Object.keys(counts).reduce((acc, tf) => acc + (counts[tf] || 0), 0);
        return loaded > 0 ? `${loaded} candle terkumpul` : 'belum dimuat';
    }
    const counts = patterns.counts || {};
    const parts = ['1d', '4h', '1h', '15m', '5m', '1m']
        .filter((tf) => counts[tf] > 0)
        .map((tf) => `${tf} × ${counts[tf]}`);
    return `${parts.join(' · ')} → ${patterns.candles} candle`;
}

function refreshPatternPanels() {
    const scopeEl = document.getElementById('settings-pattern-scope');
    if (scopeEl) scopeEl.textContent = patternScopeText();
    const statusEl = document.getElementById('settings-pattern-status');
    if (statusEl) {
        const sys = window.AnimalNeuralSystem;
        const patterns = sys && typeof sys.getPatterns === 'function' ? sys.getPatterns() : null;
        if (!patterns) statusEl.textContent = 'modul tidak tersedia';
        else if (!patterns.available) statusEl.textContent = 'menunggu data';
        else statusEl.textContent = `${patterns.families} keluarga pola · ${patterns.samples} sampel` +
            (patterns.partial ? ' (sebagian)' : '');
    }
    if (window.NeuralUI && typeof window.NeuralUI.scheduleUpdate === 'function') {
        window.NeuralUI.scheduleUpdate();
    }
}

/* Fetch the wide corpus once the chart is live, then mine it. Failures only
 * degrade the pattern panel: the chart never depends on this data. */
function loadPatternData(options = {}) {
    const DH = window.DeepHistory;
    const sys = window.AnimalNeuralSystem;
    if (!DH || !sys || typeof DH.fetchCorpus !== 'function' || typeof sys.ingestCorpus !== 'function') return;
    const pair = AppState.g_pair;
    const cached = typeof DH.getCached === 'function' ? DH.getCached(pair) : null;
    const fresh = cached && typeof DH.isFresh === 'function' && DH.isFresh(pair);
    if (cached && fresh && options.force !== true) {
        sys.ingestCorpus(cached);
        refreshPatternPanels();
        return;
    }
    if (patternDataRunning) return;
    patternDataRunning = true;
    DH.fetchCorpus(pair, { deep: options.deep === true }).then((corpus) => {
        patternDataRunning = false;
        if (!corpus || !corpus.ok) { refreshPatternPanels(); return; }
        if (AppState.g_pair !== pair) return; // stale response for a previous pair
        sys.ingestCorpus(corpus);
        refreshPatternPanels();
        if (window.AutoBacktestAI && typeof window.AutoBacktestAI.renderPanel === 'function') {
            window.AutoBacktestAI.renderPanel();
        }
    }).catch((err) => {
        patternDataRunning = false;
        console.warn('Pattern data load failed', err);
        refreshPatternPanels();
    });
}

function schedulePatternRefresh(delayMs) {
    if (patternDataTimer) {
        clearTimeout(patternDataTimer);
        patternDataTimer = null;
    }
    patternDataTimer = setTimeout(() => {
        patternDataTimer = null;
        loadPatternData({});
    }, Number.isFinite(delayMs) ? delayMs : 3000);
}

/* ------------------------------------------------------------------ *
 * Settings modal (login only): Auto Backtest AI + winrate + pattern data
 * ------------------------------------------------------------------ */

const ABT_NUMBER_FIELDS = [
    ['abt-min-confidence', 'minConfidence', (v) => v / 100],
    ['abt-min-score', 'minScore', (v) => v],
    ['abt-risk-pct', 'riskPct', (v) => v],
    ['abt-leverage', 'leverage', (v) => v],
    ['abt-max-open', 'maxOpen', (v) => v],
    ['abt-cooldown', 'cooldownMinutes', (v) => v],
    ['abt-loss-streak', 'lossStreakPause', (v) => v]
];

const ABT_TOGGLE_FIELDS = [
    ['abt-require-gate', 'requireGate'],
    ['abt-require-pattern', 'requirePattern'],
    ['abt-use-trailing', 'useTrailing'],
    ['abt-use-be', 'useBe']
];

function refreshSettingsView() {
    const abt = window.AutoBacktestAI;
    if (!abt) return;
    const settings = abt.getSettings();
    const loggedIn = abt.isLoggedIn();
    const auth = window.MasakoAuth || {};
    const accountEl = document.getElementById('settings-account');
    if (accountEl) {
        accountEl.textContent = loggedIn
            ? `Masuk sebagai ${auth.email || 'akun aktif'}`
            : 'Login dengan email untuk memakai pengaturan ini.';
    }
    const toggle = document.getElementById('abt-toggle');
    if (toggle) {
        toggle.checked = settings.enabled === true;
        toggle.disabled = !loggedIn;
    }
    ABT_NUMBER_FIELDS.forEach(([id, key, transform]) => {
        const input = document.getElementById(id);
        if (!input) return;
        const value = key === 'minConfidence' ? settings[key] * 100 : settings[key];
        input.value = String(Math.round(value * 100) / 100);
        input.disabled = !loggedIn;
    });
    ABT_TOGGLE_FIELDS.forEach(([id, key]) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.checked = settings[key] === true;
        input.disabled = !loggedIn;
    });
    const modeSel = document.getElementById('abt-mode');
    if (modeSel) {
        modeSel.value = settings.mode;
        modeSel.disabled = !loggedIn;
    }
    abt.renderPanel();
    refreshPatternPanels();
}

window.openSettings = function openSettings() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    refreshSettingsView();
    modal.classList.add('active');
};

window.closeSettings = function closeSettings(force) {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    if (force === true || (force && force.target && force.target.id === 'settings-modal')) {
        modal.classList.remove('active');
    }
};

function bindSettingsUI() {
    const abt = window.AutoBacktestAI;
    if (!abt) return;

    document.getElementById('btn-open-settings')?.addEventListener('click', () => window.openSettings());
    document.getElementById('btn-close-settings')?.addEventListener('click', () => window.closeSettings(true));
    document.getElementById('settings-modal')?.addEventListener('click', (event) => window.closeSettings(event));
    document.querySelector('#settings-modal .modal-content')?.addEventListener('click', (event) => event.stopPropagation());

    document.getElementById('abt-toggle')?.addEventListener('change', (event) => {
        if (event.target.checked && !abt.isLoggedIn()) {
            event.target.checked = false;
            showToast('Auto Backtest AI khusus akun yang login dengan email.', true);
            return;
        }
        abt.updateSettings({ enabled: event.target.checked === true });
        refreshSettingsView();
        showToast(event.target.checked
            ? 'Auto Backtest AI ON: entry demo otomatis saat sinyal kuat.'
            : 'Auto Backtest AI OFF.', false);
    });

    document.getElementById('abt-mode')?.addEventListener('change', (event) => {
        abt.updateSettings({ mode: event.target.value });
        refreshSettingsView();
    });

    ABT_NUMBER_FIELDS.forEach(([id, key, transform]) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => {
            const parsed = parseFloat(input.value);
            if (!Number.isFinite(parsed)) { refreshSettingsView(); return; }
            abt.updateSettings({ [key]: transform(parsed) });
            refreshSettingsView();
        });
    });

    ABT_TOGGLE_FIELDS.forEach(([id, key]) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('change', () => {
            abt.updateSettings({ [key]: input.checked === true });
            refreshSettingsView();
        });
    });

    document.getElementById('abt-reset-stats')?.addEventListener('click', () => {
        abt.resetStats();
        refreshSettingsView();
        showToast('Statistik Auto Backtest AI direset.', false);
    });

    document.getElementById('abt-reset-cooldown')?.addEventListener('click', () => {
        abt.resetCooldowns();
        refreshSettingsView();
        showToast('Cooldown Auto Backtest AI direset.', false);
    });

    document.getElementById('btn-refresh-patterns')?.addEventListener('click', () => {
        showToast('Memuat ulang data pola multi-timeframe...', false);
        loadPatternData({ force: true, deep: true });
        setTimeout(refreshPatternPanels, 1500);
    });

    // Keep the winrate panel live while it is open.
    abt.subscribe(() => {
        const modal = document.getElementById('settings-modal');
        if (modal && modal.classList.contains('active')) {
            abt.renderPanel();
            refreshPatternPanels();
        }
    });
}

function bindStaticUIEvents() {
    const pair = document.getElementById('pair');
    const tf = document.getElementById('tf');
    if (pair) pair.addEventListener('change', changeConfig);
    if (tf) tf.addEventListener('change', changeConfig);

    // ---- Dua modal arbitrase terpisah ----
    document.getElementById('btn-open-arbitrage')?.addEventListener('click', openStrategyModal);
    document.getElementById('btn-open-local-arbitrage')?.addEventListener('click', openLocalModal);
    document.getElementById('btn-close-arbitrage')?.addEventListener('click', closeArbitrageModals);
    document.getElementById('btn-close-local-arbitrage')?.addEventListener('click', closeArbitrageModals);
    document.getElementById('btn-goto-local')?.addEventListener('click', openLocalModal);
    document.getElementById('btn-goto-strategy')?.addEventListener('click', openStrategyModal);
    // Badge universe LOCAL ARBITRAGE di header membuka modal lokal.
    document.getElementById('pair-universe-badge')?.addEventListener('click', openLocalModal);
    // Klik overlay menutup; klik di dalam konten tidak bocor ke overlay.
    document.getElementById('arbitrage-modal')?.addEventListener('click', (e) => {
        if (e && e.target && e.target.id === 'arbitrage-modal') closeArbitrageModals();
    });
    document.getElementById('local-arbitrage-modal')?.addEventListener('click', (e) => {
        if (e && e.target && e.target.id === 'local-arbitrage-modal') closeArbitrageModals();
    });
    document.querySelector('#arbitrage-modal .modal-content')?.addEventListener('click', (e) => e.stopPropagation());
    document.querySelector('#local-arbitrage-modal .modal-content')?.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => {
        if (e && e.key === 'Escape') closeArbitrageModals();
    });
    const rerenderArb = () => {
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    };
    // Modal strategi: search responsif (input) + change untuk kompatibilitas test.
    ['arb-search'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', rerenderArb);
            el.addEventListener('change', rerenderArb);
        }
    });
    ['arb-interval-preset', 'arb-filter-mode', 'arb-show-limit', 'arb-leverage',
     'local-interval-preset', 'local-filter-mode', 'local-show-limit', 'local-leverage'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', rerenderArb);
        document.getElementById(id)?.addEventListener('input', rerenderArb);
    });
    document.getElementById('local-search')?.addEventListener('input', rerenderArb);
    document.getElementById('local-search')?.addEventListener('change', rerenderArb);

    const bindPosInput = (id) => {
        const input = document.getElementById(id);
        if (!input) return;
        // Saat mengetik: pakai nilainya untuk hitung ulang, tapi jangan rapikan
        // kolom input dulu (biar "50" tidak langsung dipotong jadi minimum).
        input.addEventListener('input', () => {
            if (!window.ArbitrageScanner) return;
            const applied = window.ArbitrageScanner.previewPosSize(input.value);
            if (applied === null) return;
            // Samakan kolom satunya tanpa menggangun fokus mengetik.
            const other = document.getElementById(id === 'arb-pos-size' ? 'local-pos-size' : 'arb-pos-size');
            if (other && other !== input && document.activeElement !== other) other.value = String(applied);
            rerenderArb();
        });
        // Saat selesai (blur/Enter): clamp + simpan sebagai preferensi.
        input.addEventListener('change', () => {
            if (window.ArbitrageScanner) window.ArbitrageScanner.setPosSize(input.value);
            rerenderArb();
        });
    };
    bindPosInput('arb-pos-size');
    bindPosInput('local-pos-size');

    const bindPresets = (id) => {
        document.getElementById(id)?.addEventListener('click', (event) => {
            const target = event.target;
            const btn = target && typeof target.closest === 'function' ? target.closest('[data-arb-size]') : null;
            if (!btn || !window.ArbitrageScanner) return;
            window.ArbitrageScanner.setPosSize(btn.getAttribute('data-arb-size'));
            rerenderArb();
        });
    };
    bindPresets('arb-size-presets');
    bindPresets('local-size-presets');

    // ---- LOCAL ARBITRAGE: kontrol universe dinamis
    document.getElementById('arb-universe-mode')?.addEventListener('change', (e) => {
        if (window.ArbitrageScanner) window.ArbitrageScanner.setUniverseMode(e.target.value);
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    });
    document.getElementById('arb-universe-top')?.addEventListener('change', (e) => {
        if (window.MarketUniverse) window.MarketUniverse.setUniverseMax(e.target.value);
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    });
    document.getElementById('arb-universe-min-vol')?.addEventListener('change', (e) => {
        if (window.MarketUniverse) window.MarketUniverse.setMinTurnover(e.target.value);
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    });
    document.getElementById('arb-universe-max-spread')?.addEventListener('change', (e) => {
        if (window.MarketUniverse) window.MarketUniverse.setMaxSpreadBps(e.target.value);
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    });
    document.getElementById('arb-universe-refresh')?.addEventListener('click', () => {
        if (window.MarketUniverse) window.MarketUniverse.refresh({ force: true });
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    });
    document.getElementById('arb-universe-toggle')?.addEventListener('click', () => {
        const list = document.getElementById('arb-universe-coins');
        if (!list) return;
        list.hidden = !list.hidden;
        if (window.ArbitrageScannerRender) window.ArbitrageScannerRender.render();
    });
    // Tombol "Buka chart" di kartu arbitrase (KEDUA modal) -> pair selector + chart.
    const handleArbCardClick = (event) => {
        const target = event.target;
        const btn = target && typeof target.closest === 'function' ? target.closest('[data-arb-pair]') : null;
        if (!btn) return;
        openArbitragePair(String(btn.getAttribute('data-arb-pair') || '').toUpperCase());
    };
    document.getElementById('arb-cards-container')?.addEventListener('click', handleArbCardClick);
    document.getElementById('local-cards-container')?.addEventListener('click', handleArbCardClick);
    // Tombol "Buka chart" di panel Top 3 rekomendasi (kedua modal).
    document.getElementById('arb-recommendations')?.addEventListener('click', handleArbCardClick);
    document.getElementById('local-recommendations')?.addEventListener('click', handleArbCardClick);

    document.getElementById('btn-open-ledger')?.addEventListener('click', openModal);
    document.getElementById('chart-jump-right')?.addEventListener('click', jumpChartToRealtime);
    document.getElementById('btn-poly-5')?.addEventListener('click', () => logPolymarketAction(5));
    document.getElementById('btn-poly-15')?.addEventListener('click', () => logPolymarketAction(15));
    document.getElementById('btn-custom-balance')?.addEventListener('click', () => FuturesEngine.setCustomBalance());
    document.getElementById('tab-manual')?.addEventListener('click', () => setFuturesMode('MANUAL'));
    document.getElementById('tab-ai')?.addEventListener('click', () => setFuturesMode('AI'));
    document.getElementById('mode-cons')?.addEventListener('click', () => setAiMode('CONS'));
    document.getElementById('mode-agg')?.addEventListener('click', () => setAiMode('AGG'));
    const slider = document.getElementById('leverage-slider');
    if (slider) {
        ['input', 'change', 'pointermove', 'pointerup', 'touchmove', 'touchend', 'mouseup'].forEach(evt => {
            slider.addEventListener(evt, (e) => {
                updateLevUI(e.target.value);
            });
        });
    }
    const levInput = document.getElementById('lev-val-input');
    if (levInput) {
        ['input', 'change'].forEach(evt => {
            levInput.addEventListener(evt, (e) => {
                let val = parseInt(e.target.value, 10);
                if (isNaN(val) || val < 1) val = 1;
                if (val > 125) val = 125;
                updateLevUI(val);
            });
        });
    }
    document.getElementById('tp-pct-sel')?.addEventListener('change', () => handlePctChange('tp'));
    document.getElementById('sl-pct-sel')?.addEventListener('change', () => handlePctChange('sl'));
    ['tp-price', 'sl-price'].forEach((id) => {
        document.getElementById(id)?.addEventListener('focus', (event) => {
            if (!event.target.value && AppState.price) event.target.value = formatPrice(AppState.price);
        });
    });
    // Exchange selector
    document.getElementById('trade-exchange')?.addEventListener('change', (e) => {
        safeStore('masako_pref_exchange', e.target.value, APP_SCHEMA_VERSION);
        refreshTradeFundingRate();
    });

    // Capital presets
    document.getElementById('capital-presets')?.addEventListener('click', (event) => {
        const target = event.target;
        const btn = target && typeof target.closest === 'function' ? target.closest('[data-capital]') : null;
        if (!btn) return;
        const val = Number(btn.getAttribute('data-capital'));
        if (!Number.isFinite(val) || val <= 0) return;
        const amtInput = document.getElementById('trade-amount');
        if (amtInput) amtInput.value = String(val);
        document.querySelectorAll('#capital-presets .capital-preset').forEach((b) => {
            b.classList.toggle('active', b === btn);
        });
    });
    // Highlight preset saat user mengetik manual
    document.getElementById('trade-amount')?.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        document.querySelectorAll('#capital-presets .capital-preset').forEach((b) => {
            b.classList.toggle('active', Number(b.getAttribute('data-capital')) === val);
        });
    });

    document.getElementById('btn-long-sim')?.addEventListener('click', () => window.executeFuturesTrade('LONG', false));
    document.getElementById('btn-short-sim')?.addEventListener('click', () => window.executeFuturesTrade('SHORT', false));
    document.getElementById('btn-ai-execute-sim')?.addEventListener('click', () => window.executeFuturesTrade('AI', true));
    document.getElementById('history-modal')?.addEventListener('click', closeModal);
    document.querySelector('#history-modal .modal-content')?.addEventListener('click', (event) => event.stopPropagation());
    document.getElementById('btn-close-history')?.addEventListener('click', () => closeModal(true));
    document.getElementById('btn-run-backtest')?.addEventListener('click', runBacktestEngine);
    document.querySelectorAll('[data-ledger-filter]').forEach((button) => {
        button.addEventListener('click', () => handleSetFilter(button.dataset.ledgerFilter, button));
    });
    document.getElementById('btn-clear-logs')?.addEventListener('click', clearMemoryLogs);
    document.getElementById('active-pos-section')?.addEventListener('click', handleActivePositionsClick);
    document.getElementById('action-modal')?.addEventListener('click', closeActionModal);
    // Buttons here are created dynamically. Handle their clicks before
    // stopping propagation so confirmation can never be swallowed by the
    // modal's overlay guard.
    document.querySelector('#action-modal .modal-content')?.addEventListener('click', handleActionModalContentClick);
    document.getElementById('btn-close-action')?.addEventListener('click', () => closeActionModal(true));
}

function bindDelegatedDynamicEvents() {
    document.addEventListener('change', (event) => {
        if (event.target?.id === 'partial-close-slider') {
            setSafeText('partial-close-val', `${event.target.value}%`);
        }
    });

    document.addEventListener('click', handleDynamicActionClick);
}

function handleActionModalContentClick(event) {
    // Keep a click inside the panel from falling through to the overlay, but
    // run the dynamic action delegate first. Previously this propagation stop
    // sat here alone, making “Konfirmasi Tutup” and modal quick-select buttons
    // inert because the only delegate lived on document.
    handleDynamicActionClick(event);
    event.stopPropagation();
}

function handleDynamicActionClick(event) {
    const source = event && event.target;
    if (!source || typeof source.closest !== 'function') return;
    const target = source.closest('[data-partial-close-pct], [data-action], [data-position-action], [data-cancel-prediction-id]');
    if (!target) return;

    if (target.dataset.partialClosePct) {
        const slider = document.getElementById('partial-close-slider');
        if (slider) slider.value = target.dataset.partialClosePct;
        setSafeText('partial-close-val', `${target.dataset.partialClosePct}%`);
        return;
    }

    if (target.dataset.positionAction === 'partial-close') {
        openPartialCloseModal(target.dataset.positionId);
        return;
    }
    if (target.dataset.positionAction === 'edit-tpsl') {
        openEditTpSlModal(target.dataset.positionId);
        return;
    }
    if (target.dataset.cancelPredictionId) {
        cancelPrediction(target.dataset.cancelPredictionId);
        return;
    }

    if (target.dataset.action === 'partial-close-confirm') executePartialClose();
    if (target.dataset.action === 'auto-tpsl') autoCalculateTpSl(target.dataset.positionId);
    if (target.dataset.action === 'save-tpsl') executeEditTpSl();
}

bindStaticUIEvents();
bindDelegatedDynamicEvents();
bindSettingsUI();

/**
 * Boot guard shared by the DOM-ready path and the auth path.
 *
 * The terminal must be usable without an account, so the chart boot is NOT
 * chained to the Supabase session. Previously `initApp()` only ran from the
 * auth callback: when the SDK was slow, the CDN was blocked or `getSession()`
 * never settled, the loading overlay stayed on screen until the user manually
 * changed the pair (whose `change` listener boots the chart independently).
 */
function startTerminalOnce() {
    if (window.__MASAKO_APP_STARTED__) return;
    window.__MASAKO_APP_STARTED__ = true;
    if (typeof window.initApp !== 'function') return;
    try { window.initApp(); }
    catch (e) { console.error('Terminal boot failed', e); }
}
window.startTerminalOnce = startTerminalOnce;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startTerminalOnce, { once: true });
} else {
    startTerminalOnce();
}

// Watchdog: if neither DOMContentLoaded nor the auth callback ever fires (e.g.
// a blocked script or a stalled SDK), the chart must still boot.
if (typeof window.setTimeout === 'function') {
    window.setTimeout(startTerminalOnce, 2500);
}

if (typeof setupAuthUI === 'function') { setupAuthUI(); }

// Refresh funding rate di panel Futures Execution setiap 5 detik (mengikuti
// polling ArbitrageScanner @10 detik + cadangan saat data belum siap).
setInterval(() => {
    if (typeof refreshTradeFundingRate === 'function') refreshTradeFundingRate();
}, 5000);

// 24/7 Reconnection & seamless state synchronization
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && window.FuturesEngine && typeof window.FuturesEngine.syncStateFromServer === 'function') {
            window.FuturesEngine.syncStateFromServer();
        }
    });
    window.addEventListener('online', () => {
        if (window.FuturesEngine) window.FuturesEngine.syncStateFromServer();
    });
    window.addEventListener('focus', () => {
        if (window.FuturesEngine && typeof window.FuturesEngine.syncStateFromServer === 'function') {
            window.FuturesEngine.syncStateFromServer();
        }
    });
    // Periodic synchronization every 30 seconds
    setInterval(() => {
        if (window.MasakoAuth?.isAuthenticated && window.FuturesEngine && typeof window.FuturesEngine.syncStateFromServer === 'function') {
            window.FuturesEngine.syncStateFromServer();
        }
    }, 30000);
}
