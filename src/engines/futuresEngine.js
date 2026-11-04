function validateTrade(type, amount, leverage, marginMode = 'ISOLATED') { 
    if (!Number.isFinite(AppState.price) || AppState.price <= 0) {
        showToast("Data market belum siap.", true); 
        return false; 
    } 
    if (FuturesEngine.state.balance <= 0 || isNaN(FuturesEngine.state.balance)) { 
        showToast("Saldo habis. Silakan reset saldo.", true); 
        return false; 
    } 
    if (!['LONG', 'SHORT'].includes(type) || !['ISOLATED', 'CROSS'].includes(marginMode)
        || !Number.isInteger(leverage) || leverage < 1 || leverage > 125
        || !Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
        showToast("Margin tidak valid.", true); 
        return false; 
    }

    let estFee = amount * leverage * FEES.TAKER;
    if (marginMode === 'ISOLATED') {
        if ((amount + estFee) > FuturesEngine.state.balance) { 
            showToast("Margin tidak valid / Saldo kurang untuk margin + fee.", true); 
            return false; 
        }
    } else if (estFee > FuturesEngine.state.balance) {
        showToast("Saldo kurang untuk fee entry.", true); 
        return false; 
    }

    if (FuturesEngine.state.positions.length >= 5) { 
        showToast("Maksimal 5 posisi aktif.", true); 
        return false; 
    } 
    return true; 
}

function getTotalUnrealizedEquity(priceMap = null, baseBalance = FuturesEngine.state.balance) {
    let eq = baseBalance;
    let unPnl = 0; 
    if (FuturesEngine.state.positions && FuturesEngine.state.positions.length > 0) { 
        FuturesEngine.state.positions.forEach((p) => { 
            if (p.marginMode === 'ISOLATED') {
                eq += p.margin; 
            }
            let cP = priceMap && typeof priceMap === 'object' && !Array.isArray(priceMap)
                ? (priceMap[p.pair] ?? (p.pair === AppState.g_pair ? AppState.price : (AppState.lastPrices[p.pair] || p.entryPrice)))
                : ((p.pair === AppState.g_pair) ? AppState.price : (AppState.lastPrices[p.pair] || p.entryPrice)); 
            if (cP > 0) { 
                let rawPnl = p.type === 'LONG' ? (cP - p.entryPrice) * p.sizeBase : (p.entryPrice - cP) * p.sizeBase; 
                unPnl += rawPnl; 
            } 
        }); 
    } 
    return eq + unPnl; 
}


function createUiElement(tag, { className = '', text = '', attrs = {}, title = '' } = {}) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = String(text);
    if (title) element.title = title;
    Object.entries(attrs).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        element.setAttribute(key, String(value));
    });
    return element;
}

function appendChildren(parent, children) {
    children.filter(Boolean).forEach(child => parent.appendChild(child));
    return parent;
}

function createDetailBlock(label, value, valueClass = 'position-detail-value') {
    const block = document.createElement('div');
    appendChildren(block, [
        createUiElement('div', { className: 'position-detail-label', text: label }),
        createUiElement('div', { className: valueClass, text: value })
    ]);
    return block;
}

function createTpSlValue(pos, field) {
    const value = pos[field];
    if (!value) return createUiElement('span', { text: '-' });
    const roePct = (Math.abs(value - pos.entryPrice) / pos.entryPrice) * pos.leverage * 100;
    const wrapper = createUiElement('span', { text: `${formatPrice(value)} ` });
    const prefix = field === 'tp' ? '+' : '-';
    wrapper.appendChild(createUiElement('span', {
        className: field === 'tp' ? 'position-roi-profit' : 'position-roi-loss',
        text: `(${prefix}${roePct.toFixed(2)}%)`
    }));
    return wrapper;
}

function createPositionBadge(text, className) {
    return createUiElement('span', { className: `position-badge ${className}`, text });
}

function createPositionCard(pos, balance) {
    const card = createUiElement('div', { className: 'position-card' });
    const header = createUiElement('div', { className: 'position-card-header' });
    const headerInline = createUiElement('div', { className: 'position-header-inline' });
    const mModeStr = pos.marginMode === 'CROSS' ? 'Cross' : 'Isolated';
    appendChildren(headerInline, [
        createUiElement('span', { className: 'position-pair', text: pos.pair }),
        createUiElement('span', { className: `position-side ${pos.type === 'LONG' ? 'market-long' : 'market-short'}`, text: pos.type }),
        createUiElement('span', { className: 'position-mode-pill', text: `${pos.leverage}x ${mModeStr}` })
    ]);
    const closeButton = createUiElement('button', {
        className: 'pos-close-icon',
        text: '✖',
        title: 'Tutup Posisi (Atur Persentase)',
        attrs: { type: 'button', 'data-position-action': 'partial-close', 'data-position-id': pos.id, 'aria-label': `Tutup posisi ${pos.pair}` }
    });
    appendChildren(header, [headerInline, closeButton]);

    const badges = createUiElement('div', { className: 'position-badges' });
    if (pos.tsIsActive) badges.appendChild(createPositionBadge('MANUAL TS', 'position-badge-ai'));
    if (pos.useBe) badges.appendChild(createPositionBadge('SL+', 'demo-mode-pill'));
    if (pos.useTrailing) badges.appendChild(createPositionBadge('ATR TS', 'position-badge-atr'));
    if (pos.autoHedgeTrail) badges.appendChild(createPositionBadge('HEDGE TS', 'position-badge-hedge'));
    if (pos.beLocked) badges.appendChild(createPositionBadge('BE LOCKED', 'position-badge-be'));
    if (pos.isAi) badges.appendChild(createPositionBadge('AI', 'position-badge-ai'));

    const grid = createUiElement('div', { className: 'position-detail-grid' });
    const liqPrice = this.calculateLiqPrice ? this.calculateLiqPrice(pos, balance) : FuturesEngine.calculateLiqPrice(pos, balance);
    const exchangeLabel = pos.exchange || 'Binance';
    const fundingRateLabel = Number.isFinite(pos.fundingRate) ? (pos.fundingRate * 100).toFixed(4) + '%' : '-';
    appendChildren(grid, [
        createDetailBlock('Entry Price', formatPrice(pos.entryPrice), 'position-detail-value-primary'),
        appendChildren(document.createElement('div'), [
            createUiElement('div', { className: 'position-detail-label', text: 'Current Price' }),
            createUiElement('div', { className: 'position-detail-value', text: '-', attrs: { id: `pos-curr-${pos.id}` } })
        ]),
        createDetailBlock('Exchange', exchangeLabel),
        createDetailBlock('Funding Rate', fundingRateLabel),
        createDetailBlock('Margin / Size', `${pos.margin.toFixed(2)} / ${(pos.margin * pos.leverage).toFixed(2)}`),
        createDetailBlock('Liq. Price', formatPrice(liqPrice), 'position-detail-value-danger')
    ]);

    const tpslBlock = createUiElement('div', { className: 'position-grid-span-2' });
    const tpslHeader = createUiElement('div', { className: 'position-detail-label-flex' });
    appendChildren(tpslHeader, [
        createUiElement('span', { text: 'Target Price & Stop Loss' }),
        createUiElement('button', {
            className: 'position-edit-action',
            text: '⋮ Edit',
            title: 'Edit TP/SL',
            attrs: { type: 'button', 'data-position-action': 'edit-tpsl', 'data-position-id': pos.id }
        })
    ]);
    const tpslBox = createUiElement('div', { className: 'position-tpsl-box' });
    appendChildren(tpslBox, [
        createTpSlValue(pos, 'tp'),
        createUiElement('span', { className: 'label-muted', text: '/' }),
        createTpSlValue(pos, 'sl')
    ]);
    appendChildren(tpslBlock, [tpslHeader, tpslBox]);
    grid.appendChild(tpslBlock);

    const pnlRow = createUiElement('div', { className: 'position-pnl-row' });
    appendChildren(pnlRow, [
        createUiElement('span', { className: 'position-pnl-label', text: 'Price PNL' }),
        createUiElement('span', { className: 'position-pnl-value', text: '$0.00 (0.00%)', attrs: { id: `pos-pnl-${pos.id}` } })
    ]);

    const fundingRow = createUiElement('div', { className: 'position-pnl-row' });
    appendChildren(fundingRow, [
        createUiElement('span', { className: 'position-pnl-label', text: 'Funding PNL' }),
        createUiElement('span', { className: 'position-pnl-value', text: '$0.00', attrs: { id: `pos-funding-${pos.id}` } })
    ]);

    const totalRow = createUiElement('div', { className: 'position-pnl-row position-total-row' });
    appendChildren(totalRow, [
        createUiElement('span', { className: 'position-pnl-label', text: 'TOTAL (Price + Funding)' }),
        createUiElement('span', { className: 'position-pnl-value', text: '$0.00 (0.00%)', attrs: { id: `pos-total-${pos.id}` } })
    ]);

    appendChildren(card, [header, badges, grid, pnlRow, fundingRow, totalRow]);
    return card;
}

// A close is always settled locally first. For signed-in sessions this small,
// persisted tombstone prevents an in-flight /api/get-state response from
// reviving a position that the trader has already closed on this device.
const REMOTE_CLOSE_TOMBSTONE_KEY = 'masako_pending_remote_closes_v1';
const REMOTE_CLOSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getAuthenticatedUserId() {
    const user = window.MasakoAuth && window.MasakoAuth.user;
    return user && user.id ? String(user.id) : '';
}

function loadRemoteCloseTombstones() {
    const raw = safeLoad(REMOTE_CLOSE_TOMBSTONE_KEY, {});
    const now = Date.now();
    const clean = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
    Object.keys(raw).forEach((id) => {
        const item = raw[id];
        if (!item || typeof item !== 'object') return;
        const closedAt = Number(item.closedAt);
        const userId = String(item.userId || '');
        if (!userId || !Number.isFinite(closedAt) || closedAt <= 0 || now - closedAt > REMOTE_CLOSE_MAX_AGE_MS) return;
        const closeRecord = item.closeRecord && typeof item.closeRecord === 'object' ? item.closeRecord : null;
        clean[String(id)] = { userId, closedAt, closeRecord };
    });
    return clean;
}

// Loading trading state must never reset it. A persisted payload is kept
// even when its shape is only partially valid; individual bad position rows
// are dropped, and balance/positions fall back to defaults only when the
// stored value is unusable outright.
function normalizeTradingState(raw) {
    const state = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    if (!Array.isArray(state.positions)) state.positions = [];
    // localStorage bisa dimanipulasi DevTools/ekstensi: baris dengan bentuk
    // bukan-data dibuang, angka dipatok ke rentang yang membuat kalkulasi
    // margin/likuidasi tetap finit, dan panjang list dibatasi agar satu state
    // raksasa tidak membuat boot hang. Data sah user tidak pernah tersentuh.
    state.positions = state.positions
        .filter((pos) => pos && typeof pos === 'object' && !Array.isArray(pos)
            && pos.id !== undefined && pos.id !== null
            && Number.isFinite(Number(pos.margin)) && Number(pos.margin) > 0
            && Number.isFinite(Number(pos.entryPrice)) && Number(pos.entryPrice) > 0)
        .slice(0, 500)
        .map((pos) => {
            const leverage = Number(pos.leverage);
            pos.leverage = Number.isFinite(leverage) && leverage >= 1 && leverage <= 125 ? Math.round(leverage) : 1;
            const fundingRate = Number(pos.fundingRate);
            pos.fundingRate = Number.isFinite(fundingRate) ? Math.min(1, Math.max(-1, fundingRate)) : 0;
            const fundingPnl = Number(pos.fundingPnl);
            pos.fundingPnl = Number.isFinite(fundingPnl) ? fundingPnl : 0;
            for (const key of ['tp', 'sl']) {
                const price = Number(pos[key]);
                pos[key] = Number.isFinite(price) && price > 0 ? price : null;
            }
            const sizeBase = Number(pos.sizeBase);
            pos.sizeBase = Number.isFinite(sizeBase) && sizeBase > 0 ? sizeBase : (pos.margin * pos.leverage) / pos.entryPrice;
            const sizeUsd = Number(pos.sizeUsd);
            pos.sizeUsd = Number.isFinite(sizeUsd) && sizeUsd > 0 ? sizeUsd : pos.margin * pos.leverage;
            return pos;
        });
    const balance = Number(state.balance);
    state.balance = Number.isFinite(balance) && balance >= 0 ? Math.min(balance, 1e12) : 10000;
    return state;
}

function isTerminalPositionHistory(entry) {
    return !!entry && ['CLOSED', 'LIQ', '100% CLOSED'].includes(entry.status);
}

// Prefer canonical server history for known ids; preserve guest/offline legs
// for ids the server has never seen.
function mergeLedgerPreservingLocal(serverHistory, localLog) {
    const server = Array.isArray(serverHistory) ? serverHistory : [];
    const local = Array.isArray(localLog) ? localLog : [];
    if (!local.length) return server;
    const serverIds = new Set(server
        .map((entry) => (entry && entry.id !== undefined && entry.id !== null ? String(entry.id) : ''))
        .filter(Boolean));
    const localOnly = local.filter((entry) => {
        if (!entry) return false;
        if (entry.id === undefined || entry.id === null) return true;
        return !serverIds.has(String(entry.id));
    });
    if (!localOnly.length) return server;
    return server.concat(localOnly).sort((a, b) => (Number(b && b.closeTime) || 0) - (Number(a && a.closeTime) || 0)).slice(0, 200);
}

const persistedTradingState = normalizeTradingState(safeLoad('masako_futures_state_v44', { balance: 10000, positions: [] }));
// New snapshots commit balance, positions and ledger with ONE atomic setItem.
// Older snapshots still use the separately loaded legacy ledger.
if (Array.isArray(persistedTradingState.history)) {
    futuresLog = persistedTradingState.history.filter((row) => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 200);
}
delete persistedTradingState.history;

const FuturesEngine = {
    state: persistedTradingState,
    posLines: {},
    MM_RATE: 0.005,
    localMutationVersion: 0,
    positionSequence: 0,
    remoteSettlementVersion: 0,
    syncStatePromise: null,
    mirrorPromise: null,
    pendingRemoteOpens: new Map(),
    authEpoch: 0,
    lastStorageWarningAt: 0,
    pendingRemoteCloses: loadRemoteCloseTombstones(),
    pendingRemoteCloseRequests: new Map(),
    pendingRemotePositionUpdates: new Map(),

    authContext() {
        return { userId: getAuthenticatedUserId(), epoch: this.authEpoch };
    },

    isCurrentAuth(context) {
        return !!window.MasakoAuth?.isAuthenticated
            && context.userId === getAuthenticatedUserId() && context.epoch === this.authEpoch;
    },

    onAuthChanged(nextUserId = '') {
        // Invalidate GET/POST callbacks from the previous login, including
        // sign-out followed by signing back into the same account.
        this.authEpoch++;
        this.noteLocalMutation();
        if (nextUserId) this.prepareAccountState(String(nextUserId));
    },

    prepareAccountState(userId = getAuthenticatedUserId()) {
        if (!userId) return true;
        // A guest portfolio is adopted by its first account. Later account
        // switches archive/restore the WHOLE book, never mix balances/history.
        const ownedRow = this.state.positions.find((p) => p.backendUserId || p.userId);
        const owner = this.state.accountUserId || ownedRow?.backendUserId || ownedRow?.userId || '';
        if (owner && String(owner) !== userId) {
            const archiveKey = `masako_futures_account_${encodeURIComponent(owner)}`;
            if (!safeStore(archiveKey, { ...this.state, history: futuresLog }, APP_SCHEMA_VERSION)) {
                showToast('Gagal mengamankan portfolio akun sebelumnya. Sinkronisasi ditunda.', true, 6000);
                return false;
            }
            const previousState = this.state;
            const previousLog = futuresLog;
            const restored = safeLoad(`masako_futures_account_${encodeURIComponent(userId)}`, { balance: 10000, positions: [], history: [] });
            this.state = normalizeTradingState(restored);
            futuresLog = Array.isArray(this.state.history) ? this.state.history.filter((row) => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 200) : [];
            delete this.state.history;
            this.state.accountUserId = userId;
            if (!this.persistLocalState()) {
                this.state = previousState;
                futuresLog = previousLog;
                return false;
            }
            this.noteLocalMutation();
            this.clearChartLines();
            this.updateUI();
            if (typeof updateLedgerUI === 'function') updateLedgerUI();
            if (typeof updateEquityDisplay === 'function') updateEquityDisplay();
        } else if (!this.state.accountUserId) {
            this.state.accountUserId = userId;
            if (!this.persistLocalState()) {
                delete this.state.accountUserId;
                return false;
            }
        }
        return true;
    },

    noteLocalMutation() {
        this.localMutationVersion++;
        return this.localMutationVersion;
    },

    hasPendingRemoteWrite() {
        return this.pendingRemoteOpens.size > 0 || this.pendingRemotePositionUpdates.size > 0 || this.pendingRemoteCloseRequests.size > 0;
    },

    persistRemoteCloseTombstones() {
        const now = Date.now();
        Object.keys(this.pendingRemoteCloses).forEach((id) => {
            const item = this.pendingRemoteCloses[id];
            if (!item || !Number.isFinite(Number(item.closedAt)) || now - Number(item.closedAt) > REMOTE_CLOSE_MAX_AGE_MS) {
                delete this.pendingRemoteCloses[id];
            }
        });
        safeStore(REMOTE_CLOSE_TOMBSTONE_KEY, this.pendingRemoteCloses, APP_SCHEMA_VERSION);
    },

    markRemoteClosePending(id, closeRecord = null, userId = getAuthenticatedUserId()) {
        if (!userId || id === undefined || id === null) return false;
        const record = closeRecord && typeof closeRecord === 'object' ? {
            exitPrice: closeRecord.exitPrice,
            margin: closeRecord.margin,
            status: closeRecord.status,
            closeReason: closeRecord.closeReason
        } : null;
        this.pendingRemoteCloses[String(id)] = { userId, closedAt: Date.now(), closeRecord: record };
        this.persistRemoteCloseTombstones();
        return true;
    },

    isRemoteClosePending(id) {
        const item = this.pendingRemoteCloses[String(id)];
        const userId = getAuthenticatedUserId();
        return !!(item && userId && item.userId === userId);
    },

    clearRemoteClosePending(id) {
        if (Object.prototype.hasOwnProperty.call(this.pendingRemoteCloses, String(id))) {
            delete this.pendingRemoteCloses[String(id)];
            this.persistRemoteCloseTombstones();
        }
    },

    hydrateServerPosition(position) {
        if (!position || typeof position !== 'object') return null;
        if (position.id === undefined || position.id === null) return null;
        // The server owns exposure; local-only execution settings (trailing,
        // neural metadata) survive hydration for this exact position.
        const local = this.state.positions.find((p) => String(p.id) === String(position.id));
        const pos = { ...local, ...position, backendUserId: getAuthenticatedUserId(), sentToBackend: true };
        const margin = Number(pos.margin);
        const leverage = Number(pos.leverage);
        const entryPrice = Number(pos.entryPrice);
        if (!Number.isFinite(margin) || margin <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
            return null;
        }
        pos.margin = margin;
        pos.leverage = leverage;
        pos.entryPrice = entryPrice;
        if (!pos.exchange || !['Binance', 'OKX', 'Bybit'].includes(pos.exchange)) pos.exchange = 'Binance';
        if (!Number.isFinite(pos.fundingRate)) pos.fundingRate = 0;
        if (!Number.isFinite(pos.fundingPnl)) pos.fundingPnl = 0;
        pos.lastFundingSettle = Number.isFinite(Number(pos.lastFundingSettle)) ? Number(pos.lastFundingSettle) : Date.now();
        // The server persists margin/leverage as the canonical open exposure.
        // Rebuild derived size fields so a partial-close snapshot cannot retain
        // the original (now too large) base size from an older record.
        pos.sizeBase = safeDiv(margin * leverage, entryPrice);
        pos.sizeUsd = margin * leverage;
        pos.openTime = Number.isFinite(Number(pos.openTime)) ? Number(pos.openTime) : Date.now();
        return pos;
    },

    async flushPendingRemoteCloses() {
        if (!window.MasakoAuth?.isAuthenticated || !window.apiFetch) return [];
        const userId = getAuthenticatedUserId();
        if (!userId) return [];
        const ids = Object.keys(this.pendingRemoteCloses).filter((id) => this.pendingRemoteCloses[id]?.userId === userId);
        return Promise.all(ids.map((id) => this.syncDeletePosition(id)));
    },

    buildBackendPositionPayload(pos) {
        return {
            id: String(pos.id),
            pair: pos.pair,
            type: pos.type,
            entryPrice: pos.entryPrice,
            sl: pos.sl,
            tp: pos.tp,
            leverage: pos.leverage,
            margin: pos.margin,
            marginMode: pos.marginMode,
            exchange: pos.exchange,
            fundingRate: pos.fundingRate,
            fundingPnl: pos.fundingPnl,
            lastFundingSettle: pos.lastFundingSettle,
            createdAt: pos.openTime,
            // Penanda asal posisi (mis. COPY_TRADE) + metadata copy — dipakai
            // server untuk dedup copy trade & badge COPY setelah buka ulang.
            // validatePositionPayload menyimpan key tambahan apa adanya.
            origin: typeof pos.origin === 'string' ? pos.origin : undefined,
            copyMeta: pos.copyMeta && typeof pos.copyMeta === 'object' ? pos.copyMeta : undefined
        };
    },

    acknowledgePositionMirror(id) {
        // Sync may have replaced the object while the POST was in flight.
        // Never resurrect a locally closed row from the captured POST object.
        const pos = this.state.positions.find((item) => String(item.id) === String(id));
        if (!pos) return;
        pos.sentToBackend = true;
        // A get-state started before this ack may still contain the pre-open
        // book. Invalidate that snapshot before persisting the mirror flag.
        this.noteLocalMutation();
        this.save();
    },

    syncOpenPosition(pos) {
        if (!window.MasakoAuth?.isAuthenticated || !window.apiFetch) return Promise.resolve({ ok: false, skipped: true });
        const key = String(pos.id);
        const existing = this.pendingRemoteOpens.get(key);
        if (existing) return existing;
        const context = this.authContext();
        if (pos.backendUserId && pos.backendUserId !== context.userId) return Promise.resolve({ ok: false, skipped: true });
        // Record the attempted owner BEFORE sending. A lost ack/reload must
        // not let the next account adopt this position as a guest trade.
        const previousOwner = pos.backendUserId;
        pos.backendUserId = context.userId;
        if (!this.persistLocalState()) {
            pos.backendUserId = previousOwner;
            return Promise.resolve({ ok: false, error: 'Gagal menyimpan antrean sinkronisasi lokal.' });
        }
        const payload = this.buildBackendPositionPayload(pos);
        const request = Promise.resolve().then(async () => {
            if (!this.isCurrentAuth(context)) return { ok: false, skipped: true };
            const response = await window.apiFetch('/api/save-position', {
                method: 'POST', body: JSON.stringify(payload)
            });
            const body = await response.json();
            if (!response.ok || !body || body.success !== true) {
                throw new Error((body && body.error) || `HTTP ${response.status}`);
            }
            if (!this.isCurrentAuth(context)) return { ok: false, skipped: true };
            this.acknowledgePositionMirror(key);
            return { ok: true };
        }).catch((error) => ({ ok: false, error: error.message || 'network error' })).finally(() => {
            if (this.pendingRemoteOpens.get(key) === request) {
                this.pendingRemoteOpens.delete(key);
            }
        });
        this.pendingRemoteOpens.set(key, request);
        return request;
    },

    // One POST per position in flight, shared by open, login and reconnect.
    // Read the current book before each retry, never a captured closed row.
    mirrorUnsyncedLocalPositions() {
        if (this.mirrorPromise && this.mirrorUserId === getAuthenticatedUserId()
            && this.mirrorEpoch === this.authEpoch) return this.mirrorPromise;
        if (!window.MasakoAuth?.isAuthenticated || !window.apiFetch) return Promise.resolve({ synced: 0, failed: 0 });
        if (!this.prepareAccountState()) return Promise.resolve({ synced: 0, failed: 0 });
        const context = this.authContext();
        const pending = this.state.positions.filter((p) => p && p.sentToBackend !== true).map((p) => String(p.id));
        if (!pending.length) return Promise.resolve({ synced: 0, failed: 0 });
        this.mirrorUserId = context.userId;
        this.mirrorEpoch = context.epoch;
        const task = (async () => {
            let synced = 0;
            let failed = 0;
            for (const id of pending) {
                if (!this.isCurrentAuth(context)) break;
                const pos = this.state.positions.find((p) => String(p.id) === id);
                if (!pos || pos.sentToBackend === true || this.isRemoteClosePending(id)) continue;
                const result = await this.syncOpenPosition(pos);
                if (result.ok) synced++;
                else failed++;
            }
            return { synced, failed };
        })().finally(() => { if (this.mirrorPromise === task) this.mirrorPromise = null; });
        this.mirrorPromise = task;
        return task;
    },

    syncStateFromServer() {
        if (!window.MasakoAuth?.isAuthenticated || !window.apiFetch) return Promise.resolve(null);
        if (!this.prepareAccountState()) return Promise.resolve(null);
        if (this.syncStatePromise && this.syncStateUserId === getAuthenticatedUserId()
            && this.syncStateEpoch === this.authEpoch) return this.syncStatePromise;

        // Ignore a stale snapshot if an optimistic local open/close/edit occurs
        // while this request is in flight. The next timed sync will reconcile
        // once all local mutations have reached the server.
        const context = this.authContext();
        this.syncStateUserId = context.userId;
        this.syncStateEpoch = context.epoch;
        const requestVersion = this.localMutationVersion;
        const requestSettlementVersion = this.remoteSettlementVersion;
        const task = Promise.resolve().then(async () => {
            try {
                if (!this.isCurrentAuth(context)) return { success: false, skippedAuthChange: true };
                const res = await window.apiFetch('/api/get-state');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (!data || data.success !== true || !Array.isArray(data.positions)
                    || !Array.isArray(data.history) || !Number.isFinite(data.balance) || data.balance < 0) {
                    throw new Error('Incomplete state snapshot');
                }
                if (!this.isCurrentAuth(context)) return { success: false, skippedAuthChange: true };

                if (this.localMutationVersion !== requestVersion || this.remoteSettlementVersion !== requestSettlementVersion || this.hasPendingRemoteWrite()) {
                    return { success: true, skippedStaleSnapshot: true };
                }

                // Reconcile, never blindly replace. A server snapshot can be
                // legitimately empty (a fresh account logging in for the
                // first time). Storage failures must reject the snapshot. The
                // old unconditional assignment wiped live positions and the
                // closed ledger with it. Server rows win for the ids they
                // know; local-only rows survive below until they are
                // mirrored up.
                const hydrated = data.positions.map((position) => this.hydrateServerPosition(position));
                if (hydrated.some((position) => !position)) throw new Error('Invalid position snapshot');
                const tombstonedRows = hydrated.filter((position) => this.isRemoteClosePending(position.id));
                // Retain a close intent while the server still has its row,
                // even if settlement has been unavailable for several days.
                tombstonedRows.forEach((position) => {
                    this.pendingRemoteCloses[String(position.id)].closedAt = Date.now();
                });
                if (tombstonedRows.length) this.persistRemoteCloseTombstones();
                const serverPositions = hydrated.filter((position) => !this.isRemoteClosePending(position.id));
                // An entry may have reached the server even though its POST
                // acknowledgement was lost. Never reopen it after a real exit.
                const closedIds = new Set(data.history.filter(isTerminalPositionHistory).map((row) => String(row.id)));
                let adoptedLocalRows = 0;
                if (serverPositions) {
                    const serverIds = new Set(serverPositions.map((p) => String(p.id)));
                    const localOnly = (Array.isArray(this.state.positions) ? this.state.positions : [])
                        .filter((p) => p && p.id !== undefined && p.id !== null
                            && p.sentToBackend !== true
                            && (!p.backendUserId || p.backendUserId === context.userId)
                            && !serverIds.has(String(p.id))
                            && !closedIds.has(String(p.id))
                            && !this.isRemoteClosePending(p.id));
                    adoptedLocalRows = localOnly.length;
                    this.state.positions = serverPositions.concat(localOnly);
                }
                if (Array.isArray(data.history)) {
                    futuresLog = mergeLedgerPreservingLocal(data.history, futuresLog);
                }
                // A 404 tombstone guards against a late POST without
                // freezing balance sync for an already-absent server row.
                const hasUnreconciledLocalState = adoptedLocalRows > 0
                    || this.hasPendingRemoteWrite() || tombstonedRows.length > 0;
                if (Number.isFinite(data.balance) && !hasUnreconciledLocalState) {
                    // Never let a stale/empty server snapshot wipe a positive local
                    // balance while we still hold open positions. A 0 from the server
                    // usually means the row doesn't exist yet, not that funds are gone.
                    const localHasFunds = Number(this.state.balance) > 0 && (this.state.positions || []).length > 0;
                    if (!(data.balance === 0 && localHasFunds)) {
                        this.state.balance = data.balance;
                    }
                }
                if (adoptedLocalRows > 0) {
                    // Upload guest/offline rows now so the server becomes
                    // authoritative again and the next sync is a plain
                    // replace. Failures stay pending and retry on sync.
                    this.mirrorUnsyncedLocalPositions();
                }
                if (data.autoBacktest && window.AutoBacktestAI && typeof window.AutoBacktestAI.syncFromServer === 'function') {
                    window.AutoBacktestAI.syncFromServer(data.autoBacktest);
                }
                // Server engine health: drives the "engine 24/7" status line and
                // decides whether this tab may still open auto entries itself.
                if (data.engine && window.AutoBacktestAI && typeof window.AutoBacktestAI.setServerEngineStatus === 'function') {
                    window.AutoBacktestAI.setServerEngineStatus(data.engine);
                }
                this.save();
                if (typeof updateEquityDisplay === 'function') updateEquityDisplay();
                if (typeof updateLedgerUI === 'function') updateLedgerUI();
                if (typeof scheduleChartRender === 'function') scheduleChartRender(true);
                return data;
            } catch (e) {
                if (window.MASAKO_DEBUG) console.warn('State sync unavailable; retaining local state:', e);
                return null;
            } finally {
                if (this.syncStatePromise === task) this.syncStatePromise = null;
                // A failed delete stays tombstoned and is retried on later
                // periodic/focus syncs. Its local close is never rolled back.
                this.flushPendingRemoteCloses();
            }
        });
        this.syncStatePromise = task;
        return task;
    },

    persistLocalState() {
        const saved = safeStore('masako_futures_state_v44', { ...this.state, history: futuresLog.slice(0, 200) }, APP_SCHEMA_VERSION);
        if (!saved) {
            if (!this.lastStorageWarningAt || Date.now() - this.lastStorageWarningAt > 10000) {
                this.lastStorageWarningAt = Date.now();
                showToast('Penyimpanan browser tidak tersedia atau penuh. Perubahan belum aman untuk refresh; izinkan penyimpanan browser dan coba lagi.', true, 8000);
            }
            return false;
        }
        this.lastStorageWarningAt = 0;
        // Compatibility only: the snapshot above is authoritative on reload.
        safeStore('masako_flog_v44', futuresLog, APP_SCHEMA_VERSION);
        return true;
    },

    save() {
        const saved = this.persistLocalState();
        this.updateUI();
        return saved;
    },

    syncDeletePosition(id, closedPos = null) {
        if (!window.MasakoAuth?.isAuthenticated || !window.apiFetch) return Promise.resolve({ ok: false, skipped: true });
        const key = String(id);
        const existing = this.pendingRemoteCloseRequests.get(key);
        if (existing) return existing;
        const priorTombstone = this.pendingRemoteCloses[key];
        if (priorTombstone && priorTombstone.userId !== getAuthenticatedUserId()) return Promise.resolve({ ok: false, skipped: true });
        // Preserve the settlement record on retries/reload. Replacing the
        // tombstone with a null record would delete exposure without its PnL.
        const closeRecord = closedPos || priorTombstone?.closeRecord || null;
        this.markRemoteClosePending(key, closeRecord);
        const context = this.authContext();
        // A full close must wait for a prior partial-close PATCH for this same
        // position; otherwise the server could settle the pre-reduction size.
        const previousUpdate = this.pendingRemotePositionUpdates.get(key);
        const previousOpen = this.pendingRemoteOpens.get(key);
        const request = Promise.all([previousUpdate, previousOpen]).then(() => {
            if (!this.isCurrentAuth(context)) throw new Error('Session changed');
            return window.apiFetch('/api/delete-position', {
                method: 'DELETE',
                body: JSON.stringify({ id: key, closedPos: closeRecord })
            });
        }).then(async (response) => {
            if (!this.isCurrentAuth(context)) throw new Error('Session changed');
            // DELETE is idempotent from the browser's point of view: a 404
            // means it is currently absent, but not necessarily that an
            // earlier timed-out POST cannot still commit (see tombstone below).
            if (!response || (!response.ok && response.status !== 404)) {
                let message = response ? `HTTP ${response.status}` : 'no response';
                try {
                    const body = response && await response.json();
                    if (body && body.error) message = body.error;
                } catch (e) { /* retain HTTP message */ }
                throw new Error(message);
            }
            this.remoteSettlementVersion++;
            // A timed-out POST may still commit after this DELETE returned
            // 404. Keep the persisted tombstone in that case; later syncs
            // suppress the row and retry the delete instead of resurrecting it.
            if (response.status !== 404) this.clearRemoteClosePending(key);
            return { ok: true, alreadyClosed: response.status === 404 };
        }).catch((error) => {
            if (window.MASAKO_DEBUG) console.warn('Remote close pending; local close remains saved:', error);
            return { ok: false, error: error && error.message ? error.message : 'network error' };
        }).finally(() => {
            if (this.pendingRemoteCloseRequests.get(key) === request) this.pendingRemoteCloseRequests.delete(key);
        });
        this.pendingRemoteCloseRequests.set(key, request);
        return request;
    },

    syncUpdatePosition(pos, closedPos = null) {
        if (!pos || !window.MasakoAuth?.isAuthenticated || !window.apiFetch) return Promise.resolve();
        if (pos.backendUserId && pos.backendUserId !== getAuthenticatedUserId()) return Promise.resolve({ ok: false, skipped: true });
        const key = String(pos.id);
        const context = this.authContext();
        // Capture each edit/partial leg now, not the final mutable position
        // after earlier requests finish. Otherwise two rapid reductions can
        // send the last margin with the first leg's exit record.
        const body = JSON.stringify({
            id: key,
            tp: pos.tp,
            sl: pos.sl,
            margin: pos.margin,
            leverage: pos.leverage,
            marginMode: pos.marginMode,
            exchange: pos.exchange || 'Binance',
            fundingRate: Number.isFinite(pos.fundingRate) ? pos.fundingRate : 0,
            fundingPnl: Number.isFinite(pos.fundingPnl) ? pos.fundingPnl : 0,
            lastFundingSettle: pos.lastFundingSettle,
            openTime: pos.openTime,
            closedPos: closedPos
        });
        const previousUpdate = this.pendingRemotePositionUpdates.get(key);
        const previousOpen = this.pendingRemoteOpens.get(key);
        const request = Promise.all([previousUpdate, previousOpen]).catch(() => null).then(() => {
            if (!this.isCurrentAuth(context)) throw new Error('Session changed');
            return window.apiFetch('/api/update-position', { method: 'PATCH', body });
        }).then(async (response) => {
            if (!this.isCurrentAuth(context)) throw new Error('Session changed');
            if (!response || !response.ok) {
                let message = response ? `HTTP ${response.status}` : 'no response';
                try {
                    const body = response && await response.json();
                    if (body && body.error) message = body.error;
                } catch (e) { /* retain HTTP message */ }
                throw new Error(message);
            }
            this.remoteSettlementVersion++;
            return { ok: true };
        }).catch((error) => {
            if (window.MASAKO_DEBUG) console.warn('Remote position update pending:', error);
            return { ok: false, error: error && error.message ? error.message : 'network error' };
        }).finally(() => {
            if (this.pendingRemotePositionUpdates.get(key) === request) this.pendingRemotePositionUpdates.delete(key);
        });
        this.pendingRemotePositionUpdates.set(key, request);
        return request;
    },

    clearLocalPositions({ persist = true } = {}) {
        this.state.positions = [];
        this.noteLocalMutation();
        this.clearChartLines();
        if (persist) this.save();
        else this.updateUI();
    },
    
    setCustomBalance() { 
        let val = prompt("Atur Saldo Demo USDT:", this.state.balance.toFixed(2)); 
        if (val !== null) { 
            let amount = parseFloat(val); 
            if (!isNaN(amount) && amount >= 0) { 
                this.state.balance = amount; 
                this.save(); 
                showToast(`Saldo diatur ke $${amount}`); 
            } else { 
                showToast("Nominal tidak valid!", true); 
            } 
        } 
    },

    // Mark price of a position's pair. Only the charted pair has a websocket
    // feed; other pairs use the price poller (AppState.lastPrices).
    getMarkPrice(pos) {
        if (!pos) return 0;
        if (pos.pair === AppState.g_pair && Number(AppState.price) > 0) return Number(AppState.price);
        const last = Number(AppState.lastPrices && AppState.lastPrices[pos.pair]);
        if (last > 0) return last;
        const known = Number(pos.lastKnownPrice);
        if (known > 0) return known;
        return Number(pos.entryPrice) || 0;
    },

    // Unrealized PNL of one position (price PNL + accrued funding), no fees.
    getPositionPnl(pos) {
        const mark = this.getMarkPrice(pos);
        const entry = Number(pos && pos.entryPrice);
        const size = Number(pos && pos.sizeBase);
        let pricePnl = 0;
        if (mark > 0 && Number.isFinite(entry) && Number.isFinite(size)) {
            pricePnl = pos.type === 'LONG' ? (mark - entry) * size : (entry - mark) * size;
        }
        const funding = (Number(pos && pos.fundingPnl) || 0) + (Number(pos && pos._fundingAccrued) || 0);
        const margin = Number(pos && pos.margin);
        const total = pricePnl + funding;
        return {
            mark,
            pricePnl,
            fundingPnl: funding,
            totalPnl: total,
            pnlPct: margin > 0 ? (total / margin) * 100 : 0
        };
    },

    // Single source of truth for the account figures shown live in the UI.
    // ISOLATED margin was already deducted from the wallet, so it is added
    // back; CROSS margin never leaves the wallet, so only PNL moves equity.
    getAccountSummary() {
        const wallet = Number(this.state.balance) || 0;
        let isolatedMargin = 0;
        let unrealizedPnl = 0;
        (this.state.positions || []).forEach((pos) => {
            if (pos.marginMode === 'ISOLATED') isolatedMargin += Number(pos.margin) || 0;
            unrealizedPnl += this.getPositionPnl(pos).totalPnl;
        });
        return {
            wallet,
            unrealizedPnl,
            equity: wallet + isolatedMargin + unrealizedPnl,
            positionCount: (this.state.positions || []).length
        };
    },

    // Active positions grouped per coin (pair). Charted pair first.
    getActiveGroups() {
        const groups = new Map();
        (this.state.positions || []).forEach((pos) => {
            if (!pos || !pos.pair) return;
            if (!groups.has(pos.pair)) groups.set(pos.pair, { pair: pos.pair, positions: [] });
            groups.get(pos.pair).positions.push(pos);
        });
        return Array.from(groups.values()).sort((a, b) => {
            if (a.pair === AppState.g_pair) return -1;
            if (b.pair === AppState.g_pair) return 1;
            return a.pair.localeCompare(b.pair);
        });
    },

    // Closes every open position (optionally only one pair) at market. Runs
    // a second pass for anything that survived so nothing is left behind, and
    // reports what could not be closed instead of hiding it.
    closeAllPositions(pair = null, closeReason = 'CLOSE ALL') {
        const matches = (p) => !pair || p.pair === pair;
        let closed = 0;
        let totalPnl = 0;
        const collect = () => this.state.positions.filter(matches).map((p) => p.id);
        for (let pass = 0; pass < 2; pass++) {
            const ids = collect();
            if (ids.length === 0) break;
            ids.forEach((id) => {
                const result = this.closePosition(id, false, closeReason, 100, null, null, false, { silent: true });
                if (result && result.ok) {
                    closed++;
                    totalPnl += Number(result.log && result.log.pnl) || 0;
                }
            });
        }
        const remaining = collect().length;
        if (typeof updateEquityDisplay === 'function') updateEquityDisplay();
        if (typeof updateLedgerUI === 'function') updateLedgerUI();
        return { closed, remaining, totalPnl };
    },

    calculateLiqPrice(pos, currentBalance) { 
        const markPrice = (pos.pair === AppState.g_pair) ? AppState.price : (AppState.lastPrices[pos.pair] || pos.entryPrice);
        let mm = pos.sizeBase * pos.entryPrice * this.MM_RATE;
        let liq = 0; 
        
        if (pos.marginMode === 'ISOLATED') {
            liq = pos.type === 'LONG' ? pos.entryPrice - safeDiv((pos.margin - mm), pos.sizeBase) : pos.entryPrice + safeDiv((pos.margin - mm), pos.sizeBase); 
        } else { 
            let totalEq = getTotalUnrealizedEquity({ [pos.pair]: markPrice }, Number.isFinite(currentBalance) ? currentBalance : this.state.balance);
            liq = pos.type === 'LONG' ? pos.entryPrice - safeDiv((totalEq - mm), pos.sizeBase) : pos.entryPrice + safeDiv((totalEq - mm), pos.sizeBase); 
        } 
        return liq < 0 ? 0 : liq; 
    },
    
    getHedgeBuckets(pair = AppState.g_pair) {
        const related = this.state.positions.filter(p => p.pair === pair && p.autoHedgeTrail);
        return {
            longs: related.filter(p => p.type === 'LONG'),
            shorts: related.filter(p => p.type === 'SHORT')
        };
    },
    
    checkOfflineHits() {
        if (this.state.positions.length === 0) return;
        const candles = [...AppState.candles].sort((a, b) => a.time - b.time); 
        if (candles.length === 0) return;
        
        const tempPositions = this.state.positions.map(p => ({ ...p, _closed: false }));
        let tempBalance = this.state.balance;
        const toClose = [];

        const simulateClose = (pos, isLiquidated, closePrice, closeTimeSec, closeReason) => {
            const closeRatio = 1;
            const realizedSizeBase = pos.sizeBase * closeRatio;
            const closeFee = (realizedSizeBase * closePrice) * FEES.TAKER;
            const rawPnl = pos.type === 'LONG' ? (closePrice - pos.entryPrice) * realizedSizeBase : (pos.entryPrice - closePrice) * realizedSizeBase;
            let netPnlAbs = rawPnl - closeFee;
            const realizedMargin = pos.margin * closeRatio;

            if (!isLiquidated) {
                const returnedMargin = pos.marginMode === 'ISOLATED' ? realizedMargin + netPnlAbs : netPnlAbs;
                tempBalance += returnedMargin;
            } else if (pos.marginMode === 'CROSS') {
                tempBalance = 0;
            }
            toClose.push({ id: pos.id, isLiq: isLiquidated, reason: closeReason, price: closePrice, time: closeTimeSec });
            pos._closed = true;
        };
        
        for (let c of candles) {
            const candleMs = c.time * 1000;
            const active = tempPositions
                .filter(pos => !pos._closed && pos.pair === AppState.g_pair && !pos.sentToBackend && candleMs > pos.openTime)
                .sort((a, b) => a.openTime - b.openTime);

            for (const pos of active) {
                const liqP = this.calculateLiqPrice(pos, tempBalance);
                if (pos.type === 'LONG') {
                    if (c.low <= liqP) { simulateClose(pos, true, liqP, c.time, 'LIQUIDATED (OFFLINE)'); continue; }
                    if (pos.sl && c.low <= pos.sl) { simulateClose(pos, false, pos.sl, c.time, 'STOP LOSS (OFFLINE)'); continue; }
                    if (pos.tp && c.high >= pos.tp) { simulateClose(pos, false, pos.tp, c.time, 'TAKE PROFIT (OFFLINE)'); continue; }
                } else {
                    if (c.high >= liqP) { simulateClose(pos, true, liqP, c.time, 'LIQUIDATED (OFFLINE)'); continue; }
                    if (pos.sl && c.high >= pos.sl) { simulateClose(pos, false, pos.sl, c.time, 'STOP LOSS (OFFLINE)'); continue; }
                    if (pos.tp && c.low <= pos.tp) { simulateClose(pos, false, pos.tp, c.time, 'TAKE PROFIT (OFFLINE)'); continue; }
                }
            }
        }
        
        toClose
            .sort((a, b) => b.time - a.time)
            .forEach(c => this.closePosition(c.id, c.isLiq, c.reason, 100, c.price, c.time, true));
    },

    async openPosition(type, isAi = false, overrides = null) {
        // Login is OPTIONAL. A demo position is always created locally and
        // persisted to localStorage; when the user happens to be signed in the
        // same position is mirrored to the backend afterwards.
        //
        // `overrides` lets an automated caller (Auto Backtest AI) size the
        // position itself instead of reading the manual form fields:
        //   { margin, leverage, marginMode, origin, autoBacktest, useTrailing,
        //     useBe, autoRr, silent, signalSnapshot }
        const isAuthenticated = Boolean(window.MasakoAuth?.isAuthenticated);
        const ov = overrides && typeof overrides === 'object' ? overrides : {};
        const silent = ov.silent === true;
        try {
            if (isAuthenticated && !this.prepareAccountState()) return;
            // Atomic guard: set the flag before the first await so two rapid
            // clicks cannot both pass the check and create a duplicate.
            if (AppState.pendingOpenPositionSave) {
                if (!silent) showToast('Permintaan buka posisi masih diproses. Tunggu sampai sinkronisasi selesai.', true);
                return;
            }
            AppState.pendingOpenPositionSave = true;
            this.syncOpenPositionButtons();

            const amountInput = Number.isFinite(ov.margin)
                ? ov.margin
                : parseFloat(document.getElementById('trade-amount').value);
            const leverage = Number.isFinite(ov.leverage)
                ? Math.round(ov.leverage)
                : parseInt(document.getElementById('leverage-slider').value);
            const marginMode = typeof ov.marginMode === 'string' && ov.marginMode
                ? ov.marginMode
                : document.getElementById('margin-mode').value;
            const exchange = typeof ov.exchange === 'string' && ov.exchange
                ? ov.exchange
                : (document.getElementById('trade-exchange')?.value || 'Binance');
            // Funding rate saat ini berdasarkan exchange + pair yang dipilih (dari ArbitrageScanner cache).
            let currentFundingRate = 0;
            try {
                const coinBase = AppState.g_pair.replace('USDT', '');
                if (window.ArbitrageScanner) {
                    const exData = window.ArbitrageScanner.getExchangeData(exchange);
                    if (exData && Number.isFinite(exData[coinBase])) {
                        currentFundingRate = exData[coinBase];
                    } else {
                        // fallback: rata-rata dari semua exchange yang punya data
                        const rates = [];
                        ['Binance', 'OKX', 'Bybit'].forEach((ex) => {
                            const d = window.ArbitrageScanner.getExchangeData(ex);
                            if (d && Number.isFinite(d[coinBase])) rates.push(d[coinBase]);
                        });
                        if (rates.length > 0) currentFundingRate = rates.reduce((a, b) => a + b, 0) / rates.length;
                    }
                }
                // Universe LOCAL ARBITRAGE: funding per venue dengan symbol mapping
                // yang sudah benar, dipakai saat cache scanner belum punya pair ini.
                if (!Number.isFinite(currentFundingRate) || currentFundingRate === 0) {
                    if (window.MarketUniverse) {
                        const funding = window.MarketUniverse.getFunding(AppState.g_pair);
                        if (funding) {
                            if (Number.isFinite(funding[exchange])) {
                                currentFundingRate = funding[exchange];
                            } else {
                                const known = Object.keys(funding).filter((ex) => Number.isFinite(funding[ex]));
                                if (known.length > 0) {
                                    currentFundingRate = known.reduce((sum, ex) => sum + funding[ex], 0) / known.length;
                                }
                            }
                        }
                    }
                }
            } catch (e) { /* funding 0 is safe default */ }
            if (!Number.isFinite(currentFundingRate)) currentFundingRate = 0;

            if (!validateTrade(type, amountInput, leverage, marginMode)) {
                return;
            }
            const useTrailing = ov.useTrailing !== undefined
                ? ov.useTrailing === true
                : document.getElementById('use-trailing').checked;
            const useBe = ov.useBe !== undefined
                ? ov.useBe === true
                : document.getElementById('use-be').checked;
            const useAutoRr = ov.autoRr !== undefined
                ? ov.autoRr === true
                : (document.getElementById('auto-rr-manual') ? document.getElementById('auto-rr-manual').checked : false);
            
            // Stale price guard: right after switching pairs, AppState.price may still
            // hold the previous coin's quote. If a fresh quote for this pair is
            // available and differs significantly, use it instead (user bug report 2026-10-09:
            // "open posisi koin apa tapi entry price dari koin lain").
            let livePrice = Number(AppState.price);
            const freshQuote = Number(AppState.lastPrices && AppState.lastPrices[AppState.g_pair]);
            if (Number.isFinite(freshQuote) && freshQuote > 0 && Number.isFinite(livePrice) && livePrice > 0) {
                const deviation = Math.abs(livePrice - freshQuote) / freshQuote;
                if (deviation > 0.20) {
                    livePrice = freshQuote;
                }
            }
            if (!Number.isFinite(livePrice) || livePrice <= 0) {
                if (!silent) showToast('Data harga belum siap. Coba lagi sesaat.', true, 5000);
                AppState.pendingOpenPositionSave = false;
                this.syncOpenPositionButtons();
                return;
            }
            let entryPrice = type === 'LONG' ? livePrice * (1 + FEES.SLIPPAGE) : livePrice * (1 - FEES.SLIPPAGE);
            const sizeBase = safeDiv((amountInput * leverage), entryPrice);
            let execFee = amountInput * leverage * FEES.TAKER;
            
            let finalTP = null;
            let finalSL = null;

            if (isAi || useAutoRr) {
                let atr = AppState.live.atr || (livePrice * 0.01);
                let mTP = AppState.live.risk === "HIGH" ? 3 : (AppState.live.risk === "LOW" ? 1.5 : 2);
                let mSL = AppState.live.risk === "HIGH" ? 1.5 : (AppState.live.risk === "LOW" ? 0.7 : 1);
                finalTP = type === "LONG" ? entryPrice + (atr * mTP) : entryPrice - (atr * mTP);
                finalSL = type === "LONG" ? entryPrice - (atr * mSL) : entryPrice + (atr * mSL);
            } else {
                let manTpPx = parseFloat(document.getElementById('tp-price').value);
                let tpPctSel = document.getElementById('tp-pct-sel').value;
                let tpPct = tpPctSel === 'custom' ? parseFloat(document.getElementById('tp-pct-custom').value) : parseFloat(tpPctSel);

                let manSlPx = parseFloat(document.getElementById('sl-price').value);
                let slPctSel = document.getElementById('sl-pct-sel').value;
                let slPct = slPctSel === 'custom' ? parseFloat(document.getElementById('sl-pct-custom').value) : parseFloat(slPctSel);

                if (!isNaN(manTpPx) && manTpPx > 0) {
                    finalTP = manTpPx;
                } else if (!isNaN(tpPct)) {
                    let offset = entryPrice * ((Math.abs(tpPct) / 100) / leverage);
                    finalTP = type === 'LONG' ? entryPrice + offset : entryPrice - offset;
                }

                if (!isNaN(manSlPx) && manSlPx > 0) {
                    finalSL = manSlPx;
                } else if (!isNaN(slPct)) {
                    let offset = entryPrice * ((Math.abs(slPct) / 100) / leverage);
                    finalSL = type === 'LONG' ? entryPrice - offset : entryPrice + offset;
                }
            }

            if (finalTP && ((type === 'LONG' && finalTP <= entryPrice) || (type === 'SHORT' && finalTP >= entryPrice))) {
                showToast("Peringatan: TP di sisi rugi, diabaikan.", true);
                finalTP = null;
            }
            if (finalSL && ((type === 'LONG' && finalSL >= entryPrice) || (type === 'SHORT' && finalSL <= entryPrice))) {
                showToast("Peringatan: SL berada di sisi berlawanan dari aturan simulasi, diabaikan.", true);
                finalSL = null;
            }

            if ((!finalTP || !finalSL) && !silent) {
                showToast("Posisi demo dibuka tanpa TP/SL lengkap. Kelola risiko manual atau tambahkan TP/SL nanti.", true);
            }

            const tsActInput = Number.isFinite(ov.tsActivation)
                ? ov.tsActivation
                : parseFloat(document.getElementById('ts-activation').value);
            const tsCallInput = Number.isFinite(ov.tsCallback)
                ? ov.tsCallback
                : parseFloat(document.getElementById('ts-callback').value);

            const newPos = {
                id: window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${++this.positionSequence}`,
                pair: AppState.g_pair,
                type: type,
                entryPrice: entryPrice,
                lastKnownPrice: entryPrice,
                margin: amountInput,
                leverage: leverage,
                marginMode: marginMode,
                sizeBase: sizeBase,
                sizeUsd: amountInput * leverage,
                exchange: exchange,
                fundingRate: currentFundingRate,
                fundingPnl: 0,
                lastFundingSettle: Date.now(),
                isAi: isAi,
                openTime: Date.now(),
                tp: finalTP,
                sl: finalSL,
                dominantStrategy: AppState.live.dominantStrategy,
                maxFavorablePrice: entryPrice,
                useTrailing: useTrailing,
                useBe: useBe,
                autoHedgeTrail: ov.autoHedgeTrail !== undefined
                    ? ov.autoHedgeTrail === true
                    : (document.getElementById('use-hedge-ts') ? document.getElementById('use-hedge-ts').checked : false),
                origin: typeof ov.origin === 'string' ? ov.origin : 'MANUAL',
                copyMeta: ov.copyMeta && typeof ov.copyMeta === 'object' ? ov.copyMeta : null,
                autoBacktest: ov.autoBacktest === true,
                signalSnapshot: ov.signalSnapshot && typeof ov.signalSnapshot === 'object' ? ov.signalSnapshot : null,
                beLocked: false,
                atrSnapshot: AppState.live.atr,
                tsActivation: isNaN(tsActInput) || tsActInput <= 0 ? null : tsActInput,
                tsCallback: isNaN(tsCallInput) || tsCallInput <= 0 ? null : tsCallInput,
                tsIsActive: false,
                tsExtremePrice: entryPrice,
                hedgeLinked: false,
                sentToBackend: false
            };
            // Mark before awaiting the optional mirror so an in-flight remote
            // snapshot can never overwrite this local user action.
            this.noteLocalMutation();
            // Local commit FIRST. A position the UI accepted must already be
            // in localStorage before any network call touches it, so a tab
            // that dies (or a backend that hangs) mid-mirror still reopens
            // with the position intact. `sentToBackend === false` marks it
            // pending, and the next sync re-mirrors it.
            const previousBalance = this.state.balance;
            if (marginMode === 'ISOLATED') {
                this.state.balance -= (amountInput + execFee);
            } else {
                this.state.balance -= execFee;
            }
            newPos.sentToBackend = false;
            this.state.positions.push(newPos);
            if (!this.persistLocalState()) {
                this.state.positions.pop();
                this.state.balance = previousBalance;
                throw new Error('Posisi tidak dibuka karena gagal disimpan di browser.');
            }
            this.updateUI();

            // The local transaction is committed; the button lock and the
            // automation engine must not wait on the optional mirror.
            AppState.pendingOpenPositionSave = false;
            this.syncOpenPositionButtons();

            try {
                if (window.AnimalNeuralSystem && typeof window.AnimalNeuralSystem.recordPositionOpened === 'function') {
                    window.AnimalNeuralSystem.recordPositionOpened(newPos);
                }
            } catch (e) { /* learning hook optional */ }

            AppState.aiSignalMarkers = [{ 
                pair: AppState.g_pair, 
                time: Math.floor(Date.now()/1000), 
                position: type==='LONG'?'belowBar':'aboveBar', 
                color: type==='LONG'?'#fbbf24':'#ef4444', 
                shape: type==='LONG'?'arrowUp':'arrowDown', 
                text: type 
            }];
            
            if (typeof scheduleChartRender === 'function') scheduleChartRender(); 
            else renderFullChart(); 
            this.drawChartLines(); 
            if (typeof updateEquityDisplay === 'function') updateEquityDisplay();

            if (!silent) showToast(`Posisi Terbuka: ${newPos.pair} ${newPos.type} ${newPos.leverage}x`, false, 3000);

            // Backend mirroring only happens for signed-in users. When the
            // request fails the position is still created locally so a demo
            // session never depends on the network.
            let backendError = null;
            if (isAuthenticated && window.apiFetch) {
                const result = await this.syncOpenPosition(newPos);
                if (!result.ok && !result.skipped) backendError = result.error;
            }

            if (backendError && !silent) {
                showToast(`Posisi disimpan lokal, sinkronisasi akun gagal: ${backendError}`, true, 5000);
            }
        } catch (error) {
            console.error('openPosition failed:', error);
            showToast(`Gagal membuka posisi: ${error.message}`, true, 5000);
        } finally {
            AppState.pendingOpenPositionSave = false;
            this.syncOpenPositionButtons();
        }
    },

    syncOpenPositionButtons() {
        ['btn-long-sim', 'btn-short-sim', 'btn-ai-execute-sim'].forEach((id) => {
            const button = document.getElementById(id);
            if (!button) return;
            button.disabled = !!AppState.pendingOpenPositionSave;
            button.setAttribute('aria-busy', AppState.pendingOpenPositionSave ? 'true' : 'false');
        });
    },
    
    closePosition(id, isLiquidated = false, closeReason = "CLOSED", closePct = 100, forcedPrice = null, forcedTime = null, isOfflineClose = false, options = {}) {
        const silent = !!(options && options.silent);
        const idx = this.state.positions.findIndex((p) => String(p && p.id) === String(id));
        if (idx === -1) {
            return { ok: false, reason: 'POSITION_NOT_FOUND' };
        }

        let normalizedClosePct = Number(closePct);
        if (!Number.isFinite(normalizedClosePct) || normalizedClosePct <= 0) {
            return { ok: false, reason: 'INVALID_CLOSE_PERCENTAGE' };
        }
        // Liquidation always settles the entire position. Manual closes are
        // clamped to a valid percentage even if a caller bypasses the slider.
        normalizedClosePct = isLiquidated ? 100 : Math.min(100, normalizedClosePct);
        const closeRatio = normalizedClosePct / 100;
        const fullyClosing = normalizedClosePct >= 100;

        const pos = this.state.positions[idx];
        const margin = Number(pos.margin);
        const leverage = Number(pos.leverage);
        const entryPrice = Number(pos.entryPrice);
        if (!Number.isFinite(margin) || margin <= 0 || !Number.isFinite(leverage) || leverage <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
            return { ok: false, reason: 'INVALID_POSITION' };
        }
        // Older server records did not contain `sizeBase`. Derive it once so
        // those positions remain manually closable after an authenticated sync.
        const positionSizeBase = Number.isFinite(Number(pos.sizeBase)) && Number(pos.sizeBase) > 0
            ? Number(pos.sizeBase)
            : safeDiv(margin * leverage, entryPrice);
        if (!Number.isFinite(positionSizeBase) || positionSizeBase <= 0) {
            return { ok: false, reason: 'INVALID_POSITION_SIZE' };
        }
        pos.margin = margin;
        pos.leverage = leverage;
        pos.entryPrice = entryPrice;
        pos.sizeBase = positionSizeBase;
        pos.sizeUsd = Number.isFinite(Number(pos.sizeUsd)) && Number(pos.sizeUsd) > 0
            ? Number(pos.sizeUsd)
            : margin * leverage;

        // Price resolution: NEVER use the live chart price for a different pair.
        // During pair switches there is a brief window where AppState.g_pair has
        // changed but AppState.price still holds the old pair's quote. If the live
        // price deviates more than 20% from the position's last known price, the
        // feed hasn't caught up yet — fall back to lastPrices/lastKnownPrice.
        let currentPairPrice;
        if (pos.pair === AppState.g_pair && Number(AppState.price) > 0) {
            const livePx = Number(AppState.price);
            const knownPx = Number(pos.lastKnownPrice);
            if (Number.isFinite(knownPx) && knownPx > 0 && Math.abs(livePx - knownPx) / knownPx > 0.20) {
                currentPairPrice = (Number(AppState.lastPrices?.[pos.pair]) || knownPx || entryPrice);
            } else {
                currentPairPrice = livePx;
            }
        } else {
            currentPairPrice = (Number(AppState.lastPrices?.[pos.pair]) || Number(pos.lastKnownPrice) || entryPrice);
        }
        let exitPrice = forcedPrice !== null
            ? Number(forcedPrice)
            : (pos.type === 'LONG' ? currentPairPrice * (1 - FEES.SLIPPAGE) : currentPairPrice * (1 + FEES.SLIPPAGE));
        if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
            exitPrice = entryPrice;
        }
        const closeTime = isOfflineClose ? Date.now() : (forcedTime !== null ? Number(forcedTime) * 1000 : Date.now());
        const realizedSizeBase = positionSizeBase * closeRatio;
        const closeFee = realizedSizeBase * exitPrice * FEES.TAKER;
        const rawPnl = pos.type === 'LONG'
            ? (exitPrice - entryPrice) * realizedSizeBase
            : (entryPrice - exitPrice) * realizedSizeBase;
        // Sertakan funding P&L akumulasi (permanen + akrual yang belum settle) ke PnL final
        const finalFundingPnl = ((pos.fundingPnl || 0) + (pos._fundingAccrued || 0)) * closeRatio;
        let netPnlAbs = rawPnl - closeFee + finalFundingPnl;
        const realizedMargin = margin * closeRatio;

        if (!isLiquidated) {
            const returnedMargin = pos.marginMode === 'ISOLATED' ? realizedMargin + netPnlAbs : netPnlAbs;
            if (Number.isFinite(returnedMargin)) {
                this.state.balance += returnedMargin;
            }
            if (!silent) showToast(`Ditutup (${normalizedClosePct}%). PNL: $${netPnlAbs.toFixed(2)}`);
        } else {
            if (pos.marginMode === 'CROSS') {
                // Cross liquidation: deduct the position loss from balance, floored at 0.
                // Never wipe the entire account on a single liquidation unless the
                // calculated loss truly exceeds the available equity.
                const liqLoss = margin + Math.max(0, -(rawPnl - closeFee));
                const maxDeduct = this.state.balance + margin;
                const actualDeduction = Math.min(liqLoss, maxDeduct);
                netPnlAbs = -actualDeduction;
                this.state.balance = Math.max(0, this.state.balance - Math.max(0, actualDeduction - margin));
            } else {
                netPnlAbs = -margin;
            }
            showToast('⚠️ LIQUIDATED!', true);
        }
        // Sanity guard: PnL must never be absurd. If data corruption produces a
        // PnL beyond 100x margin, clamp it and warn instead of writing garbage
        // to the ledger (prevents the "+$10B on liquidation" display bug).
        const maxSanePnl = Math.max(margin * 100, 1);
        if (!Number.isFinite(netPnlAbs) || Math.abs(netPnlAbs) > maxSanePnl) {
            try { console.warn('[FuturesEngine] Absurd PnL clamped:', netPnlAbs, 'margin:', margin, 'pair:', pos.pair); } catch (e) {}
            netPnlAbs = isLiquidated ? -margin : Math.max(-margin, Math.min(netPnlAbs, maxSanePnl));
        }

        const fLog = {
            id: pos.id,
            pair: pos.pair,
            type: pos.type,
            entryPrice: entryPrice,
            exitPrice: exitPrice,
            margin: realizedMargin,
            leverage: leverage,
            marginMode: pos.marginMode,
            exchange: pos.exchange || 'Binance',
            pnl: netPnlAbs,
            pricePnl: rawPnl - closeFee,
            fundingPnl: finalFundingPnl,
            openTime: pos.openTime,
            closeTime: Number.isFinite(closeTime) ? closeTime : Date.now(),
            status: isLiquidated ? 'LIQ' : `${normalizedClosePct}% CLOSED`,
            closeReason: isLiquidated ? 'LIQUIDATION' : closeReason,
            isAi: pos.isAi,
            dominantStrategy: pos.dominantStrategy,
            // Penanda copy trade untuk Trading Ledger (2026-11-02): tanpa
            // ini, history posisi copy yang ditutup dari browser kehilangan
            // identitasnya (server closedLog sudah menyimpan origin).
            origin: pos.origin
        };
        futuresLog.unshift(fLog);
        if (futuresLog.length > 200) futuresLog = futuresLog.slice(0, 200);

        // A loss streak and strategy outcome describe a completed trade, not
        // each partial reduction of one still-open position. Sum prior legs
        // from this position so learning is not trained only on its last exit.
        const priorTradeLegs = futuresLog.slice(1).filter((log) => String(log && log.id) === String(pos.id));
        const completedTradePnl = priorTradeLegs.reduce((total, log) => {
            const pnl = Number(log && log.pnl);
            return total + (Number.isFinite(pnl) ? pnl : 0);
        }, netPnlAbs);
        const completedTradeMargin = priorTradeLegs.reduce((total, log) => {
            const legMargin = Number(log && log.margin);
            return total + (Number.isFinite(legMargin) && legMargin > 0 ? legMargin : 0);
        }, realizedMargin);
        if (fullyClosing) {
            if (completedTradePnl < 0) AppState.drawdownGuard.lossStreak++;
            else AppState.drawdownGuard.lossStreak = 0;
            safeStore('masako_dd_guard_v44', AppState.drawdownGuard, APP_SCHEMA_VERSION);

            try {
                if (window.AnimalNeuralSystem && typeof window.AnimalNeuralSystem.recordTradeOutcome === 'function') {
                    window.AnimalNeuralSystem.recordTradeOutcome({ pair: fLog.pair, direction: fLog.type, pnl: completedTradePnl });
                }
            } catch (e) { /* learning hook optional */ }

            if (pos.origin === 'AUTO_BACKTEST_AI') {
                try {
                    if (window.AutoBacktestAI && typeof window.AutoBacktestAI.recordClose === 'function') {
                        window.AutoBacktestAI.recordClose(pos, {
                            pnl: completedTradePnl,
                            reason: isLiquidated ? 'LIQUIDATION' : closeReason,
                            pair: pos.pair,
                            type: pos.type
                        });
                    }
                } catch (e) { /* ledger hook optional */ }
            }

            if (pos.isAi && pos.dominantStrategy && pos.dominantStrategy !== 'NONE') {
                const strat = pos.dominantStrategy;
                if (AI_STATS[strat]) {
                    if (completedTradePnl > 0) {
                        AI_STATS[strat].wins++;
                        AI_STATS[strat].grossPnL += completedTradePnl;
                    } else {
                        AI_STATS[strat].losses++;
                        AI_STATS[strat].grossPnL += completedTradePnl;
                        AI_STATS[strat].maxDD = Math.max(
                            AI_STATS[strat].maxDD,
                            Math.abs(completedTradePnl) / Math.max(completedTradeMargin, 1e-9)
                        );
                    }
                    recalcAiWeights();
                }
            }
        }

        if (fullyClosing) {
            this.state.positions.splice(idx, 1);
            this.removeChartLine(id);
            this.activateHedgeMate(pos, exitPrice, closeReason);
            // Never await remote mirroring here: local settlement must work
            // without login/network and the persisted tombstone blocks a stale
            // remote GET from resurrecting the closed position.
            if (pos.sentToBackend === true || pos.backendUserId || pos.userId) {
                this.markRemoteClosePending(id, fLog, pos.backendUserId || pos.userId || getAuthenticatedUserId());
            }
            this.syncDeletePosition(id, fLog);

            if (forcedTime === null) {
                AppState.aiSignalMarkers.push({
                    pair: pos.pair,
                    time: Math.floor(fLog.closeTime / 1000),
                    position: 'inBar',
                    color: '#a1a1aa',
                    shape: 'circle',
                    text: 'CLOSE'
                });
                if (AppState.aiSignalMarkers.length > 200) {
                    AppState.aiSignalMarkers = AppState.aiSignalMarkers.slice(-200);
                }
            }
            if (typeof scheduleChartRender === 'function') scheduleChartRender(true);
            else renderFullChart();
        } else {
            pos.margin = Math.max(0, margin - realizedMargin);
            pos.sizeUsd = Math.max(0, pos.sizeUsd - (pos.sizeUsd * closeRatio));
            pos.sizeBase = Math.max(0, positionSizeBase - realizedSizeBase);
            this.syncUpdatePosition(pos, fLog);
        }
        this.noteLocalMutation();
        this.save();

        if (typeof updateEquityDisplay === 'function') updateEquityDisplay();
        if (typeof updateLedgerUI === 'function') updateLedgerUI();
        return { ok: true, closed: fullyClosing, position: fullyClosing ? null : pos, log: fLog };
    },

    getHedgeMate(pos) {
        if (!pos || !pos.autoHedgeTrail) return null;
        const buckets = this.getHedgeBuckets(pos.pair);
        const opposite = pos.type === 'LONG' ? buckets.shorts : buckets.longs;
        return opposite.find(p => p.id !== pos.id) || null;
    },

    syncHedgeTrailingState(pos, currentPrice) {
        const buckets = this.getHedgeBuckets(pos.pair);
        const longBucket = buckets.longs;
        const shortBucket = buckets.shorts;
        if (longBucket.length === 0 || shortBucket.length === 0) return;

        const sharedCallback = Math.max(
            0.1,
            ...longBucket.map(p => Number.isFinite(p.tsCallback) && p.tsCallback > 0 ? p.tsCallback : 0),
            ...shortBucket.map(p => Number.isFinite(p.tsCallback) && p.tsCallback > 0 ? p.tsCallback : 0)
        ) || 1;

        longBucket.forEach(longPos => {
            shortBucket.forEach(shortPos => {
                const longActivation = Number.isFinite(shortPos.sl) && shortPos.sl > 0 ? shortPos.sl : shortPos.entryPrice;
                const shortActivation = Number.isFinite(longPos.sl) && longPos.sl > 0 ? longPos.sl : longPos.entryPrice;

                longPos.tsCallback = sharedCallback;
                shortPos.tsCallback = sharedCallback;
                longPos.tsActivation = longActivation;
                shortPos.tsActivation = shortActivation;
                longPos.hedgeLinked = true;
                shortPos.hedgeLinked = true;

                if (!longPos.tsIsActive && currentPrice >= longActivation) {
                    longPos.tsIsActive = true;
                    longPos.tsExtremePrice = Math.max(longPos.tsExtremePrice || longPos.entryPrice, currentPrice);
                }
                if (!shortPos.tsIsActive && currentPrice <= shortActivation) {
                    shortPos.tsIsActive = true;
                    shortPos.tsExtremePrice = Math.min(shortPos.tsExtremePrice || shortPos.entryPrice, currentPrice);
                }
            });
        });
    },

    activateHedgeMate(closedPos, closePrice, closeReason) {
        if (!closedPos || !closedPos.autoHedgeTrail) return;
        const mates = this.state.positions.filter(p => p.id !== closedPos.id && p.pair === closedPos.pair && p.type !== closedPos.type && p.autoHedgeTrail);
        if (mates.length === 0) return;

        mates.forEach(mate => {
            mate.tsIsActive = true;
            mate.tsExtremePrice = closePrice;
            mate.tsActivation = closePrice;
            mate.tsCallback = Math.max(0.1, closedPos.tsCallback || mate.tsCallback || 1);
            mate.hedgeLinked = true;
        });

        if (typeof showToast === 'function') {
            showToast(`Hedge TS aktif setelah ${closeReason || 'close'} pada sisi lawan.`, false);
        }
    },

    processTrailingStop(pos, currentPrice) {
        if (!pos.tsCallback || pos.tsCallback <= 0) return false;

        const callbackDecimal = pos.tsCallback / 100;

        if (!pos.tsIsActive) {
            if (pos.type === 'LONG' && currentPrice >= (pos.tsActivation || pos.entryPrice)) {
                pos.tsIsActive = true;
                pos.tsExtremePrice = currentPrice;
            } else if (pos.type === 'SHORT' && currentPrice <= (pos.tsActivation || pos.entryPrice)) {
                pos.tsIsActive = true;
                pos.tsExtremePrice = currentPrice;
            }
            return false;
        }

        if (pos.type === 'LONG') {
            if (currentPrice > pos.tsExtremePrice) {
                pos.tsExtremePrice = currentPrice;
            }
            let triggerPrice = parseFloat((pos.tsExtremePrice * (1 - callbackDecimal)).toFixed(8));
            if (currentPrice <= triggerPrice) return true;
        } else {
            if (currentPrice < pos.tsExtremePrice) {
                pos.tsExtremePrice = currentPrice;
            }
            let triggerPrice = parseFloat((pos.tsExtremePrice * (1 + callbackDecimal)).toFixed(8));
            if (currentPrice >= triggerPrice) return true;
        }
        return false;
    },

    // Funding settlement terjadi setiap 8 jam (00:00, 08:00, 16:00 UTC)
    // Kita hitung funding P&L secara accrual per detik (pro-rata) supaya user
    // melihat angka yang berkembang, bukan lompat tiap 8 jam.
    _accrueFundingPnl(pos) {
        if (!Number.isFinite(pos.fundingRate) || !pos.fundingRate) return;
        const now = Date.now();
        const lastSettle = pos.lastFundingSettle || pos.openTime || now;
        const msSinceSettle = Math.max(0, now - lastSettle);
        const periodMs = 8 * 60 * 60 * 1000; // 8 jam
        if (msSinceSettle <= 0) return;
        // Untuk LONG: membayar funding jika rate positif, menerima jika negatif
        // Untuk SHORT: menerima funding jika rate positif, membayar jika negatif
        const direction = pos.type === 'LONG' ? -1 : 1;
        const fundingPerPeriod = pos.sizeUsd * pos.fundingRate * direction;
        const accrued = fundingPerPeriod * (msSinceSettle / periodMs);
        // Akrual ini ditampilkan; saat funding settlement nyata tiba (8 jam),
        // fundingPnl permanen ditambahkan dan lastFundingSettle di-reset.
        pos._fundingAccrued = accrued;
        // Cek apakah sudah waktunya settlement nyata (lewati kelipatan 8 jam)
        if (msSinceSettle >= periodMs) {
            pos.fundingPnl = (pos.fundingPnl || 0) + fundingPerPeriod;
            pos.lastFundingSettle = now;
            pos._fundingAccrued = 0;
        }
    },

    _getLiveFundingRate(pos) {
        // Coba ambil funding rate terbaru dari ArbitrageScanner cache
        try {
            const coinBase = pos.pair.replace('USDT', '');
            const ex = pos.exchange || 'Binance';
            if (window.ArbitrageScanner) {
                const exData = window.ArbitrageScanner.getExchangeData(ex);
                if (exData && Number.isFinite(exData[coinBase])) return exData[coinBase];
            }
            // Fallback LOCAL ARBITRAGE: universe sudah memetakan symbol per venue,
            // jadi pair dinamis (mis. 1000SHIBUSDT) tetap dapat funding yang benar.
            if (window.MarketUniverse) {
                const funding = window.MarketUniverse.getFunding(pos.pair);
                if (funding && Number.isFinite(funding[ex])) return funding[ex];
            }
        } catch (e) { /* noop */ }
        return Number.isFinite(pos.fundingRate) ? pos.fundingRate : 0;
    },

    updateLivePNL(currentPrice) {
        // Boot/pair switches temporarily clear the quote. Zero/NaN must never
        // trigger a liquidation or stop on a restored position.
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;
        if (!this.state.positions || this.state.positions.length === 0) { 
            this.renderEquity();
            return; 
        }
        
        let toClose = [];

        this.state.positions.forEach((pos) => {
            let cPosPx = (pos.pair === AppState.g_pair) ? currentPrice : (AppState.lastPrices[pos.pair] || pos.entryPrice);
            let netPnlAll = pos.type === 'LONG' ? (cPosPx - pos.entryPrice) * pos.sizeBase : (pos.entryPrice - cPosPx) * pos.sizeBase;

            // Akrual funding P&L
            pos.fundingRate = this._getLiveFundingRate(pos);
            this._accrueFundingPnl(pos);
            const totalFundingPnl = (pos.fundingPnl || 0) + (pos._fundingAccrued || 0);

            // For TP/SL/liquidation checks, ALWAYS use the position's own pair price
            // (cPosPx), never the chart price (currentPrice) which may be a different coin.
            const checkPrice = cPosPx;
            const isCurrentPair = (pos.pair === AppState.g_pair);

            if (!isCurrentPair) {
                // Off-chart pair: still check TP/SL/liquidation with correct price,
                // but skip DOM updates (elements don't exist for hidden pairs).
                if (pos.tp && ((pos.type === 'LONG' && checkPrice >= pos.tp) || (pos.type === 'SHORT' && checkPrice <= pos.tp))) {
                    toClose.push({id: pos.id, isLiq: false, reason: "TAKE PROFIT"});
                } else if (pos.sl && ((pos.type === 'LONG' && checkPrice <= pos.sl) || (pos.type === 'SHORT' && checkPrice >= pos.sl))) {
                    toClose.push({id: pos.id, isLiq: false, reason: "STOP LOSS"});
                } else {
                    let liqPrice = this.calculateLiqPrice(pos, this.state.balance);
                    if ((pos.type === 'LONG' && checkPrice <= liqPrice) || (pos.type === 'SHORT' && checkPrice >= liqPrice)) {
                        toClose.push({id: pos.id, isLiq: true, reason: "LIQ"});
                    }
                }
                return;
            }

            let pnlPct = safeDiv(netPnlAll, pos.margin) * 100;
            let totalPnl = netPnlAll + totalFundingPnl;
            let totalPnlPct = safeDiv(totalPnl, pos.margin) * 100;

            const pnlEl = document.getElementById(`pos-pnl-${pos.id}`); 
            if (pnlEl) { 
                pnlEl.textContent = `$${netPnlAll.toFixed(2)} (${pnlPct.toFixed(2)}%)`; 
                pnlEl.className = netPnlAll >= 0 ? 'pnl-positive' : 'pnl-negative'; 
            }

            const fundingEl = document.getElementById(`pos-funding-${pos.id}`);
            if (fundingEl) {
                fundingEl.textContent = `${totalFundingPnl >= 0 ? '+' : ''}$${totalFundingPnl.toFixed(4)}`;
                fundingEl.className = totalFundingPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            }

            const totalEl = document.getElementById(`pos-total-${pos.id}`);
            if (totalEl) {
                totalEl.textContent = `${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalPnlPct.toFixed(2)}%)`;
                totalEl.className = totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            }
            
            const currPxEl = document.getElementById(`pos-curr-${pos.id}`); 
            if (currPxEl) { 
                currPxEl.textContent = formatPrice(currentPrice); 
                currPxEl.style.color = totalPnl >= 0 ? 'var(--color-correct)' : 'var(--color-wrong)'; 
            }

            if (this.posLines[pos.id]) {
                this.posLines[pos.id].applyOptions({ 
                    color: totalPnl >= 0 ? 'rgba(74, 222, 128, 0.8)' : 'rgba(248, 113, 113, 0.8)', 
                    title: `${pos.type.charAt(0)}${pos.leverage}x | ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}` 
                });
            }

            if (pos.autoHedgeTrail) this.syncHedgeTrailingState(pos, currentPrice);

            if (this.processTrailingStop(pos, currentPrice)) {
                toClose.push({id: pos.id, isLiq: false, reason: "MANUAL TS TRIGGERED"});
                return;
            }

            let requiredMoveForBE = pos.atrSnapshot ? pos.atrSnapshot : (pos.entryPrice * 0.01);
            let is1to1 = pos.type === 'LONG' ? (currentPrice >= pos.entryPrice + requiredMoveForBE) : (currentPrice <= pos.entryPrice - requiredMoveForBE);
            
            if (pos.useBe && is1to1 && !pos.beLocked) { 
                let bePrice = pos.type === 'LONG' ? pos.entryPrice * (1 + (FEES.TAKER*2.5)) : pos.entryPrice * (1 - (FEES.TAKER*2.5));
                pos.sl = bePrice; 
                pos.beLocked = true; 
                showToast(`Break-Even Locked! SL dipindah ke Entry + Fees.`, false); 
                this.save(); 
                this.syncUpdatePosition(pos);
            }
            
            if (pos.useTrailing && pnlPct > 20) { 
                if (pos.type === 'LONG') pos.maxFavorablePrice = Math.max(pos.maxFavorablePrice, currentPrice); 
                else pos.maxFavorablePrice = Math.min(pos.maxFavorablePrice, currentPrice);
                
                let trailDist = Math.max((AppState.live.atr * 1.5), (currentPrice * 0.003));
                let trailSL = pos.type === 'LONG' ? pos.maxFavorablePrice - trailDist : pos.maxFavorablePrice + trailDist;
                
                if ((pos.type === 'LONG' && currentPrice <= trailSL) || (pos.type === 'SHORT' && currentPrice >= trailSL)) { 
                    toClose.push({id: pos.id, isLiq: false, reason: "SMART ATR TS"}); 
                    return; 
                }
            }
            
            if (pos.tp && ((pos.type === 'LONG' && currentPrice >= pos.tp) || (pos.type === 'SHORT' && currentPrice <= pos.tp))) {
                toClose.push({id: pos.id, isLiq: false, reason: "TAKE PROFIT"});
            } else if (pos.sl && ((pos.type === 'LONG' && currentPrice <= pos.sl) || (pos.type === 'SHORT' && currentPrice >= pos.sl))) {
                toClose.push({id: pos.id, isLiq: false, reason: "STOP LOSS"});
            } else { 
                let liqPrice = this.calculateLiqPrice(pos, this.state.balance); 
                if ((pos.type === 'LONG' && currentPrice <= liqPrice) || (pos.type === 'SHORT' && currentPrice >= liqPrice)) {
                    toClose.push({id: pos.id, isLiq: true, reason: "LIQ"}); 
                }
            }
        });
        
        toClose.forEach(c => this.closePosition(c.id, c.isLiq, c.reason)); 
        
        // Equity (wallet + floating PNL) follows every tick, like a real
        // exchange account, then the open Active Positions panel is refreshed.
        this.renderEquity();
        if (typeof updateActivePositionsPanel === 'function') updateActivePositionsPanel();
    },

    renderEquity() {
        if (typeof updateEquityDisplay === 'function') {
            updateEquityDisplay();
            return;
        }
        setSafeText('demo-balance', `$${this.getAccountSummary().equity.toFixed(2)}`);
    },

    drawChartLines() { 
        if (!series || !series.candle) return; 
        this.state.positions.forEach(pos => { 
            if (pos.pair === AppState.g_pair && !this.posLines[pos.id]) { 
                this.posLines[pos.id] = series.candle.createPriceLine({ 
                    price: pos.entryPrice, 
                    color: pos.type === 'LONG' ? '#4ade80' : '#f87171', 
                    lineWidth: 2, 
                    lineStyle: 0, 
                    axisLabelVisible: true, 
                    title: `${pos.type.charAt(0)}${pos.leverage}x` 
                }); 
            } 
        }); 
    },

    removeChartLine(id) { 
        if (this.posLines[id] && series && series.candle) { 
            try { series.candle.removePriceLine(this.posLines[id]); } catch(e) {} 
            delete this.posLines[id]; 
        } 
    },

    clearChartLines() { 
        for (let id in this.posLines) {
            this.removeChartLine(id);
        } 
        this.posLines = {}; 
    },

    updateUI() {
        const wrapper = document.getElementById('positions-wrapper');
        if (!wrapper) return;
        const activeInPair = this.state.positions.filter(p => p.pair === AppState.g_pair);
        wrapper.replaceChildren();

        activeInPair.forEach(pos => {
            wrapper.appendChild(createPositionCard.call(this, pos, this.state.balance));
        });

        if (typeof polymarketLog !== 'undefined' && Array.isArray(polymarketLog)) {
            const activePoly = polymarketLog.filter(p => p.status === 'PENDING' && p.pair === AppState.g_pair);
            activePoly.forEach(p => {
                const card = createUiElement('div', { className: 'position-card' });
                const header = createUiElement('div', { className: 'position-card-header' });
                const headerInline = createUiElement('div', { className: 'position-header-inline' });

                const sideClass = p.direction === 'LONG' ? 'market-long' : 'market-short';
                appendChildren(headerInline, [
                    createUiElement('span', { className: 'position-pair', text: p.pair }),
                    createUiElement('span', { className: `position-side ${sideClass}`, text: p.direction }),
                    createUiElement('span', { className: 'position-mode-pill', text: `Polymarket ${p.tfLabel}` })
                ]);
                header.appendChild(headerInline);

                const badges = createUiElement('div', { className: 'position-badges' });
                badges.appendChild(createUiElement('span', { className: 'position-badge-ai', text: 'PENDING' }));

                const grid = createUiElement('div', { className: 'position-detail-grid' });
                const entryVal = p.startPrice ? p.startPrice.toFixed(2) : '-';

                // Calculate time remaining if possible
                let timeStr = '...';
                if (p.targetTime) {
                    const diff = Math.max(0, p.targetTime - Math.floor(Date.now() / 1000));
                    const m = Math.floor(diff / 60);
                    const s = diff % 60;
                    timeStr = `${m}m ${s}s`;
                }

                appendChildren(grid, [
                    appendChildren(document.createElement('div'), [
                        createUiElement('div', { className: 'position-detail-label', text: 'Entry Price' }),
                        createUiElement('div', { className: 'position-detail-value-primary', text: entryVal })
                    ]),
                    appendChildren(document.createElement('div'), [
                        createUiElement('div', { className: 'position-detail-label', text: 'Time Remaining' }),
                        createUiElement('div', { className: 'position-detail-value', text: timeStr })
                    ])
                ]);

                appendChildren(card, [header, badges, grid]);
                wrapper.appendChild(card);
            });
        }

        if (typeof triggerGlobalAlertIfNeeded === 'function') triggerGlobalAlertIfNeeded();
        if (typeof updateActivePositionsPanel === 'function') updateActivePositionsPanel(true);
    }
};

window.FuturesEngine = FuturesEngine;

window.executeFuturesTrade = async function(type, isAi) {
    showToast("Trading action started...", false, 2000);
    try {
        if (type === 'AI') {
            try {
                const NeuralSys = window.AnimalNeuralSystem;
                if (NeuralSys && typeof NeuralSys.shouldBlockAiTrade === 'function') {
                    const verdict = NeuralSys.shouldBlockAiTrade();
                    if (verdict && verdict.block) {
                        // A blocked trade is a normal outcome, not an error: the
                        // user sees the reason in the toast, and the detail is
                        // only logged when verbose debugging is switched on.
                        if (typeof MASAKO_DEBUG !== 'undefined' && MASAKO_DEBUG) {
                            console.log('[trade] Neural Risk Gate blocked AI execute:', verdict.reason || 'risk');
                        }
                        showToast("EARLY RETURN: Neural Risk Gate: NO TRADE (" + (verdict.reason || 'risk') + ").", true);
                        return;
                    }
                }
            } catch (e) { /* neural gate optional; existing flow continues */ }
            let sig = AppState.live.signal;
            if (sig === 'STRONG BUY') type = 'LONG';
            else if (sig === 'STRONG SELL') type = 'SHORT';
            else {
                if (AppState.aiMode === 'AGG') {
                    type = AppState.live.score >= 0 ? 'LONG' : 'SHORT';
                    showToast("AI (AGG): simulasi arah berdasarkan skor saat ini.", false);
                } else {
                    showToast("EARLY RETURN: AI (CONS): Sinyal tidak cukup kuat. Tunggu konfirmasi.", true);
                    return;
                }
            }
        }
        await FuturesEngine.openPosition(type, isAi);
    } catch (error) {
        console.error('executeFuturesTrade failed:', error);
        showToast(`Gagal membuka posisi: ${error.message}`, true, 5000);
    }
};
