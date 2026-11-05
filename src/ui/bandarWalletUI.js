/* src/ui/bandarWalletUI.js — Modal "Pergerakan Wallet Bandar".
 *
 * Menampilkan 18 wallet bandar BTC terpantau (data dari /api/bandar-wallets,
 * diisi cron bandar-check tiap 10 menit):
 *  - ringkasan: total BTC terpantau, jumlah wallet, ambang alert, update terakhir
 *  - tabel wallet: label, alamat, saldo, arus IN/OUT, pergerakan terakhir
 *    (badge MASUK/KELUAR + indikasi BELI/JUAL/NETRAL)
 *  - feed "Pergerakan terbaru": alert yang tercatat + status email
 *
 * Konvensi disalin dari src/ui/walletTrackerUI.js (IIFE, esc(), toast,
 * modal .active). Self-wire saat DOMContentLoaded: tombol #btn-open-bandar.
 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function toast(msg, isError) {
        try {
            if (typeof showToast === 'function') showToast(msg, !!isError);
            else if (window.showToast) window.showToast(msg, !!isError);
        } catch (_) { /* noop */ }
    }

    // Notifikasi salin alamat (2026-11-02, permintaan user): toast khusus
    // yang SELALU tampil di atas layar — fixed + tengah + z-index di atas
    // modal — dan responsif (mobile/tablet/desktop). Sengaja tidak memakai
    // #sys-toast global: toast itu `position: absolute` (ikut scroll) dan
    // di media query mobile pindah ke bawah layar, sehingga saat modal
    // bandar terbuka user tidak melihat apa-apa dan mengira copy gagal.
    // Elemen ditempel ke document.body (bukan ke dalam modal) supaya tidak
    // ikut terhapus saat render/auto-refresh mengganti isi modal.
    var copyToastTimer = null;
    function showCopyToast(msg, isError) {
        try {
            var style = document.getElementById('bandar-copy-toast-style');
            if (!style) {
                style = document.createElement('style');
                style.id = 'bandar-copy-toast-style';
                style.textContent =
                    '#bandar-copy-toast{position:fixed;top:12px;left:50%;transform:translateX(-50%);' +
                    'z-index:99999;max-width:calc(100vw - 32px);box-sizing:border-box;' +
                    'padding:10px 18px;border-radius:999px;font-size:14px;font-weight:700;' +
                    'text-align:center;color:#fff;background:rgba(20,83,45,.96);' +
                    'border:1px solid #22c55e;box-shadow:0 8px 24px rgba(0,0,0,.45);' +
                    'display:none;pointer-events:none;white-space:nowrap}' +
                    '#bandar-copy-toast.bandar-copy-toast-error{background:rgba(127,29,29,.96);border-color:#ef4444}' +
                    '@media (max-width:480px){#bandar-copy-toast{top:10px;padding:9px 14px;font-size:13px}}';
                document.head.appendChild(style);
            }
            var el = document.getElementById('bandar-copy-toast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'bandar-copy-toast';
                el.setAttribute('role', 'status');
                document.body.appendChild(el);
            }
            el.textContent = msg;
            el.classList.toggle('bandar-copy-toast-error', !!isError);
            el.style.display = 'block';
            if (copyToastTimer) clearTimeout(copyToastTimer);
            copyToastTimer = setTimeout(function () { el.style.display = 'none'; }, 2500);
        } catch (_) { /* toast gagal tampil: jangan ganggu aksi salin */ }
    }

    // Salin teks ke clipboard: pakai Clipboard API bila tersedia, fallback ke
    // textarea + execCommand untuk browser/konteks non-secure. (Pola disalin
    // dari walletTrackerUI.js — handler lama di modal ini tidak punya
    // .catch()/fallback sehingga klik terlihat "tidak berfungsi" saat
    // writeText() di-reject browser.)
    function copyTextToClipboard(text, onOk, onFail) {
        var done = function (ok) { (ok ? onOk : onFail || function () {})(); };
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
                return;
            }
        } catch (_) { /* fallback */ }
        fallback();
        function fallback() {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                var ok = false;
                try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
                document.body.removeChild(ta);
                done(ok);
            } catch (_) { done(false); }
        }
    }

    function fmtBtc(n) {
        if (n === null || n === undefined || !isFinite(Number(n))) return '—';
        return Number(n).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' BTC';
    }

    function fmtHype(n) {
        if (n === null || n === undefined || !isFinite(Number(n))) return '—';
        return Number(n).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' HYPE';
    }

    function fmtUsd(n) {
        if (n === null || n === undefined || !isFinite(Number(n))) return '—';
        return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    function fmtAmt(n, unit) {
        return unit === 'HYPE' ? fmtHype(n) : fmtBtc(n);
    }

    function fmtTime(iso) {
        if (!iso) return '—';
        try {
            return new Date(iso).toLocaleString('id-ID', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch (_) { return '—'; }
    }

    function shortAddr(a) {
        a = String(a || '');
        return a.length > 16 ? a.slice(0, 8) + '…' + a.slice(-6) : a;
    }

    function dirBadge(m) {
        var label = m.action || m.direction;
        if (!label) return '<span style="color:#888">—</span>';
        var signal = m.signal;
        // Warna ikut sinyal: BELI = hijau, JUAL = merah
        var dColor = signal === 'BELI' ? '#22c55e' : signal === 'JUAL' ? '#ef4444' : '#9ca3af';
        var sColor = dColor;
        var sTxt = signal === 'BELI' ? '🟢 BELI' : signal === 'JUAL' ? '🔴 JUAL' : '⚪ NETRAL';
        var fire = m.confluence ? '🔥 ' : '';
        var marketTxt = m.market === 'perps' ? ' <span style="font-size:10px;color:#888">(Perps)</span>'
            : m.market === 'spot' ? ' <span style="font-size:10px;color:#888">(Spot)</span>' : '';
        return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:' + dColor + ';border:1px solid ' + dColor + '">' + fire + esc(label) + '</span> ' +
            '<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:' + sColor + ';border:1px solid ' + sColor + '">' + sTxt + '</span>' + marketTxt;
    }

    var state = { loading: false, data: null, refreshTimer: null };

    function openModal() {
        var m = $('bandar-modal');
        if (!m) return;
        m.classList.remove('is-hidden');
        m.classList.add('active');
        load();
        // Auto-refresh realtime (2026-11-02): snapshot job diperbarui tiap
        // 1 menit, jadi poll 60 detik — lebih cepat tidak ada gunanya karena
        // data baru hanya tersedia tiap 1 menit. Berhenti saat modal ditutup.
        if (state.refreshTimer) clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(function () { load(true); }, 60000);
    }

    function closeModal() {
        var m = $('bandar-modal');
        if (!m) return;
        m.classList.add('is-hidden');
        m.classList.remove('active');
        if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
    }

    async function load(silent) {
        if (state.loading) return;
        state.loading = true;
        var body = $('bandar-modal-body');
        // Refresh diam-diam (auto-refresh / tombol refresh): jangan ganti isi
        // modal dengan placeholder loading — konten lama tetap tampil sampai
        // render baru menggantikannya, agar scroll tidak loncat tiap 60 detik.
        if (body && !silent) body.innerHTML = '<div style="padding:24px;text-align:center;color:#888">⏳ Memuat data wallet bandar…</div>';
        try {
            var res = await fetch('/api/bandar-wallets?alerts=1', { headers: { 'Accept': 'application/json' } });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var json = await res.json();
            state.data = json.data || json;
            render();
        } catch (e) {
            // Jalur cepat 2026-11-05 (GitHub Pages): snapshot precomputed
            // yang diperbarui tiap 10 menit oleh GitHub Actions — satu JSON
            // kecil dari origin yang sama, sehingga di HP tidak perlu lagi
            // live-fetch ~70 request upstream (itu yang bikin modal stuck
            // loading ber menit-menit di 4G). Bila snapshot belum ada atau
            // rusak, lanjut ke live fallback di bawah.
            try {
                var snapRes = await fetch('data/bandar-snapshot.json', { cache: 'no-store', headers: { 'Accept': 'application/json' } });
                if (snapRes.ok) {
                    var snap = await snapRes.json();
                    if (snap && Array.isArray(snap.wallets) && snap.wallets.length > 0 && Array.isArray(snap.hypeWallets)) {
                        state.data = snap;
                        render();
                        return;
                    }
                }
            } catch (snapErr) { /* lanjut ke live fallback di bawah */ }
            // Fallback 2026-11-05: backend /api tidak ada di host statis
            // (GitHub Pages) sehingga fetch di atas 404 — bangun snapshot
            // yang sama langsung dari mempool.space + Hyperliquid publik.
            // Di Vercel jalur ini tidak pernah tersentuh (/api selalu ada).
            var fb = (typeof window !== 'undefined' && window.BandarFallback) || null;
            if (fb && typeof fb.buildSnapshot === 'function') {
                try {
                    state.data = await fb.buildSnapshot();
                    render();
                    return;
                } catch (fbErr) {
                    if (body) body.innerHTML = '<div style="padding:24px;text-align:center;color:#ef4444">Gagal memuat data: ' + esc(e.message) + ' (fallback juga gagal: ' + esc(fbErr.message) + ')</div>';
                    toast('Gagal memuat data bandar: ' + e.message, true);
                }
            } else {
                if (body) body.innerHTML = '<div style="padding:24px;text-align:center;color:#ef4444">Gagal memuat data: ' + esc(e.message) + '</div>';
                toast('Gagal memuat data bandar: ' + e.message, true);
            }
        } finally {
            state.loading = false;
        }
    }

    function render() {
        var body = $('bandar-modal-body');
        if (!body || !state.data) return;
        var d = state.data;
        var html = '';

        if (d.stale || d.storageNote) {
            html += '<div style="padding:10px 12px;border-radius:8px;background:#3b2f0b;color:#fbbf24;font-size:12px;margin-bottom:12px">⚠️ ' +
                esc(d.storageNote || 'Data snapshot belum tersedia — cron bandar-check belum berjalan.') + '</div>';
        }

        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
            statBox('💰 Total BTC terpantau', fmtBtc(d.totalBtc)) +
            statBox('💎 Total HYPE terpantau', fmtHype(d.totalHype)) +
            statBox('🐋 Wallet', esc((d.watchCount || (d.wallets || []).length) + (d.hypeWatchCount ? ' + ' + d.hypeWatchCount + ' HYPE' : '')) + ' alamat') +
            statBox('🔔 Ambang', fmtBtc(d.thresholdBtc) + ' / ' + fmtHype(d.hypeThresholdHype)) +
            statBox('🕐 Update terakhir', fmtTime(d.updatedAt));
        // Status notif hanya untuk admin (izkalavender@gmail.com) — user request 2026-10-09
        var auth = (typeof window !== 'undefined' && window.MasakoAuth) || {};
        var isAdmin = auth.isAuthenticated && auth.email === 'izkalavender@gmail.com';
        if (isAdmin) {
            html += statBox('📧 Notif email', d.emailConfigured ? '<span style="color:#22c55e">Aktif</span>' : '<span style="color:#9ca3af">Belum diset</span>') +
                statBox('✈️ Notif Telegram', d.telegramConfigured ? '<span style="color:#22c55e">Aktif</span>' : '<span style="color:#9ca3af">Belum diset</span>');
        }
        html += '</div>';

        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0 8px">' +
            '<strong>₿ Daftar wallet bandar (BTC)</strong>' +
            '<span style="font-size:11px;color:#9ca3af">⏱ auto-refresh 60 dtk</span>' +
            '<button class="tab-btn" id="bandar-refresh" type="button">🔄 Refresh</button></div>';
        html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
            '<thead><tr style="text-align:left;color:#9ca3af;border-bottom:1px solid #333">' +
            '<th style="padding:6px">Label</th><th style="padding:6px">Alamat</th>' +
            '<th style="padding:6px;text-align:right">Saldo</th>' +
            '<th style="padding:6px;text-align:right">IN</th><th style="padding:6px;text-align:right">OUT</th>' +
            '<th style="padding:6px">Pergerakan terakhir</th></tr></thead><tbody>';

        (d.wallets || []).forEach(function (w) {
            var lm = w.lastMovement;
            var lmHtml = lm
                ? dirBadge(lm) + '<div style="font-size:11px;color:#9ca3af;margin-top:4px">' +
                  fmtBtc(lm.net) + ' • ' + fmtTime(lm.time) + '</div>'
                : '<span style="color:#666;font-size:11px">—</span>';
            html += '<tr style="border-bottom:1px solid #222">' +
                '<td style="padding:6px"><strong>' + esc(w.label) + '</strong><div style="font-size:10px;color:#666">' + esc(w.kind || '') + '</div></td>' +
                '<td style="padding:6px;font-family:monospace" title="' + esc(w.address) + '">' + esc(shortAddr(w.address)) +
                ' <button class="tab-btn" style="padding:1px 6px;font-size:10px" data-bandar-copy="' + esc(w.address) + '" type="button" title="Salin alamat">📋</button></td>' +
                '<td style="padding:6px;text-align:right">' + fmtBtc(w.balanceBtc) + '</td>' +
                '<td style="padding:6px;text-align:right;color:#22c55e">+' + fmtBtc(w.windowIn) + '</td>' +
                '<td style="padding:6px;text-align:right;color:#ef4444">−' + fmtBtc(w.windowOut) + '</td>' +
                '<td style="padding:6px">' + lmHtml + '</td></tr>';
        });
        html += '</tbody></table></div>';

        // ---- Bandar HYPE (Hyperliquid) ----
        html += '<div style="margin:18px 0 8px"><strong>💎 Daftar wallet bandar (HYPE)</strong>' +
            '<div style="font-size:11px;color:#9ca3af">Spot + staking + posisi perps, dicek tiap 1 menit via Hyperliquid API</div></div>';
        html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
            '<thead><tr style="text-align:left;color:#9ca3af;border-bottom:1px solid #333">' +
            '<th style="padding:6px">Label</th><th style="padding:6px">Alamat</th>' +
            '<th style="padding:6px;text-align:right">Spot</th>' +
            '<th style="padding:6px;text-align:right">Staked</th>' +
            '<th style="padding:6px;text-align:right">Total</th>' +
            '<th style="padding:6px;text-align:right">Perps HYPE</th>' +
            '<th style="padding:6px;text-align:right">Perps BTC</th>' +
            '<th style="padding:6px;text-align:right">Perps ETH</th>' +
            '<th style="padding:6px;text-align:right">Perps SOL</th>' +
            '<th style="padding:6px;text-align:right">Perps STRK</th>' +
            '<th style="padding:6px;text-align:right">Perps W</th>' +
            '<th style="padding:6px;text-align:right">Perps DOGE</th>' +
            '<th style="padding:6px;text-align:right">Perps XRP</th>' +
            '<th style="padding:6px;text-align:right">Perps ENA</th>' +
            '<th style="padding:6px;text-align:right">Perps ZRO</th>' +
            '<th style="padding:6px;text-align:right">Perps ZEC</th>' +
            '<th style="padding:6px;text-align:right">Perps TRX</th>' +
            '<th style="padding:6px;text-align:right">Perps VVV</th>' +
            '<th style="padding:6px;text-align:right">Perps AAVE</th>' +
            '<th style="padding:6px;text-align:right">Perps UNI</th>' +
            '<th style="padding:6px;text-align:right">Perps PUMP</th>' +
            '<th style="padding:6px;text-align:right">Perps ASTER</th>' +
            '<th style="padding:6px;text-align:right">Perps PAXG</th>' +
            '<th style="padding:6px;text-align:right">Perps NEAR</th>' +
            '<th style="padding:6px;text-align:right">Perps XMR</th></tr></thead><tbody>';

        // PnL% posisi perps (2026-11-02): dari pergerakan harga, tanpa
        // leverage. Hijau = profit, merah = minus, kosong = tidak ada data.
        // FIX 2026-11-02: helper ini WAJIB didefinisikan SEBELUM dipakai —
        // sebelumnya dideklarasi dengan `var` DI DALAM loop SETELAH sel
        // HYPE/BTC memanggilnya, sehingga nilainya masih undefined dan
        // modal gagal total ("pnlPctTxt is not a function").
        var pnlPctTxt = function (pct) {
            if (pct === null || pct === undefined || !isFinite(Number(pct))) return '';
            var v = Number(pct);
            var color = v > 0 ? '#22c55e' : (v < 0 ? '#ef4444' : '#9ca3af');
            return '<div style="font-size:11px;font-weight:700;color:' + color + '">' +
                (v > 0 ? '+' : '') + v.toFixed(1) + '%</div>';
        };

        (d.hypeWallets || []).forEach(function (w) {
            var perpTxt = (w.perpSize === null || w.perpSize === undefined || !isFinite(Number(w.perpSize)) || Number(w.perpSize) === 0)
                ? '<span style="color:#666">—</span>'
                : '<span style="color:' + (Number(w.perpSize) > 0 ? '#22c55e' : '#ef4444') + ';font-weight:700">' +
                  (Number(w.perpSize) > 0 ? 'LONG ' : 'SHORT ') + fmtHype(Math.abs(Number(w.perpSize))) + '</span>' +
                  (w.perpEntry ? '<div style="font-size:10px;color:#666">entry $' + esc(w.perpEntry) + '</div>' : '') +
                  pnlPctTxt(w.perpPnlPct);
            var btcPerpTxt = (w.btcPerpSize === null || w.btcPerpSize === undefined || !isFinite(Number(w.btcPerpSize)) || Number(w.btcPerpSize) === 0)
                ? '<span style="color:#666">—</span>'
                : '<span style="color:' + (Number(w.btcPerpSize) > 0 ? '#22c55e' : '#ef4444') + ';font-weight:700">' +
                  (Number(w.btcPerpSize) > 0 ? 'LONG ' : 'SHORT ') + fmtBtc(Math.abs(Number(w.btcPerpSize))) + '</span>' +
                  (w.btcPerpEntry ? '<div style="font-size:10px;color:#666">entry $' + esc(fmtUsd(w.btcPerpEntry)) + '</div>' : '') +
                  pnlPctTxt(w.btcPerpPnlPct);
            // Helper untuk kolom perps ETH/SOL (user request 2026-10-11)
            var perpCoinTxt = function(size, entry, unit, pct) {
                if (size === null || size === undefined || !isFinite(Number(size)) || Number(size) === 0)
                    return '<span style="color:#666">—</span>';
                var sz = Number(size);
                var amt = Math.abs(sz).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + ' ' + unit;
                return '<span style="color:' + (sz > 0 ? '#22c55e' : '#ef4444') + ';font-weight:700">' +
                    (sz > 0 ? 'LONG ' : 'SHORT ') + amt + '</span>' +
                    (entry ? '<div style="font-size:10px;color:#666">entry $' + esc(fmtUsd(entry)) + '</div>' : '') +
                    pnlPctTxt(pct);
            };
            var ethPerpTxt = perpCoinTxt(w.ethPerpSize, w.ethPerpEntry, 'ETH', w.ethPerpPnlPct);
            var solPerpTxt = perpCoinTxt(w.solPerpSize, w.solPerpEntry, 'SOL', w.solPerpPnlPct);
            var strkPerpTxt = perpCoinTxt(w.strkPerpSize, w.strkPerpEntry, 'STRK', w.strkPerpPnlPct);
            var wPerpTxt = perpCoinTxt(w.wPerpSize, w.wPerpEntry, 'W', w.wPerpPnlPct);
            var dogePerpTxt = perpCoinTxt(w.dogePerpSize, w.dogePerpEntry, 'DOGE', w.dogePerpPnlPct);
            var xrpPerpTxt = perpCoinTxt(w.xrpPerpSize, w.xrpPerpEntry, 'XRP', w.xrpPerpPnlPct);
            var enaPerpTxt = perpCoinTxt(w.enaPerpSize, w.enaPerpEntry, 'ENA', w.enaPerpPnlPct);
            var zroPerpTxt = perpCoinTxt(w.zroPerpSize, w.zroPerpEntry, 'ZRO', w.zroPerpPnlPct);
            var zecPerpTxt = perpCoinTxt(w.zecPerpSize, w.zecPerpEntry, 'ZEC', w.zecPerpPnlPct);
            var trxPerpTxt = perpCoinTxt(w.trxPerpSize, w.trxPerpEntry, 'TRX', w.trxPerpPnlPct);
            var vvvPerpTxt = perpCoinTxt(w.vvvPerpSize, w.vvvPerpEntry, 'VVV', w.vvvPerpPnlPct);
            var aavePerpTxt = perpCoinTxt(w.aavePerpSize, w.aavePerpEntry, 'AAVE', w.aavePerpPnlPct);
            var uniPerpTxt = perpCoinTxt(w.uniPerpSize, w.uniPerpEntry, 'UNI', w.uniPerpPnlPct);
            var pumpPerpTxt = perpCoinTxt(w.pumpPerpSize, w.pumpPerpEntry, 'PUMP', w.pumpPerpPnlPct);
            var asterPerpTxt = perpCoinTxt(w.asterPerpSize, w.asterPerpEntry, 'ASTER', w.asterPerpPnlPct);
            var paxgPerpTxt = perpCoinTxt(w.paxgPerpSize, w.paxgPerpEntry, 'PAXG', w.paxgPerpPnlPct);
            var nearPerpTxt = perpCoinTxt(w.nearPerpSize, w.nearPerpEntry, 'NEAR', w.nearPerpPnlPct);
            var xmrPerpTxt = perpCoinTxt(w.xmrPerpSize, w.xmrPerpEntry, 'XMR', w.xmrPerpPnlPct);
            html += '<tr style="border-bottom:1px solid #222">' +
                '<td style="padding:6px"><strong>' + esc(w.label) + '</strong><div style="font-size:10px;color:#666">' + esc(w.kind || '') + '</div>' +
                (w.intel ? '<div style="font-size:10px;color:#7d6a3a;max-width:220px">' + esc(w.intel) + '</div>' : '') + '</td>' +
                '<td style="padding:6px;font-family:monospace" title="' + esc(w.address) + '">' + esc(shortAddr(w.address)) +
                ' <button class="tab-btn" style="padding:1px 6px;font-size:10px" data-bandar-copy="' + esc(w.address) + '" type="button" title="Salin alamat">📋</button></td>' +
                '<td style="padding:6px;text-align:right">' + fmtHype(w.spot) + '</td>' +
                '<td style="padding:6px;text-align:right">' + fmtHype(w.staked) + '</td>' +
                '<td style="padding:6px;text-align:right"><strong>' + fmtHype(w.total) + '</strong></td>' +
                '<td style="padding:6px;text-align:right">' + perpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + btcPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + ethPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + solPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + strkPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + wPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + dogePerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + xrpPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + enaPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + zroPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + zecPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + trxPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + vvvPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + aavePerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + uniPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + pumpPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + asterPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + paxgPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + nearPerpTxt + '</td>' +
                '<td style="padding:6px;text-align:right">' + xmrPerpTxt + '</td></tr>';
        });
        html += '</tbody></table></div>';

        html += '<div style="margin:16px 0 8px"><strong>🔔 Pergerakan terbaru (alert tercatat)</strong></div>';
        if (d.alerts && d.alerts.length) {
            html += '<div style="max-height:260px;overflow-y:auto">';
            d.alerts.forEach(function (a) {
                var unit = a.unit || (a.chain === 'HYPE' ? 'HYPE' : 'BTC');
                var amt = (a.amount !== undefined && a.amount !== null) ? a.amount : a.amountBtc;
                var txLink;
                if (a.chain === 'HYPE' || String(a.txid || '').indexOf('hypepos:') === 0) {
                    txLink = '<div style="font-size:11px;color:#666;margin-top:4px">📊 position-diff Hyperliquid</div>';
                } else {
                    txLink = '<div style="font-family:monospace;font-size:11px;color:#666;margin-top:4px"><a href="https://mempool.space/tx/' + esc(a.txid) + '" target="_blank" rel="noopener" style="color:#7dd3fc">txid ' + esc(String(a.txid).slice(0, 16)) + '…</a></div>';
                }
                html += '<div style="padding:8px 10px;border:1px solid #2a2a2a;border-radius:8px;margin-bottom:8px;font-size:12px">' +
                    '<div style="margin-bottom:4px">' + dirBadge(a) +
                    ' <strong>' + fmtAmt(amt, unit) + '</strong> — ' + esc(a.label) +
                    ' <span style="color:#666">• ' + fmtTime(a.time) + (a.emailed ? ' • 📧 terkirim' : '') + '</span></div>' +
                    '<div style="color:#9ca3af">' + esc(a.note || '') + '</div>' +
                    txLink +
                    '</div>';
            });
            html += '</div>';
        } else {
            html += '<div style="color:#666;font-size:12px">Belum ada pergerakan besar tercatat.</div>';
        }

        body.innerHTML = html;

        var rb = $('bandar-refresh');
        if (rb) rb.addEventListener('click', function () { load(true); });
        body.querySelectorAll('[data-bandar-copy]').forEach(function (b) {
            b.addEventListener('click', function (e) {
                if (e) { e.preventDefault(); e.stopPropagation(); }
                var addr = b.getAttribute('data-bandar-copy') || '';
                copyTextToClipboard(addr,
                    function () { showCopyToast('Copy berhasil ✅', false); },
                    function () { showCopyToast('Gagal menyalin alamat', true); });
            });
        });
    }

    function statBox(label, value) {
        return '<div style="flex:1;min-width:130px;padding:10px 12px;border:1px solid #2a2a2a;border-radius:10px">' +
            '<div style="font-size:11px;color:#9ca3af">' + esc(label) + '</div>' +
            '<div style="font-size:15px;font-weight:700;margin-top:2px">' + value + '</div></div>';
    }

    document.addEventListener('DOMContentLoaded', function () {
        var openBtn = $('btn-open-bandar');
        if (openBtn) openBtn.addEventListener('click', openModal);
        var m = $('bandar-modal');
        if (m) {
            m.querySelectorAll('[data-bandar-close]').forEach(function (b) {
                b.addEventListener('click', closeModal);
            });
            m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeModal();
        });
    });

    window.BandarWalletUI = { open: openModal, close: closeModal, refresh: load };
})();
