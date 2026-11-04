/* src/engines/copyTrade.js — Copy trade wallet ke DEMO (paper trading).
 *
 * Cara kerja: poll fills wallet target tiap interval. Fill "Open …" yang baru
 * -> buka posisi demo proporsional via FuturesEngine. Posisi target yang hilang
 * (tutup penuh) -> tutup posisi demo yang dicopy dari wallet itu.
 *
 * 100% DEMO: tidak ada private key, tidak ada order real, tidak ada kustodi.
 * Posisi copy ditandai origin 'COPY_TRADE' + copyMeta {source, coin}.
 *
 * 24/7: bila user LOGIN, session di-sync ke server (/api/copy-trade) dan cron
 * server ikut mem-poll tiap ±1 menit — membuka/menutup posisi demo REAL di akun
 * user walau browser ditutup. Saat tab terbuka, polling lokal (20 dtk) yang
 * dominan; heartbeat lastFillTime mencegah duplikat antara browser & server.
 * Guest (tanpa login): localStorage-only, berhenti saat tab ditutup.
 */
(function () {
    'use strict';

    var LS_KEY = 'masako_copytrade_sessions_v1';
    var DEFAULTS = {
        copyRatio: 1,          // pengali ukuran (proporsional)
        fixedMargin: 0,        // jika >0: pakai margin tetap per posisi (USDT), abaikan ratio
        fixedLeverage: 0,      // jika >0: pakai leverage tetap, abaikan leverage target
        leverageCap: 10,       // leverage maksimum untuk posisi copy
        maxPositions: 3,       // maks posisi copy aktif per wallet
        pollMs: 20000,         // interval poll fills
        copyExisting: true,    // ikut salin posisi yang sudah terbuka saat start
        onlyNew: false,        // true = hanya posisi BARU setelah start (ala "Not copy open")
        minMargin: 5,          // margin minimum per posisi copy (USDT)
        maxMargin: 500,        // margin maksimum per posisi copy (USDT)
        blacklist: [],         // koin yang tidak dicopy, mis. ["BTC"]
        minTargetEquity: 0,    // berhenti bila equity target < ini (0 = mati)
        defaultLeverage: 5,    // dipakai bila leverage target tidak diketahui
        enabled: true          // on/off toggle: pause copy tanpa menghapus session
    };

    var sessions = new Map(); // addressLower -> session
    var timers = new Map();

    function lsLoad() {
        try {
            var raw = localStorage.getItem(LS_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }
    function lsSave() {
        try {
            var arr = [];
            sessions.forEach(function (s) {
                arr.push({
                    address: s.address, settings: s.settings,
                    startedAt: s.startedAt, active: s.active,
                    stats: s.stats, lastFillTime: s.lastFillTime,
                    targetEquity: s.targetEquity,
                    copied: s.copied
                });
            });
            localStorage.setItem(LS_KEY, JSON.stringify(arr));
        } catch (_) { /* abaikan */ }
        // Jika user login, sync ke server (best-effort, jangan lempar error)
        syncAllToServer();
    }

    function api() {
        try {
            if (typeof CopyTradeApi !== 'undefined' && CopyTradeApi) return CopyTradeApi;
            if (typeof window !== 'undefined' && window.CopyTradeApi) return window.CopyTradeApi;
        } catch (_) {}
        return null;
    }

    /* ---------- CopyTradeApi: REST client untuk /api/copy-trade ----------
     * CATATAN: modul ini direferensikan sejak awal tapi TIDAK PERNAH
     * didefinisikan di repo — akibatnya syncOneToServer()/syncAllToServer()
     * selalu no-op, session tidak pernah tersimpan di server, dan copy trade
     * mati total saat browser ditutup. Definisi ini memperbaikinya.
     * Memakai window.apiFetch (membawa token login) bila tersedia. */
    function apiReq(method, path, body) {
        var p;
        try {
            if (typeof window !== 'undefined' && typeof window.apiFetch === 'function') {
                p = window.apiFetch(path, { method: method, body: body ? JSON.stringify(body) : undefined });
            } else if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
                p = window.fetch(path, {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: body ? JSON.stringify(body) : undefined
                });
            } else {
                return Promise.reject(new Error('fetch tidak tersedia'));
            }
        } catch (e) { return Promise.reject(e); }
        return p.then(function (res) {
            return res.json().catch(function () { return {}; });
        });
    }

    var CopyTradeApi = {
        list: function () { return apiReq('GET', '/api/copy-trade'); },
        start: function (address, settings) {
            return apiReq('POST', '/api/copy-trade', { address: address, settings: settings });
        },
        stop: function (address) {
            return apiReq('POST', '/api/copy-trade/' + encodeURIComponent(address) + '/stop');
        },
        toggle: function (address, enabled) {
            return apiReq('POST', '/api/copy-trade/' + encodeURIComponent(address) + '/toggle', { enabled: !!enabled });
        },
        // Kabari server: fills sampai lastFillTime sudah diproses browser.
        // Server memakai ini untuk skip (dedup) + menandai browser sedang aktif.
        heartbeat: function (address, info) {
            return apiReq('POST', '/api/copy-trade/' + encodeURIComponent(address) + '/heartbeat', info || {});
        }
    };

    function isLoggedIn() {
        try {
            if (typeof window !== 'undefined' && window.MasakoAuth && window.MasakoAuth.isAuthenticated) return true;
        } catch (_) {}
        return false;
    }

    async function syncOneToServer(address, session) {
        var a = api();
        if (!a || !isLoggedIn()) return false;
        // Cek apakah session sudah ada di server
        try {
            var list = await a.list();
            if (list && !list.guest && Array.isArray(list.sessions)) {
                var exists = list.sessions.some(function (s) { return String(s.address).toLowerCase() === String(address).toLowerCase(); });
                if (!exists) {
                    await a.start(address, session.settings);
                } else {
                    await a.toggle(address, session.settings.enabled !== false);
                }
                return true;
            }
        } catch (_) { return false; }
        return false;
    }

    async function syncAllToServer() {
        var a = api();
        if (!a || !isLoggedIn()) return;
        try {
            var list = await a.list();
            if (list && !list.guest && Array.isArray(list.sessions)) {
                var remoteAddrs = new Set(list.sessions.map(function (s) { return String(s.address).toLowerCase(); }));
                var localAddrs = Array.from(sessions.keys());
                // CATATAN: JANGAN auto-stop session remote yang tidak ada di lokal.
                // Itu membunuh session dari perangkat/browser lain milik user yang
                // sama (localStorage per-device), lalu perangkat itu menghidupkannya
                // lagi -> flapping. Stop hanya lewat aksi eksplisit (tombol Berhenti
                // -> CopyTrade.stop -> a.stop).
                // Start/update lokal yang belum ada di remote
                for (var j = 0; j < localAddrs.length; j++) {
                    var s = sessions.get(localAddrs[j]);
                    if (!s) continue;
                    if (!remoteAddrs.has(localAddrs[j])) {
                        try { await a.start(s.address, s.settings); } catch (_) {}
                    } else {
                        try { await a.toggle(s.address, s.settings.enabled !== false); } catch (_) {}
                    }
                }
            }
        } catch (_) {}
    }

    function fe() {
        try {
            if (typeof FuturesEngine !== 'undefined' && FuturesEngine && typeof FuturesEngine.openPosition === 'function') return FuturesEngine;
            if (typeof window !== 'undefined' && window.FuturesEngine && typeof window.FuturesEngine.openPosition === 'function') return window.FuturesEngine;
        } catch (_) {}
        return null;
    }
    function wt() {
        try {
            if (typeof WalletTracker !== 'undefined') return WalletTracker;
            if (typeof window !== 'undefined' && window.WalletTracker) return window.WalletTracker;
        } catch (_) {}
        return null;
    }
    function appState() {
        try {
            if (typeof AppState !== 'undefined') return AppState;
            if (typeof window !== 'undefined' && window.AppState) return window.AppState;
        } catch (_) {}
        return null;
    }

    /* ---------- pure helpers (testable) ---------- */
    function computeCopyMargin(targetNotional, targetEquity, demoEquity, settings) {
        var s = Object.assign({}, DEFAULTS, settings || {});
        // Mode fixed margin per posisi (user isi langsung besaran dolar)
        if (Number(s.fixedMargin) > 0) {
            var m = Math.max(s.minMargin, Math.min(s.maxMargin, Number(s.fixedMargin)));
            return Math.round(m * 100) / 100;
        }
        if (!(targetEquity > 0) || !(demoEquity > 0) || !(targetNotional > 0)) return 0;
        var frac = targetNotional / targetEquity;
        if (frac > 2) return 0;
        var margin = frac * demoEquity * s.copyRatio;
        margin = Math.max(s.minMargin, Math.min(s.maxMargin, margin));
        return Math.round(margin * 100) / 100;
    }

    function pickLeverage(targetLev, settings) {
        var s = Object.assign({}, DEFAULTS, settings || {});
        // Mode fixed leverage
        if (Number(s.fixedLeverage) > 0) {
            return Math.max(1, Math.min(125, Math.round(Number(s.fixedLeverage))));
        }
        var t = Number(targetLev);
        if (!Number.isFinite(t) || t <= 0) t = s.defaultLeverage;
        var lev = Math.min(t, s.leverageCap);
        return Math.max(1, Math.min(125, Math.round(lev)));
    }

    function isBlacklisted(coin, settings) {
        var s = Object.assign({}, DEFAULTS, settings || {});
        var bl = Array.isArray(s.blacklist) ? s.blacklist : [];
        var c = String(coin || '').toUpperCase();
        for (var i = 0; i < bl.length; i++) {
            if (String(bl[i]).toUpperCase() === c) return true;
        }
        return false;
    }

    function dirOf(hlDir) {
        var d = String(hlDir || '');
        if (/open\s+long/i.test(d)) return 'LONG';
        if (/open\s+short/i.test(d)) return 'SHORT';
        return null;
    }

    /* ---------- session ---------- */
    function newSession(address, settings) {
        var s = Object.assign({}, DEFAULTS, settings || {});
        s.copyRatio = Math.max(0.05, Math.min(10, Number(s.copyRatio) || 1));
        s.fixedMargin = Math.max(0, Math.min(s.maxMargin, Number(s.fixedMargin) || 0));
        s.fixedLeverage = Math.max(0, Math.min(125, Number(s.fixedLeverage) || 0));
        s.leverageCap = Math.max(1, Math.min(125, Math.round(Number(s.leverageCap) || 10)));
        s.maxPositions = Math.max(1, Math.min(5, Math.round(Number(s.maxPositions) || 3)));
        s.pollMs = Math.max(10000, Math.min(120000, Number(s.pollMs) || 20000));
        s.blacklist = (Array.isArray(settings && settings.blacklist) ? settings.blacklist : [])
            .map(function (x) { return String(x).toUpperCase().trim(); }).filter(Boolean);
        s.enabled = s.enabled !== false;
        return {
            address: String(address).toLowerCase(),
            settings: s,
            startedAt: Date.now(),
            active: true,
            lastFillTime: 0,
            targetEquity: 0,
            copied: {}, // coin -> { demoId, dir, openedAt, targetOpenTime, paused:false }
            stats: { opened: 0, closed: 0, errors: 0 }
        };
    }

    function getSession(address) {
        return sessions.get(String(address).toLowerCase()) || null;
    }

    function listSessions() {
        var out = [];
        sessions.forEach(function (s) { out.push(exportSession(s)); });
        return out;
    }

    function exportSession(s) {
        var copied = [];
        Object.keys(s.copied).forEach(function (coin) {
            var c = s.copied[coin];
            copied.push({ coin: coin, dir: c.dir, openedAt: c.openedAt, demoId: c.demoId });
        });
        return {
            address: s.address, active: s.active, startedAt: s.startedAt,
            settings: Object.assign({}, s.settings),
            targetEquity: s.targetEquity,
            copied: copied, stats: Object.assign({}, s.stats)
        };
    }

    /* ---------- mirror primitives ---------- */
    async function openMirror(session, coin, dir, targetNotional, targetLeverage, reason, targetOpenTime) {
        var engine = fe(), tracker = wt(), st = appState();
        if (!engine || !tracker || !st) throw new Error('Engine terminal belum siap');
        var pair = tracker.coinToPair(coin);
        if (!pair) throw new Error('Koin ' + coin + ' tidak didukung terminal');

        var mids = await tracker.getMids();
        var mid = Number(mids && mids.mids && mids.mids[String(coin).toUpperCase()]);
        if (!(mid > 0)) throw new Error('Harga mark ' + coin + ' tidak tersedia');

        var summary = engine.getAccountSummary ? engine.getAccountSummary() : null;
        var demoEquity = summary ? Number(summary.equity) : Number(engine.state && engine.state.balance);
        var margin = computeCopyMargin(targetNotional, session.targetEquity, demoEquity, session.settings);
        if (!(margin > 0)) throw new Error('Ukuran copy tidak valid (cek equity target/demo)');
        var leverage = pickLeverage(targetLeverage, session.settings);

        var tOpen = Number(targetOpenTime) || Date.now();
        // copyMeta dioper via overrides agar ikut ke payload server
        // (syncOpenPosition jalan di dalam openPosition).
        var copyMeta = {
            source: session.address,
            coin: String(coin).toUpperCase(),
            dir: dir,
            targetOpenTime: tOpen
        };

        // Snapshot id sebelum open: posisi baru diidentifikasi dari selisih id,
        // bukan "COPY_TRADE terbaru di pair ini" — kalau tidak, dua session
        // yang meng-copy koin sama bisa saling adopsi posisi (salah tutup).
        var beforeIds = {};
        try {
            var prevPositions = (engine.state && engine.state.positions) || [];
            for (var b = 0; b < prevPositions.length; b++) {
                if (prevPositions[b]) beforeIds[String(prevPositions[b].id)] = true;
            }
        } catch (_) {}

        // FuturesEngine.openPosition memakai AppState.g_pair & AppState.price.
        // Tukar sementara ke pair target, kembalikan setelah selesai.
        var prevPair = st.g_pair, prevPrice = st.price;
        try {
            st.g_pair = pair;
            st.price = mid;
            await engine.openPosition(dir, false, {
                margin: margin,
                leverage: leverage,
                marginMode: (session.settings && session.settings.marginMode === 'CROSS') ? 'CROSS' : 'ISOLATED',
                origin: 'COPY_TRADE',
                copyMeta: copyMeta,
                silent: true,
                signalSnapshot: {
                    copySource: session.address,
                    targetCoin: String(coin).toUpperCase(),
                    targetNotional: targetNotional,
                    targetLeverage: targetLeverage,
                    copyRatio: session.settings.copyRatio,
                    reason: reason || 'mirror'
                }
            });
        } finally {
            st.g_pair = prevPair;
            st.price = prevPrice;
        }

        // Temukan posisi yang BARU dibuat: id belum ada sebelum open + pair,
        // origin, dan source cocok. Presisi, anti salah adopsi.
        var found = null;
        var positions = (engine.state && engine.state.positions) || [];
        for (var i = positions.length - 1; i >= 0; i--) {
            var p = positions[i];
            if (!p || beforeIds[String(p.id)]) continue;
            if (p.pair !== pair || p.origin !== 'COPY_TRADE') continue;
            if (!p.copyMeta || String(p.copyMeta.source || '').toLowerCase() !== session.address) continue;
            found = p;
            break;
        }
        if (!found) throw new Error('Posisi demo tidak ditemukan setelah open');
        if (engine.persistLocalState) { try { engine.persistLocalState(); } catch (_) {} }
        return found;
    }

    async function closeMirror(session, coin) {
        var engine = fe();
        var tracker = wt();
        var c = session.copied[coin];
        if (!engine || !c) return false;
        try {
            var positions = (engine.state && engine.state.positions) || [];
            var stillThere = positions.some(function (p) { return p && String(p.id) === String(c.demoId); });
            if (stillThere && typeof engine.closePosition === 'function') {
                // Harga exit EKSPLISIT dari mids pair ini — jangan andalkan
                // AppState.price/lastPrices yang bisa basi atau milik pair lain.
                // Kasus nyata: posisi ZRO tertutup memakai harga SOL (119.28)
                // sehingga PnL tercatat +$148rb.
                var forcedPrice = null;
                var midsOk = false;
                try {
                    var mids = tracker ? await tracker.getMids() : null;
                    var mid = Number(mids && mids.mids && mids.mids[String(coin).toUpperCase()]);
                    if (mid > 0) { forcedPrice = mid; midsOk = true; }
                } catch (_) {}
                // Mids gagal (audit 2026-11-02 F5): TUNDA close satu poll
                // daripada membukukan PnL di harga fallback yang bisa basi.
                // Mapping DIPERTAHANKAN agar poll berikut mencoba lagi
                // (server copy engine juga menutup mirror secara independen).
                if (!midsOk) return false;
                engine.closePosition(c.demoId, false, 'COPY_TRADE target tutup posisi', 100, forcedPrice);
            }
            delete session.copied[coin];
            return true;
        } catch (_) { return false; }
    }

    function enginePositions() {
        try {
            var e = fe();
            return (e && e.state && e.state.positions) || [];
        } catch (_) { return []; }
    }

    function coinOfEnginePos(p) {
        if (!p) return '';
        if (p.copyMeta && p.copyMeta.coin) return String(p.copyMeta.coin).toUpperCase();
        if (p.pair) return String(p.pair).replace(/USDT$/, '').toUpperCase();
        return '';
    }

    // Gabungkan peta copied tersimpan dengan posisi engine saat ini: buang entri
    // yang demoId-nya sudah tidak ada (posisi ditutup manual / state di-reset).
    // Tanpa ini, buka terminal = session "lupa" posisi yang masih terbuka.
    function mergeCopiedState(savedCopied, positions) {
        var out = {};
        if (!savedCopied || typeof savedCopied !== 'object') return out;
        var byId = {};
        (positions || []).forEach(function (p) {
            if (p && p.id !== undefined && p.id !== null) byId[String(p.id)] = true;
        });
        Object.keys(savedCopied).forEach(function (coin) {
            var c = savedCopied[coin];
            if (!c || c.demoId === undefined || c.demoId === null) return;
            if (byId[String(c.demoId)]) out[String(coin).toUpperCase()] = c;
        });
        return out;
    }

    // Adopsi posisi COPY_TRADE milik session ini yang ada di engine tapi belum
    // di-track — mis. dibuka oleh server cron saat browser tutup, atau session
    // yang di-restore dari server. Mencegah duplikat open & membuat close
    // (saat wallet target tutup posisi) tetap berfungsi.
    function adoptUntrackedCopies(session, positions) {
        var adopted = 0;
        (positions || []).forEach(function (p) {
            if (!p || p.origin !== 'COPY_TRADE' || !p.copyMeta) return;
            if (String(p.copyMeta.source || '').toLowerCase() !== session.address) return;
            var coin = coinOfEnginePos(p);
            if (!coin || session.copied[coin]) return;
            session.copied[coin] = {
                demoId: p.id,
                dir: p.copyMeta.dir || p.type,
                openedAt: Number(p.openTime) || Date.now(),
                targetOpenTime: Number(p.copyMeta.targetOpenTime) || Number(p.openTime) || Date.now(),
                adopted: true
            };
            adopted++;
        });
        return adopted;
    }

    // Kabari server bahwa browser sudah memproses fills sampai lastFillTime.
    // Best-effort & user login saja. Dikirim bila lastFillTime berubah ATAU
    // >60 dtk sejak heartbeat terakhir — tanpa liveness berkala, browserActiveAt
    // di server basi saat wallet sepi fills, lalu cron mengira browser mati dan
    // membuka duplikat posisi yang juga dibuka browser.
    function pushHeartbeat(session) {
        if (!session || !isLoggedIn()) return;
        var now = Date.now();
        if (session._hbSent === session.lastFillTime && now - (session._hbAt || 0) < 60000) return;
        session._hbSent = session.lastFillTime;
        session._hbAt = now;
        var a = api();
        if (!a || typeof a.heartbeat !== 'function') return;
        try {
            a.heartbeat(session.address, {
                lastFillTime: session.lastFillTime,
                targetEquity: session.targetEquity
            }).catch(function () {});
        } catch (_) {}
    }

    /* ---------- poll ---------- */
    async function pollOnce(session) {
        var tracker = wt();
        if (!tracker || !session.active) return;
        var engine = fe();
        // Adopsi posisi COPY_TRADE milik session ini yang belum di-track
        // (mis. dibuka server cron saat browser tutup) — cegah duplikat open
        // dan pastikan close saat wallet target tutup posisi tetap jalan.
        try { if (adoptUntrackedCopies(session, enginePositions())) lsSave(); } catch (_) {}
        // Tutup mirror lama (agar tetap sinkron meskipun sedang di-pause)
        try {
            // Refresh equity + posisi target berkala (untuk sizing & deteksi close)
            var detail = await tracker.getWalletDetail(session.address);
            // Guard konsumen (audit 2026-11-02): detail malformed (positions
            // bukan array) TIDAK boleh dibaca sebagai "target kosong" — itu
            // akan menutup semua mirror. Lempar agar poll ini dilewati
            // (catch di bawah hanya menaikkan errors), sama seperti gagal
            // fetch. Server hl-wallet kini juga 502 untuk respons parsial,
            // tapi guard sisi konsumen menutup produsen detail lain di masa
            // depan.
            if (!detail || !Array.isArray(detail.positions)) throw new Error('detail posisi target malformed (positions bukan array)');
            session.targetEquity = Number(detail.equity) || 0;
            var s = session.settings;
            if (s.minTargetEquity > 0 && session.targetEquity > 0 && session.targetEquity < s.minTargetEquity) {
                await stop(session.address, 'Equity target di bawah batas minimum');
                return;
            }
            var targetOpen = {}; // coin -> position
            (detail.positions || []).forEach(function (p) { targetOpen[String(p.coin).toUpperCase()] = p; });

            // 1) Tutup mirror yang targetnya sudah tidak punya posisi di koin itu
            var copiedCoins = Object.keys(session.copied);
            for (var ci = 0; ci < copiedCoins.length; ci++) {
                var ccoin = copiedCoins[ci];
                var ours = session.copied[ccoin];
                if (!ours) continue;
                var tp = targetOpen[ccoin];
                if (!tp) {
                    if (await closeMirror(session, ccoin)) session.stats.closed++;
                } else if (tp.side !== ours.dir) {
                    // Target balik arah: tutup lalu buka berlawanan (dihitung sebagai posisi baru)
                    if (await closeMirror(session, ccoin)) session.stats.closed++;
                }
            }

            // 2) Proses fills baru -> buka mirror (hanya jika copy ENABLED)
            if (!s.enabled) {
                // Tetap update lastFillTime supaya tidak loncat backfill saat di-enable lagi
                try {
                    var fd0 = await tracker.getFills(session.address);
                    var mx0 = 0;
                    (fd0.fills || []).forEach(function (f) { mx0 = Math.max(mx0, Number(f.time) || 0); });
                    session.lastFillTime = Math.max(session.lastFillTime, mx0);
                } catch (_) {}
                pushHeartbeat(session);
                lsSave();
                return;
            }
            var fd = await tracker.getFills(session.address);
            var fills = (fd.fills || []).slice().sort(function (a, b) { return a.time - b.time; });
            // Watermark hanya maju melewati fill yang BERHASIL diproses atau
            // dilewati permanen. Fill yang gagal transient (saldo kurang,
            // mids belum ada, dsb) TIDAK menaikkan watermark supaya dicoba
            // lagi poll berikutnya — sebelumnya fill gagal ikut tertelan
            // sehingga mirror bisa telat belasan menit tanpa pernah retry.
            var maxT = session.lastFillTime;
            var hasPendingGap = false;
            for (var i = 0; i < fills.length; i++) {
                var f = fills[i];
                if (f.time <= session.lastFillTime) continue;
                var resolved = true;
                var dir = dirOf(f.dir);
                var coin = String(f.coin || '').toUpperCase();
                if (!dir || !coin || isBlacklisted(coin, s)) {
                    // permanen: bukan sinyal open valid -> telan
                } else if (session.copied[coin]) {
                    // permanen: sudah dicopy -> telan
                } else if (Object.keys(session.copied).length >= s.maxPositions) {
                    resolved = false; // transient: tunggu slot kosong
                } else if (engine && (engine.state.positions || []).length >= 5) {
                    resolved = false; // transient: batas engine
                } else {
                    try {
                        var notional = Number(f.px) * Number(f.sz);
                        var pos = await openMirror(session, coin, dir, notional, s.defaultLeverage, 'fill:' + f.dir, f.time);
                        session.copied[coin] = {
                            demoId: pos.id, dir: dir, openedAt: Date.now(), targetOpenTime: f.time
                        };
                        session.stats.opened++;
                    } catch (e) {
                        resolved = false; // transient: coba lagi poll berikutnya
                        session.stats.errors++;
                    }
                }
                if (resolved && !hasPendingGap) {
                    maxT = Math.max(maxT, f.time);
                } else if (!resolved) {
                    hasPendingGap = true;
                }
            }
            session.lastFillTime = maxT;
            // Kabari server: fills ini sudah diproses browser -> cron server skip (dedup).
            pushHeartbeat(session);
            lsSave();
        } catch (e) {
            session.stats.errors++;
        }
    }

    function schedule(session) {
        unschedule(session.address);
        var id = setInterval(function () { pollOnce(session); }, session.settings.pollMs);
        timers.set(session.address, id);
    }
    function unschedule(address) {
        var id = timers.get(String(address).toLowerCase());
        if (id) { clearInterval(id); timers.delete(String(address).toLowerCase()); }
    }

    async function start(address, settings) {
        var tracker = wt();
        if (!tracker) throw new Error('WalletTracker belum siap');
        address = String(address || '').trim().toLowerCase();
        if (!tracker.isValidAddress(address)) throw new Error('Alamat wallet tidak valid');
        if (sessions.has(address)) throw new Error('Wallet ini sudah dicopy');

        var session = newSession(address, settings);
        // Verifikasi wallet ada & ambil equity awal
        var detail = await tracker.getWalletDetail(address);
        session.targetEquity = Number(detail.equity) || 0;

        sessions.set(address, session);

        // Salin posisi yang sudah terbuka (kecuali mode onlyNew)
        if (!session.settings.onlyNew && session.settings.copyExisting) {
            for (var i = 0; i < (detail.positions || []).length; i++) {
                var p = detail.positions[i];
                var coin = String(p.coin || '').toUpperCase();
                if (!coin || isBlacklisted(coin, session.settings)) continue;
                if (Object.keys(session.copied).length >= session.settings.maxPositions) break;
                try {
                    var pos = await openMirror(session, coin, p.side, p.notional, p.leverage, 'existing', p.openTime);
                    session.copied[coin] = {
                        demoId: pos.id, dir: p.side, openedAt: Date.now(), targetOpenTime: p.openTime || Date.now()
                    };
                    session.stats.opened++;
                } catch (_) { session.stats.errors++; }
            }
        }
        // Baseline fills agar tidak meng-copy ulang history lama
        try {
            var fd = await tracker.getFills(address);
            var mx = 0;
            (fd.fills || []).forEach(function (f) { mx = Math.max(mx, Number(f.time) || 0); });
            session.lastFillTime = mx;
        } catch (_) {}

        schedule(session);
        lsSave();
        installUnloadGuard();
        pollOnce(session); // poll pertama langsung
        // Persist ke server agar copy tetap jalan 24/7 walau browser ditutup.
        // Hanya jika user login; guest tetap localStorage-only.
        try { await syncOneToServer(address, session); } catch (_) {}
        // Langsung kabari baseline fills ke server agar cron tidak backfill
        // (duplikat) sebelum heartbeat rutin pertama.
        try { pushHeartbeat(session); } catch (_) {}
        return exportSession(session);
    }

    async function stop(address, reason) {
        address = String(address).toLowerCase();
        var session = sessions.get(address);
        if (!session) return false;
        session.active = false;
        unschedule(address);
        // Tutup semua mirror milik session ini
        var stopCoins = Object.keys(session.copied);
        for (var si = 0; si < stopCoins.length; si++) {
            if (await closeMirror(session, stopCoins[si])) session.stats.closed++;
        }
        sessions.delete(address);
        // Sync stop ke server (best effort)
        var a = api();
        if (a && isLoggedIn()) { try { a.stop(address); } catch (_) {} }
        lsSave();
        if (!hasActiveCopies()) removeUnloadGuard();
        return true;
    }

    // Toggle copy aktif/pause untuk satu session wallet
    function setEnabled(address, enabled) {
        var s = sessions.get(String(address).toLowerCase());
        if (!s) return false;
        s.settings.enabled = !!enabled;
        lsSave();
        return true;
    }

    // Toggle satu posisi copy aktif (tanpa menutup posisi demo yang sudah terbuka)
    function setPositionPaused(address, coin, paused) {
        var s = sessions.get(String(address).toLowerCase());
        if (!s || !s.copied[coin]) return false;
        s.copied[coin].paused = !!paused;
        lsSave();
        return true;
    }

    function updateSettings(address, patch) {
        var s = sessions.get(String(address).toLowerCase());
        if (!s) return false;
        Object.keys(patch || {}).forEach(function (k) {
            if (k === 'fixedMargin') s.settings.fixedMargin = Math.max(0, Math.min(s.settings.maxMargin, Number(patch[k]) || 0));
            else if (k === 'fixedLeverage') s.settings.fixedLeverage = Math.max(0, Math.min(125, Number(patch[k]) || 0));
            else if (k === 'leverageCap') s.settings.leverageCap = Math.max(1, Math.min(125, Math.round(Number(patch[k]) || 10)));
            else if (k === 'maxPositions') s.settings.maxPositions = Math.max(1, Math.min(5, Math.round(Number(patch[k]) || 3)));
        });
        lsSave();
        return true;
    }

    function hasActiveCopies() {
        var count = 0;
        sessions.forEach(function (s) { if (s.active) count++; });
        return count > 0;
    }

    function onBeforeUnload(e) {
        if (!hasActiveCopies()) return;
        var msg = 'Copy trade masih aktif! Jika kamu tutup tab ini, copy trade akan BERHENTI sampai kamu buka lagi. Yakin ingin meninggalkan halaman?';
        if (e) { e.preventDefault(); e.returnValue = msg; }
        return msg;
    }

    // Kabari server bahwa browser DITUTUP (bukan sekadar tidak kirim heartbeat).
    // Tanpa ini server baru menganggap browser mati setelah ambang 120 dtk
    // browserActiveAt kedaluwarsa — mirror pertama sesudah tutup telat sampai
    // ~3 menit (120 dtk + interval tick). Dengan beacon ini, tick server
    // berikutnya langsung mengambil alih (telat ≈ interval tick, ~1 menit
    // bila system-cron diping tiap menit). Dipakai pagehide, bukan
    // beforeunload: pagehide hanya menyala saat halaman benar-benar dibongkar
    // (termasuk tutup browser di HP, yang sering tidak memicu beforeunload),
    // sedangkan beforeunload bisa dibatalkan user — beacon di sana akan
    // menandai browser mati secara palsu. Bila beacon gagal/kasus crash,
    // ambang 120 dtk tetap jadi fallback. Guest: server mengabaikan
    // (tidak ada session server), jadi beacon ini no-op yang aman.
    function notifyServerClosing() {
        if (typeof window === 'undefined' || !hasActiveCopies()) return;
        sessions.forEach(function (session) {
            if (!session || !session.active || !session.address) return;
            var url = '/api/copy-trade/' + encodeURIComponent(session.address) + '/heartbeat';
            var payload = JSON.stringify({ browserClosing: true });
            try {
                if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
                    var blob = new Blob([payload], { type: 'application/json' });
                    navigator.sendBeacon(url, blob);
                } else if (typeof fetch === 'function') {
                    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(function () {});
                }
            } catch (_) {}
        });
    }

    function onPageHide() {
        notifyServerClosing();
    }

    function installUnloadGuard() {
        if (typeof window === 'undefined') return;
        try { window.addEventListener('beforeunload', onBeforeUnload); } catch (_) {}
        try { window.addEventListener('pagehide', onPageHide); } catch (_) {}
    }
    function removeUnloadGuard() {
        if (typeof window === 'undefined') return;
        try { window.removeEventListener('beforeunload', onBeforeUnload); } catch (_) {}
        try { window.removeEventListener('pagehide', onPageHide); } catch (_) {}
    }

    function restore() {
        // Dipanggil saat boot: kembalikan session aktif yang tersimpan.
        // PENTING: lastFillTime & peta copied DIKEMBALIKAN — tanpanya, setiap
        // buka terminal = re-copy fills lama + duplikat posisi yang masih
        // terbuka ("ke open posisinya aneh").
        var saved = lsLoad();
        saved.forEach(function (sv) {
            if (!sv || !sv.active || !sv.address) return;
            try {
                var session = newSession(sv.address, sv.settings || {});
                session.startedAt = sv.startedAt || Date.now();
                session.stats = sv.stats || session.stats;
                session.lastFillTime = Number(sv.lastFillTime) || 0;
                session.targetEquity = Number(sv.targetEquity) || 0;
                var positions = enginePositions();
                session.copied = mergeCopiedState(sv.copied, positions);
                adoptUntrackedCopies(session, positions);
                sessions.set(session.address, session);
                schedule(session);
                pollOnce(session);
            } catch (_) { /* session korup: lewati */ }
        });
        if (hasActiveCopies()) installUnloadGuard();
        // Jika user login, tarik session dari server yang belum ada di localStorage
        if (isLoggedIn()) {
            var a = api();
            if (a) {
                a.list().then(function (remote) {
                    if (!remote || remote.guest || !Array.isArray(remote.sessions)) return;
                    remote.sessions.forEach(function (rs) {
                        if (!rs || !rs.address) return;
                        if (sessions.has(String(rs.address).toLowerCase())) return;
                        try {
                            var s = newSession(rs.address, rs.settings || {});
                            s.startedAt = rs.startedAt || Date.now();
                            s.lastFillTime = Number(rs.lastFillTime) || 0;
                            s.targetEquity = Number(rs.targetEquity) || 0;
                            // Hormati status enabled dari server (mis. server
                            // menonaktifkan karena minTargetEquity). Tanpa ini,
                            // syncAllToServer akan menghidupkannya lagi -> flap.
                            s.settings.enabled = rs.enabled !== false;
                            var positions = enginePositions();
                            s.copied = mergeCopiedState(rs.copied, positions);
                            adoptUntrackedCopies(s, positions);
                            sessions.set(s.address, s);
                            schedule(s);
                            pollOnce(s);
                        } catch (_) {}
                    });
                    if (hasActiveCopies()) installUnloadGuard();
                    lsSave();
                }).catch(function () {});
            }
        }
    }

    var CopyTrade = {
        start: start,
        stop: stop,
        get: getSession,
        list: listSessions,
        restore: restore,
        setEnabled: setEnabled,
        setPositionPaused: setPositionPaused,
        updateSettings: updateSettings,
        DEFAULTS: DEFAULTS,
        _test: { computeCopyMargin: computeCopyMargin, pickLeverage: pickLeverage, isBlacklisted: isBlacklisted, dirOf: dirOf, newSession: newSession, mergeCopiedState: mergeCopiedState, adoptUntrackedCopies: adoptUntrackedCopies, coinOfEnginePos: coinOfEnginePos }
    };

    if (typeof window !== 'undefined') window.CopyTrade = CopyTrade;
    if (typeof window !== 'undefined') window.CopyTradeApi = CopyTradeApi;
    if (typeof module !== 'undefined' && module.exports) module.exports = CopyTrade;
})();
