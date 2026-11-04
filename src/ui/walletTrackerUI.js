/* src/ui/walletTrackerUI.js — UI kartu "Wallet Tracker (Smart Money)".
 *
 * Tab: Rekomendasi (top-5) | Leaderboard All (dengan filter) | Cari Wallet | Copy Saya.
 * Fitur:
 *  - Modal Copy dengan margin $ per posisi + leverage fixed (FIX: tombol Copy kini bekerja)
 *  - Tombol Cek Entry Chart di detail wallet -> beralih chart + gambar garis entry + label LONG/SHORT PnL
 *  - Trading Ledger menampilkan badge "Copy Trade Aktif" dengan toggle on/off per wallet & per posisi
 *  - Tab Leaderboard All dengan filter window (7H sd 6B) + sort Winrate/Equity/PnL/Score + min equity slider
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

    // Salin teks ke clipboard: pakai Clipboard API bila tersedia, fallback ke
    // textarea + execCommand untuk browser/konteks non-secure.
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

    function wt() { return window.WalletTracker || null; }
    function ct() { return window.CopyTrade || null; }

    // Jam:menit:detik untuk waktu open posisi copy (konsisten dgn kartu posisi terminal).
    function fmtClock(ts) {
        var n = Number(ts);
        if (!n) return '—';
        try {
            return new Date(n).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        } catch (_) { return '—'; }
    }

    // Keterlambatan mirror vs wallet target: "pas ✅" bila <=2 dtk,
    // "telat X dtk/mnt ⏳" selebihnya.
    function fmtCopyLag(openedAt, targetOpenTime) {
        var lagS = Math.max(0, Math.round((Number(openedAt) - Number(targetOpenTime)) / 1000));
        if (!Number.isFinite(lagS)) return '';
        if (lagS <= 2) return 'pas ✅';
        if (lagS < 60) return 'telat ' + lagS + ' dtk ⏳';
        var m = Math.floor(lagS / 60), r = lagS % 60;
        return 'telat ' + m + ' mnt' + (r ? ' ' + r + ' dtk' : '') + ' ⏳';
    }
    function fe() {
        if (typeof FuturesEngine !== 'undefined' && FuturesEngine) return FuturesEngine;
        return window.FuturesEngine || null;
    }

    var state = {
        tab: 'reco',
        win: '7d',
        detailAddr: null,
        recoLoading: false,
        lb: {
            sortBy: 'score',
            minEquity: 10000,
            maxEquity: 0,
            minWr: 0,
            loading: false
        },
        entryChart: {
            miniChart: null,
            miniSeries: null,
            lines: [],
            poller: null,
            loadSeq: 0, // penanda anti-balap antar load chart
            active: null // {coin, pair, entryPx, side, pnlInfo, tf}
        }
    };

    var WIN_BTNS = [['7d', '7H'], ['14d', '14H'], ['1m', '1B'], ['3m', '3B'], ['6m', '6B']];

    /* ---------------- panes ---------------- */
    function showTab(name) {
        state.tab = name;
        ['reco', 'leaderboard', 'search', 'copy'].forEach(function (t) {
            var pane = $('wt-pane-' + t);
            if (pane) pane.classList.toggle('is-hidden', t !== name);
        });
        var btns = document.querySelectorAll('#wt-tabs .tab-btn');
        btns.forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-wt-tab') === name);
        });
        hideDetail();
        if (name === 'reco') loadReco();
        if (name === 'leaderboard') loadLeaderboard();
        if (name === 'search') renderWalletHistory();
        if (name === 'copy') renderCopyList();
    }

    function hideDetail() {
        state.detailAddr = null;
        closeEntryChart();
        var d = $('wt-detail');
        if (d) { d.classList.add('is-hidden'); d.innerHTML = ''; }
        ['reco', 'leaderboard', 'search', 'copy'].forEach(function (t) {
            var pane = $('wt-pane-' + t);
            if (pane) pane.classList.toggle('is-hidden', t !== state.tab);
        });
    }

    /* ---------------- rekomendasi ---------------- */
    function pnlClass(v) { return Number(v) >= 0 ? 'wt-pos' : 'wt-neg'; }

    async function loadReco() {
        var tracker = wt();
        var list = $('wt-reco-list');
        if (!tracker || !list) return;
        if (state.recoLoading) return;
        state.recoLoading = true;
        list.innerHTML = '<div class="wt-loading">Memuat rekomendasi wallet…</div>';
        try {
            var data = await tracker.getRecommendations(state.win);
            renderReco(list, data);
        } catch (e) {
            list.innerHTML = '<div class="wt-error">Gagal memuat: ' + esc(e.message || e) +
                ' <button class="tab-btn" id="wt-reco-retry">Coba lagi</button></div>';
            var r = $('wt-reco-retry');
            if (r) r.addEventListener('click', function () { state.recoLoading = false; loadReco(); });
        } finally {
            state.recoLoading = false;
        }
    }

    function renderWalletRow(w, i, showRank) {
        var tracker = wt();
        var name = w.displayName ? esc(w.displayName) : esc(tracker.shortAddr(w.address));
        var rank = showRank ? ('<div class="wt-rank">' + (i + 1) + '</div>') : '';
        var wrStr = (w.winRate && w.winRate > 0) ? (' · WR ' + (w.winRate * 100).toFixed(1) + '%') : '';
        // Komposisi posisi aktif (live): hanya tampil bila wallet punya posisi
        // terbuka — baris tanpa data posisi (di luar shortlist enrichment)
        // tetap tampil seperti sebelumnya, tanpa baris ini.
        var posStr = '';
        if (w.activePositions > 0) {
            posStr = '<div class="wt-sub">' + w.activePositions + ' posisi aktif: ' +
                w.winPositions + ' profit / ' + w.lossPositions + ' minus' +
                ' · uPnL <span class="' + pnlClass(w.upnl) + '">' + esc(tracker.fmtUsd(w.upnl)) + '</span></div>';
        }
        var html = '<div class="wt-row" data-addr="' + esc(w.address) + '">' +
            rank +
            '<div class="wt-main">' +
            '<div class="wt-name">' + name + '</div>' +
            '<div class="wt-sub">' + esc(tracker.shortAddr(w.address)) + ' · Eq ' + esc(tracker.fmtUsd(w.equity)) + wrStr + '</div>' +
            '<div class="wt-sub"><span class="' + pnlClass(w.pnl) + '">' + esc(tracker.fmtUsd(w.pnl)) +
            ' (' + esc(tracker.fmtPct(w.roi)) + ')</span> · skor ' + esc(w.score) + '</div>' +
            posStr +
            '</div>' +
            '<div class="wt-actions">' +
            '<button class="tab-btn wt-btn-detail" type="button">Detail</button>' +
            '<button class="tab-btn wt-btn-copy" type="button">Copy</button>' +
            '</div></div>';
        return html;
    }

    function renderReco(list, data) {
        var tracker = wt();
        var label = (tracker.WINDOW_LABELS && tracker.WINDOW_LABELS[state.win]) || state.win;
        if (!data || !data.wallets || !data.wallets.length) {
            list.innerHTML = '<div class="wt-empty">Belum ada rekomendasi untuk window ini.</div>';
            return;
        }
        var medal = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
        var html = '<div class="wt-meta">Top 5 wallet · PnL ' + esc(label) + ' · diperbarui ' +
            esc(tracker.fmtAgo(Date.parse(data.generatedAt))) + '</div>';
        html += '<div class="wt-list">';
        data.wallets.forEach(function (w, i) {
            var name = w.displayName ? esc(w.displayName) : esc(tracker.shortAddr(w.address));
            html += '<div class="wt-row" data-addr="' + esc(w.address) + '">' +
                '<div class="wt-rank">' + (medal[i] || (i + 1)) + '</div>' +
                '<div class="wt-main">' +
                '<div class="wt-name">' + name + '</div>' +
                '<div class="wt-sub">' + esc(tracker.shortAddr(w.address)) + ' · Eq ' + esc(tracker.fmtUsd(w.equity)) + '</div>' +
                '<div class="wt-sub"><span class="' + pnlClass(w.pnl) + '">' + esc(tracker.fmtUsd(w.pnl)) +
                ' (' + esc(tracker.fmtPct(w.roi)) + ')</span> · skor ' + esc(w.score) + '</div>' +
                '</div>' +
                '<div class="wt-actions">' +
                '<button class="tab-btn wt-btn-detail" type="button">Detail</button>' +
                '<button class="tab-btn wt-btn-copy wt-copy-btn-fixed" type="button">📋 Copy</button>' +
                '</div></div>';
        });
        html += '</div>';
        list.innerHTML = html;
        wireRowButtons(list);
    }

    function wireRowButtons(container) {
        if (!container || !container.querySelectorAll) return;
        var rows = container.querySelectorAll('.wt-row');
        if (!rows || !rows.forEach) return;
        rows.forEach(function (row) {
            if (!row || !row.getAttribute) return;
            var addr = row.getAttribute('data-addr');
            var btnDetail = row.querySelector ? row.querySelector('.wt-btn-detail') : null;
            var btnCopy = row.querySelector ? row.querySelector('.wt-btn-copy') : null;
            if (btnDetail && btnDetail.addEventListener) btnDetail.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); showDetail(addr); });
            if (btnCopy && btnCopy.addEventListener) btnCopy.addEventListener('click', function (ev) { if (ev) { if (ev.stopPropagation) ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault(); } openCopyModal(addr); });
            if (row.addEventListener) row.addEventListener('click', function (ev) {
                if (ev && ev.target && ev.target.closest) {
                    if (ev.target.closest('.wt-btn-detail') || ev.target.closest('.wt-btn-copy')) return;
                }
                showDetail(addr);
            });
        });
    }

    /* ---------------- leaderboard all ---------------- */
    async function loadLeaderboard() {
        var tracker = wt();
        var list = $('wt-lb-list');
        if (!tracker || !list) return;
        if (state.lb.loading) return;
        state.lb.loading = true;
        list.innerHTML = '<div class="wt-loading">Memuat leaderboard…</div>';
        try {
            var data = await tracker.getLeaderboard(state.win, {
                sortBy: state.lb.sortBy,
                minEquity: state.lb.minEquity,
                maxEquity: state.lb.maxEquity,
                minWinRate: state.lb.minWr,
                limit: 50
            });
            renderLeaderboard(list, data);
        } catch (e) {
            list.innerHTML = '<div class="wt-error">Gagal memuat leaderboard: ' + esc(e.message || e) +
                ' <button class="tab-btn" id="wt-lb-retry">Coba lagi</button></div>';
            var r = $('wt-lb-retry');
            if (r) r.addEventListener('click', function () { state.lb.loading = false; loadLeaderboard(); });
        } finally {
            state.lb.loading = false;
        }
    }

    function renderLeaderboard(list, data) {
        var tracker = wt();
        var label = (tracker.WINDOW_LABELS && tracker.WINDOW_LABELS[state.win]) || state.win;
        if (!data || !data.wallets || !data.wallets.length) {
            list.innerHTML = '<div class="wt-empty">Tidak ada wallet sesuai filter. Coba turunkan batas min equity.</div>';
            return;
        }
        var html = '<div class="wt-meta">Menampilkan ' + data.wallets.length + ' wallet dari ' + (data.total || '?') +
            ' · PnL ' + esc(label) + ' · urut ' + esc(sortLabel(state.lb.sortBy)) +
            ' · diperbarui ' + esc(tracker.fmtAgo(Date.parse(data.generatedAt))) + '</div>';
        html += '<div class="wt-list">';
        data.wallets.forEach(function (w, i) {
            html += renderWalletRow(w, i, true);
        });
        html += '</div>';
        list.innerHTML = html;
        wireRowButtons(list);
    }

    function sortLabel(k) {
        return ({ score: 'Skor AI', equity: 'Equity', pnl: 'PnL $', roi: 'ROI %' })[k] || k;
    }

    /* ---------------- detail wallet ---------------- */
    async function showDetail(address) {
        var tracker = wt();
        if (!tracker) return;
        if (!tracker.isValidAddress(address)) { toast('Alamat wallet tidak valid', true); return; }
        state.detailAddr = address;
        ['reco', 'leaderboard', 'search', 'copy'].forEach(function (t) {
            var pane = $('wt-pane-' + t);
            if (pane) pane.classList.add('is-hidden');
        });
        var d = $('wt-detail');
        d.classList.remove('is-hidden');
        d.innerHTML = '<div class="wt-loading">Memuat data wallet ' + esc(tracker.shortAddr(address)) + '…</div>';
        try {
            var data = await tracker.getWalletDetail(address);
            renderDetail(d, data);
        } catch (e) {
            d.innerHTML = '<div class="wt-error">Gagal memuat: ' + esc(e.message || e) + '</div>' +
                '<button class="tab-btn" id="wt-detail-back">← Kembali</button>';
            $('wt-detail-back').addEventListener('click', hideDetail);
        }
    }

    function renderDetail(d, data) {
        var tracker = wt(), copier = ct();
        var alreadyCopying = !!(copier && copier.get && copier.get(data.address));
        var html = '<button class="tab-btn" id="wt-detail-back" type="button">← Kembali</button> ';
        html += '<button class="btn btn-primary wt-detail-copy-btn" id="wt-detail-copy" type="button">📋 ' +
            (alreadyCopying ? 'Copy Aktif · Lihat' : 'Copy wallet ini') + '</button>';
        html += '<div class="wt-detail-head">';
        html += '<div class="value-large">' + esc(tracker.fmtUsd(data.equity)) + '</div>';
        html += '<div class="micro-label">EQUITY · ' + esc(tracker.shortAddr(data.address)) + '</div>';
        html += '<div class="wt-sub">Win rate ' + esc((data.stats.winRate * 100).toFixed(1)) + '% · ' +
            esc(data.stats.closes) + ' close · PF ' +
            (data.stats.profitFactor === Infinity ? '∞' : esc(Number(data.stats.profitFactor).toFixed(2))) + '</div>';
        html += '</div>';

        html += '<div class="micro-label u-mb-6">PNL PER WINDOW</div><div class="wt-chips">';
        Object.keys(tracker.WINDOW_LABELS).forEach(function (k) {
            var w = data.windows && data.windows[k];
            var label = tracker.WINDOW_LABELS[k];
            if (!w) { html += '<span class="badge">' + esc(label) + ': —</span>'; return; }
            html += '<span class="badge ' + pnlClass(w.pnl) + '">' + esc(label) + ': ' +
                esc(tracker.fmtUsd(w.pnl)) + ' (' + esc(tracker.fmtPct(w.roi)) + ')</span>';
        });
        html += '</div>';

        // Entry chart mini container
        html += '<div class="wt-entry-chart-wrap is-hidden" id="wt-entry-chart-wrap">' +
            '<div class="row-between u-mb-6"><div class="micro-label">CEK ENTRY CHART</div>' +
            '<button class="tab-btn" id="wt-entry-close" type="button">Tutup chart</button></div>' +
            '<div class="wt-entry-tf" id="wt-entry-tf">' +
            '<button class="tab-btn" data-wt-tf="15m" type="button">15M</button>' +
            '<button class="tab-btn" data-wt-tf="1h" type="button">1H</button>' +
            '<button class="tab-btn" data-wt-tf="1d" type="button">1D</button>' +
            '</div>' +
            '<div id="wt-entry-chart" class="wt-entry-chart"></div>' +
            '<div class="wt-entry-legend" id="wt-entry-legend"></div>' +
            '</div>';

        html += '<div class="micro-label u-mb-6">POSISI TERBUKA (' + data.positions.length + ')</div>';
        if (!data.positions.length) {
            html += '<div class="wt-empty">Wallet ini sedang tidak punya posisi terbuka.</div>';
        } else {
            html += '<div class="wt-table-wrap"><table class="wt-table"><thead><tr>' +
                '<th>Koin</th><th>Arah</th><th>Entry</th><th>Size</th><th>Lev</th><th>uPnL</th><th>Buka</th><th>Aksi</th>' +
                '</tr></thead><tbody>';
            data.positions.forEach(function (p) {
                var dirCls = p.side === 'LONG' ? 'wt-pos' : 'wt-neg';
                var pair = (p.coin || '') + 'USDT';
                html += '<tr data-wt-coin="' + esc(p.coin) + '" data-wt-entry="' + esc(p.entryPx) + '" data-wt-side="' + esc(p.side) + '" data-wt-pair="' + esc(pair) + '">' +
                    '<td><strong>' + esc(p.coin) + '</strong></td>' +
                    '<td class="' + dirCls + '">' + esc(p.side) + '</td>' +
                    '<td>' + esc(Number(p.entryPx).toLocaleString('en-US')) + '</td>' +
                    '<td>' + esc(tracker.fmtUsd(p.notional)) + '</td>' +
                    '<td>' + esc(p.leverage) + 'x</td>' +
                    '<td class="' + pnlClass(p.uPnl) + '">' + esc(tracker.fmtUsd(p.uPnl)) +
                    ' (' + esc(tracker.fmtPct(p.roe)) + ')</td>' +
                    '<td title="' + esc(tracker.fmtTime(p.openTime)) + '">' + esc(tracker.fmtAgo(p.openTime)) + '</td>' +
                    '<td><button class="tab-btn wt-entry-chart-btn" type="button" data-wt-coin="' + esc(p.coin) + '">📈 Cek Entry</button></td>' +
                    '</tr>';
            });
            html += '</tbody></table></div>';
        }

        html += '<div class="micro-label u-mb-6">FILL TERAKHIR</div><div class="wt-fills">';
        (data.recentFills || []).slice(0, 10).forEach(function (f) {
            html += '<div class="wt-fill"><span>' + esc(tracker.fmtTime(f.time)) + '</span>' +
                '<span><strong>' + esc(f.coin) + '</strong> ' + esc(f.dir) + '</span>' +
                '<span>@' + esc(Number(f.px).toLocaleString('en-US')) + '</span>' +
                (f.closedPnl ? '<span class="' + pnlClass(f.closedPnl) + '">' + esc(tracker.fmtUsd(f.closedPnl)) + '</span>' : '') +
                '</div>';
        });
        html += '</div>';

        d.innerHTML = html;
        $('wt-detail-back').addEventListener('click', hideDetail);
        $('wt-detail-copy').addEventListener('click', function () { openCopyModal(data.address); });
        $('wt-entry-close').addEventListener('click', closeEntryChart);
        d.querySelectorAll('#wt-entry-tf .tab-btn').forEach(function (btn) {
            btn.addEventListener('click', function () { setEntryTf(btn.getAttribute('data-wt-tf')); });
        });

        d.querySelectorAll('.wt-entry-chart-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var tr = btn.closest('tr');
                if (!tr) return;
                var coin = tr.getAttribute('data-wt-coin');
                var entryPx = Number(tr.getAttribute('data-wt-entry'));
                var side = tr.getAttribute('data-wt-side');
                var pair = tr.getAttribute('data-wt-pair');
                var uPnl = null;
                // cari posisi yang cocok untuk uPnL
                (data.positions || []).forEach(function (p) {
                    if (p.coin === coin) uPnl = { uPnl: p.uPnl, roe: p.roe, notional: p.notional, leverage: p.leverage };
                });
                openEntryChart(coin, pair, entryPx, side, uPnl);
            });
        });
    }

    /* ---------------- entry chart mini ---------------- */
    function disposeEntryChart() {
        if (state.entryChart.poller) {
            try { clearInterval(state.entryChart.poller); } catch (_) {}
            state.entryChart.poller = null;
        }
        if (state.entryChart.miniChart) {
            try { state.entryChart.miniChart.remove(); } catch (_) {}
            state.entryChart.miniChart = null;
            state.entryChart.miniSeries = null;
        }
        state.entryChart.lines = [];
    }

    function closeEntryChart() {
        // Batalkan load yang masih tertunda agar tidak bangkit setelah ditutup.
        state.entryChart.loadSeq = (state.entryChart.loadSeq || 0) + 1;
        var wrap = $('wt-entry-chart-wrap');
        if (wrap) wrap.classList.add('is-hidden');
        disposeEntryChart();
        state.entryChart.active = null;
    }

    function openEntryChart(coin, pair, entryPx, side, pnlInfo) {
        state.entryChart.active = {
            coin: coin, pair: pair, entryPx: entryPx, side: side,
            pnlInfo: pnlInfo || null, tf: '15m'
        };
        loadEntryChart();
    }

    function setEntryTf(tf) {
        var cur = state.entryChart.active;
        if (!cur || !tf || cur.tf === tf) return;
        cur.tf = tf;
        loadEntryChart();
    }

    async function loadEntryChart() {
        var active = state.entryChart.active;
        if (!active) return;
        var tracker = wt();
        var wrap = $('wt-entry-chart-wrap');
        var box = $('wt-entry-chart');
        var legend = $('wt-entry-legend');
        if (!wrap || !box || !tracker) return;
        if (typeof LightweightCharts === 'undefined' || !LightweightCharts.createChart) {
            toast('Library chart belum siap, coba refresh', true); return;
        }
        // Tandai tombol TF yang aktif.
        try {
            var tfBtns = document.querySelectorAll('#wt-entry-tf .tab-btn');
            tfBtns.forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-wt-tf') === active.tf); });
        } catch (_) {}
        // Bersihkan chart & poller lama sebelum rebuild (ganti TF tidak menumpuk).
        disposeEntryChart();
        var loadId = ++state.entryChart.loadSeq;
        var coin = active.coin, pair = active.pair, entryPx = active.entryPx,
            side = active.side, pnlInfo = active.pnlInfo, tf = active.tf;
        wrap.classList.remove('is-hidden');
        box.innerHTML = '<div class="wt-loading">Memuat chart ' + esc(coin) + ' (' + esc(tf.toUpperCase()) + ')…</div>';
        legend.innerHTML = '';
        try {
            var candles = await tracker.fetchMiniCandles(pair, tf);
            // Kalah balapan (TF diganti cepat) atau chart sudah ditutup -> buang hasil basi.
            if (loadId !== state.entryChart.loadSeq || !state.entryChart.active) return;
            box.innerHTML = '';
            box.style.height = '260px';
            var w = box.clientWidth || 320;
            var miniChart = LightweightCharts.createChart(box, {
                width: Math.max(280, w),
                height: 260,
                layout: { background: { type: 'solid', color: '#000' }, textColor: '#a1a1aa', fontSize: 11 },
                grid: { vertLines: { color: 'rgba(39,39,42,0.2)' }, horzLines: { color: 'rgba(39,39,42,0.2)' } },
                rightPriceScale: { borderColor: '#27272a', autoScale: true },
                timeScale: { borderColor: '#27272a', timeVisible: true, rightOffset: 5 },
                // User request 2026-10-14: chart bisa digeser/zoom.
                // vertTouchDrag mati agar swipe vertikal tetap scroll halaman.
                handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
                handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
                crosshair: { mode: 1 }
            });
            var series = miniChart.addCandlestickSeries({
                upColor: '#22c55e', downColor: '#ef4444',
                borderUpColor: '#22c55e', borderDownColor: '#ef4444',
                wickUpColor: '#22c55e', wickDownColor: '#ef4444'
            });
            // Garis entry selalu masuk rentang autoscale (price line tidak dihitung
            // autoscale oleh library) — entry yang jauh tidak lagi hilang dari layar,
            // di semua timeframe.
            try {
                series.applyOptions({
                    autoscaleInfoProvider: function (base) {
                        var info = null;
                        try { info = base(); } catch (_) { return null; }
                        if (!info || !info.priceRange) return info;
                        return {
                            priceRange: {
                                minValue: Math.min(info.priceRange.minValue, entryPx),
                                maxValue: Math.max(info.priceRange.maxValue, entryPx)
                            }
                        };
                    }
                });
            } catch (_) {}
            // Normalkan timestamps ke detik (sudah dari fetchMiniCandles)
            series.setData(candles);

            var last = candles[candles.length - 1];
            var lastPrice = last ? last.close : entryPx;
            var isProfit = (side === 'LONG') ? (lastPrice >= entryPx) : (lastPrice <= entryPx);
            var color = isProfit ? '#22c55e' : '#ef4444';

            // Garis entry & mark TANPA title overlay (user request 2026-10-14):
            // judul "SHORT ETH @ ..." sebelumnya menutupi chart. Info entry/mark
            // sudah ada di legend bawah, jadi di chart cukup garis + label sumbu.
            var entryLine = series.createPriceLine({
                price: entryPx,
                color: color,
                lineWidth: 2,
                lineStyle: 0,
                axisLabelVisible: true,
                title: ''
            });
            var markLine = series.createPriceLine({
                price: lastPrice,
                color: '#fbbf24',
                lineWidth: 1,
                lineStyle: 2,
                axisLabelVisible: true,
                title: ''
            });
            state.entryChart.miniChart = miniChart;
            state.entryChart.miniSeries = series;
            state.entryChart.lines = [entryLine, markLine];
            state.entryChart.active = { coin: coin, pair: pair, entryPx: entryPx, side: side };

            var diff = side === 'LONG' ? (lastPrice - entryPx) : (entryPx - lastPrice);
            var diffPct = ((lastPrice - entryPx) / entryPx) * 100 * (side === 'LONG' ? 1 : -1);
            var statusTxt = isProfit ? 'PROFIT' : 'MINUS';
            var statusCls = isProfit ? 'wt-pos' : 'wt-neg';
            var pnlExtra = '';
            if (pnlInfo && Number.isFinite(pnlInfo.uPnl)) {
                pnlExtra = ' · Wallet uPnL <span class="' + pnlClass(pnlInfo.uPnl) + '">' +
                    tracker.fmtUsd(pnlInfo.uPnl) + ' (' + tracker.fmtPct(pnlInfo.roe) + ')</span>' +
                    ' · Lev ' + (pnlInfo.leverage || '-') + 'x · Size ' + tracker.fmtUsd(pnlInfo.notional);
            }
            legend.innerHTML = '<div class="wt-entry-legend-row">' +
                '<span class="' + statusCls + '"><strong>' + esc(coin) + ' ' + esc(side) + '</strong> · ' + esc(statusTxt) + '</span>' +
                '<span>Entry ' + Number(entryPx).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' → <span id="wt-entry-mark">Mark ' +
                Number(lastPrice).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' (' + (diffPct >= 0 ? '+' : '') + diffPct.toFixed(2) + '%)</span></span>' +
                '<button class="tab-btn wt-goto-main-chart" type="button">🔍 Buka di Chart Utama</button>' +
                '</div><div class="wt-sub">' + pnlExtra + '</div>';
            legend.querySelector('.wt-goto-main-chart').addEventListener('click', function () {
                jumpToMainChart(pair);
            });

            setTimeout(function () {
                try {
                    miniChart.timeScale().fitContent();
                    miniChart.applyOptions({});
                } catch (_) {}
            }, 50);

            // Realtime: refresh candle terakhir tiap 30 detik (user request 2026-10-14).
            // series.update() tidak me-reset posisi scroll user.
            if (state.entryChart.poller) { try { clearInterval(state.entryChart.poller); } catch (_) {} }
            state.entryChart.poller = setInterval(function () {
                (async function () {
                    try {
                        var cur = state.entryChart;
                        if (!cur.miniSeries || !cur.active || cur.active.pair !== pair) return;
                        // Baca tf dari active agar poller ikut TF yang sedang dipilih.
                        var fresh = await tracker.fetchMiniCandles(pair, cur.active.tf);
                        if (!fresh || !fresh.length) return;
                        var latest = fresh[fresh.length - 1];
                        cur.miniSeries.update(latest);
                        // Geser garis mark ke harga terbaru
                        if (cur.lines && cur.lines[1]) {
                            try { cur.lines[1].applyOptions({ price: latest.close }); } catch (_) {}
                        }
                        // Update teks mark di legend
                        var markEl = $('wt-entry-mark');
                        if (markEl) {
                            var pct = ((latest.close - cur.active.entryPx) / cur.active.entryPx) * 100 * (cur.active.side === 'LONG' ? 1 : -1);
                            markEl.textContent = 'Mark ' + Number(latest.close).toLocaleString('en-US', { maximumFractionDigits: 4 }) +
                                ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
                        }
                    } catch (_) { /* abaikan, coba lagi interval berikut */ }
                })();
            }, 30000);
        } catch (e) {
            box.innerHTML = '<div class="wt-error">Gagal memuat chart: ' + esc(e.message || e) + '</div>';
        }
    }

    function jumpToMainChart(pair) {
        try {
            if (typeof switchChartPair === 'function') switchChartPair(pair);
            var chartEl = document.getElementById('main-chart');
            if (chartEl && chartEl.scrollIntoView) chartEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            toast('Chart utama dialihkan ke ' + pair, false, 2500);
        } catch (e) { toast('Gagal pindah chart: ' + e.message, true); }
    }

    /* ---------------- pencarian manual ---------------- */
    function wireSearch() {
        var go = $('wt-addr-go'), input = $('wt-addr-input');
        if (!go || !input) return;
        var run = function () {
            var v = input.value.trim();
            if (!wt().isValidAddress(v)) { toast('Format alamat harus 0x… (40 hex)', true); return; }
            pushWalletHistory(v);
            showDetail(v);
        };
        go.addEventListener('click', run);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
        renderWalletHistory();
    }

    /* ---------------- riwayat pencarian wallet (localStorage) ---------------- */
    var WT_HIST_KEY = 'wt_wallet_history_v1';
    var WT_HIST_MAX = 20;

    function loadWalletHistory() {
        try {
            var raw = localStorage.getItem(WT_HIST_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.filter(function (h) {
                return h && /^0x[0-9a-fA-F]{40}$/.test(h.address);
            }) : [];
        } catch (_) { return []; }
    }
    function persistWalletHistory(list) {
        try { localStorage.setItem(WT_HIST_KEY, JSON.stringify(list.slice(0, WT_HIST_MAX))); } catch (_) {}
    }
    // Wallet yang dicari masuk riwayat (paling atas, tanpa duplikat, nama lama dipertahankan).
    function pushWalletHistory(address) {
        var addr = String(address || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(addr)) return;
        var oldLabel = findWalletHistoryLabel(addr);
        var list = loadWalletHistory().filter(function (h) { return String(h.address).toLowerCase() !== addr; });
        list.unshift({ address: addr, label: oldLabel, ts: Date.now() });
        persistWalletHistory(list);
        renderWalletHistory();
    }
    function setWalletHistoryLabel(address, label) {
        var addr = String(address || '').toLowerCase();
        var list = loadWalletHistory();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].address).toLowerCase() === addr) { list[i].label = String(label || '').slice(0, 40); break; }
        }
        persistWalletHistory(list);
        renderWalletHistory();
    }
    function removeWalletHistory(address) {
        var addr = String(address || '').toLowerCase();
        persistWalletHistory(loadWalletHistory().filter(function (h) { return String(h.address).toLowerCase() !== addr; }));
        renderWalletHistory();
    }
    function findWalletHistoryLabel(address) {
        var addr = String(address || '').toLowerCase();
        var list = loadWalletHistory();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].address).toLowerCase() === addr) return list[i].label || '';
        }
        return '';
    }
    function renderWalletHistory() {
        var box = $('wt-search-history');
        if (!box) return;
        var tracker = wt();
        var list = loadWalletHistory();
        if (!list.length) { box.innerHTML = ''; return; }
        var shortOf = function (addr) {
            try { return tracker ? tracker.shortAddr(addr) : (addr.slice(0, 6) + '…' + addr.slice(-4)); }
            catch (_) { return addr.slice(0, 10) + '…'; }
        };
        var html = '<div class="micro-label u-mb-6">RIWAYAT PENCARIAN</div><div class="wt-hist-list">';
        list.forEach(function (h) {
            var addr = String(h.address);
            var short = shortOf(addr);
            html += '<div class="wt-hist-row" data-addr="' + esc(addr) + '">' +
                '<button class="wt-hist-open" type="button" title="Cari ulang wallet ini">' +
                '<span class="wt-hist-name">' + esc(h.label || short) + '</span>' +
                (h.label ? '<span class="wt-sub wt-hist-addr">' + esc(short) + '</span>' : '') +
                '</button>' +
                '<button class="tab-btn wt-hist-rename" type="button" title="Beri nama penanda">✏️</button>' +
                '<button class="tab-btn wt-hist-del" type="button" title="Hapus dari riwayat">🗑️</button>' +
                '</div>';
        });
        html += '</div>';
        box.innerHTML = html;
        // Klik baris -> cari ulang (naik ke paling atas riwayat).
        box.querySelectorAll('.wt-hist-open').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var row = btn.closest('.wt-hist-row');
                var addr = row ? row.getAttribute('data-addr') : '';
                if (!addr) return;
                var input = $('wt-addr-input');
                if (input) input.value = addr;
                pushWalletHistory(addr);
                showDetail(addr);
            });
        });
        // Hapus dari riwayat.
        box.querySelectorAll('.wt-hist-del').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var row = btn.closest('.wt-hist-row');
                if (row) removeWalletHistory(row.getAttribute('data-addr'));
            });
        });
        // Ganti nama inline (Enter simpan, Esc batal).
        box.querySelectorAll('.wt-hist-rename').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var row = btn.closest('.wt-hist-row');
                if (!row || row.querySelector('.wt-hist-input')) return;
                var addr = row.getAttribute('data-addr');
                var nameEl = row.querySelector('.wt-hist-name');
                if (!nameEl) return;
                var inp = document.createElement('input');
                inp.type = 'text';
                inp.className = 'input-text wt-hist-input';
                inp.value = findWalletHistoryLabel(addr);
                inp.placeholder = 'Nama penanda… (mis. Wintermute 2)';
                inp.maxLength = 40;
                inp.setAttribute('aria-label', 'Nama penanda wallet');
                nameEl.replaceWith(inp);
                inp.focus();
                inp.select();
                var done = false;
                var commit = function (save) {
                    if (done) return; done = true;
                    if (save) setWalletHistoryLabel(addr, inp.value.trim());
                    else renderWalletHistory();
                };
                inp.addEventListener('keydown', function (ev) {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') commit(true);
                    else if (ev.key === 'Escape') commit(false);
                });
                inp.addEventListener('blur', function () { commit(true); });
            });
        });
    }

    /* ---------------- copy modal ---------------- */
    function openCopyModal(address) {
        var tracker = wt(), copier = ct();
        if (!tracker || !copier) { toast('Engine copy belum siap', true); return; }
        if (!tracker.isValidAddress(address)) { toast('Alamat wallet tidak valid', true); return; }
        var existing = copier.get(address);
        if (existing) { toast('Wallet ini sudah aktif dicopy', false); showTab('copy'); return; }
        var m = $('wt-copy-modal');
        if (!m) { toast('Modal copy tidak tersedia', true); return; }
        m.classList.remove('is-hidden');
        m.classList.add('active'); // .modal-overlay butuh .active agar display:flex (bukan cuma hapus is-hidden)
        $('wt-copy-addr').textContent = tracker.shortAddr(address) + ' (' + address.slice(0, 10) + '…)';
        m.setAttribute('data-addr', address.toLowerCase());
        // reset input ke default yang ramah
        $('wt-set-margin').value = 50;
        $('wt-set-lev').value = 10;
        $('wt-set-marginmode').value = 'ISOLATED';
        $('wt-set-maxpos').value = 3;
        $('wt-set-mineq').value = 0;
        $('wt-set-blacklist').value = '';
        $('wt-set-existing').checked = false;
        $('wt-set-onlynew').checked = true;
    }
    function closeCopyModal() {
        var m = $('wt-copy-modal');
        if (m) { m.classList.add('is-hidden'); m.classList.remove('active'); }
    }

    async function submitCopyModal() {
        var copier = ct(), tracker = wt();
        var m = $('wt-copy-modal');
        var address = m.getAttribute('data-addr');
        function num(id, def) {
            var v = parseFloat($(id).value);
            return Number.isFinite(v) ? v : def;
        }
        var margin = num('wt-set-margin', 50);
        var leverage = num('wt-set-lev', 10);
        var marginMode = ($('wt-set-marginmode') && $('wt-set-marginmode').value === 'CROSS') ? 'CROSS' : 'ISOLATED';
        if (!(margin > 0)) { toast('Margin per posisi harus > 0', true); return; }
        if (!(leverage >= 1 && leverage <= 125)) { toast('Leverage antara 1-125', true); return; }
        var settings = {
            copyRatio: 1,
            fixedMargin: margin,
            fixedLeverage: Math.round(leverage),
            marginMode: marginMode,
            leverageCap: Math.round(leverage),
            maxPositions: Math.round(num('wt-set-maxpos', 3)),
            pollMs: 20000,
            copyExisting: $('wt-set-existing').checked,
            onlyNew: $('wt-set-onlynew').checked,
            minMargin: 5,
            maxMargin: Math.max(margin, 1000),
            blacklist: $('wt-set-blacklist').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
            minTargetEquity: num('wt-set-mineq', 0),
            defaultLeverage: Math.round(leverage),
            enabled: true
        };
        var btn = $('wt-copy-start');
        btn.disabled = true;
        btn.textContent = 'Memulai…';
        try {
            await copier.start(address, settings);
            toast('✅ Copy trade AKTIF! Margin $' + margin + '/posisi, Lev ' + leverage + 'x, ' + marginMode, false, 4000);
            closeCopyModal();
            showTab('copy');
            if (typeof updateLedgerUI === 'function') updateLedgerUI();
        } catch (e) {
            toast('Gagal mulai copy: ' + (e.message || e), true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Mulai Copy ke Demo';
        }
    }

    /* ---------------- tab copy saya ---------------- */
    function renderCopyList() {
        var copier = ct(), tracker = wt(), engine = fe();
        var box = $('wt-copy-list');
        if (!box || !copier || !tracker) return;
        var sessions = copier.list();
        $('wt-copy-count').textContent = sessions.length ? '(' + sessions.length + ')' : '';
        if (!sessions.length) {
            box.innerHTML = '<div class="wt-empty">Belum ada wallet yang dicopy.<br>Pilih wallet dari tab Rekomendasi/Leaderboard lalu tekan <strong>Copy</strong>.</div>';
            return;
        }
        var isAuthed = false;
        try { isAuthed = !!(window.MasakoAuth && window.MasakoAuth.isAuthenticated); } catch (_) {}
        var html = '<div class="wt-copy-banner ' + (isAuthed ? 'wt-copy-banner-sync' : 'wt-copy-banner-warn') + '">';
        if (isAuthed) {
            html += '🔄 <strong>Sinkron server aktif.</strong> Session tersimpan di akun dan dipoll server tiap ±1 menit, ' +
                'jadi copy tetap jalan walau tab ini ditutup. Saat tab terbuka, polling lokal tiap 20 detik yang dominan (lebih real-time).';
        } else {
            html += '⚠️ <strong>Kamu belum login.</strong> Copy trade akan berjalan saat tab ini terbuka saja. ';
            html += '<a href="#" id="wt-login-hint" class="wt-login-link">Login</a> untuk menyimpan session ke server.';
        }
        html += '<div class="wt-sub u-mt-6">Tip: biarkan tab ini terbuka (bisa di-minimize) selama kamu ingin copy aktif. Browser akan menampilkan peringatan jika kamu tidak sengaja mau menutup tab.</div>';
        html += '</div>';
        sessions.forEach(function (s) {
            var enabled = s.settings.enabled !== false;
            var margin = Number(s.settings.fixedMargin) || 0;
            var lev = Number(s.settings.fixedLeverage) || Number(s.settings.defaultLeverage) || Number(s.settings.leverageCap);
            html += '<div class="wt-copy-card">';
            html += '<div class="row-between"><div><strong>' + esc(tracker.shortAddr(s.address)) + '</strong>' +
                '<button class="tab-btn wt-addr-btn wt-copy-addr" data-addr="' + esc(s.address) + '" type="button" title="Salin alamat wallet lengkap">📋</button>' +
                '<button class="tab-btn wt-addr-btn wt-copy-detail" data-addr="' + esc(s.address) + '" type="button" title="Lihat detail wallet">Detail</button></div>' +
                '<span class="wt-copy-status ' + (enabled ? 'wt-status-on' : 'wt-status-off') + '">' +
                (enabled ? '🟢 COPY AKTIF' : '🔴 PAUSED') + '</span></div>';
            html += '<div class="wt-sub">Eq target ' + esc(tracker.fmtUsd(s.targetEquity)) +
                ' · margin/posisi $' + esc(margin.toFixed(2)) +
                ' · lev ' + esc(lev) + 'x' +
                ' · max ' + esc(s.settings.maxPositions) + ' posisi' +
                ' · buka ' + s.stats.opened + ' / tutup ' + s.stats.closed + '</div>';
            html += '<div class="wt-copy-controls">' +
                '<label class="wt-toggle"><input type="checkbox" class="wt-copy-toggle" data-addr="' + esc(s.address) + '"' + (enabled ? ' checked' : '') + '> Copy Aktif</label>' +
                '<button class="tab-btn wt-stop" data-addr="' + esc(s.address) + '" type="button">⛔ Berhenti</button>' +
                '</div>';
            html += '<div class="micro-label u-mb-6">POSISI COPY AKTIF (' + s.copied.length + ')</div>';
            if (!s.copied.length) {
                html += '<div class="wt-empty">Menunggu sinyal dari wallet…</div>';
            } else {
                s.copied.forEach(function (c) {
                    var live = '';
                    var paused = c.paused ? ' <span class="wt-status-off">(JEDA)</span>' : '';
                    if (engine && engine.state && engine.state.positions) {
                        var p = engine.state.positions.find(function (x) { return x && x.id === c.demoId; });
                        if (p && typeof engine.getPositionPnl === 'function') {
                            var pnl = engine.getPositionPnl(p).totalPnl;
                            live = ' · <span class="' + pnlClass(pnl) + '">' + esc(tracker.fmtUsd(pnl)) + '</span> live';
                        } else if (!p) {
                            live = ' · <span class="wt-neg">posisi demo hilang/ditutup</span>';
                        }
                    }
                    // Waktu buka wallet target (jam:menit:detik) + keterlambatan mirror saya.
                    var timing = '';
                    var tOpen = Number(c.targetOpenTime);
                    if (tOpen > 0) {
                        timing = '<div class="wt-fill-time">🎯 Target buka ' + esc(fmtClock(tOpen)) +
                            ' · ' + esc(fmtCopyLag(c.openedAt, tOpen)) + '</div>';
                    }
                    html += '<div class="wt-fill-block"><div class="wt-fill"><span><strong>' + esc(c.coin) + '</strong> ' + esc(c.dir) + paused + '</span>' +
                        '<span title="Open: ' + esc(tracker.fmtTime(c.openedAt)) + '">' + esc(tracker.fmtAgo(c.openedAt)) + live + '</span></div>' +
                        timing + '</div>';
                });
            }
            html += '</div>';
        });
        box.innerHTML = html;
        box.querySelectorAll('.wt-stop').forEach(function (b) {
            b.addEventListener('click', async function () {
                var addr = b.getAttribute('data-addr');
                await copier.stop(addr);
                toast('Copy dihentikan untuk ' + tracker.shortAddr(addr));
                renderCopyList();
                if (typeof updateLedgerUI === 'function') updateLedgerUI();
            });
        });
        box.querySelectorAll('.wt-copy-toggle').forEach(function (cb) {
            cb.addEventListener('change', function () {
                var addr = cb.getAttribute('data-addr');
                copier.setEnabled(addr, cb.checked);
                toast(cb.checked ? 'Copy dilanjutkan' : 'Copy dijeda');
                renderCopyList();
                if (typeof updateLedgerUI === 'function') updateLedgerUI();
            });
        });
        box.querySelectorAll('.wt-copy-addr').forEach(function (b) {
            b.addEventListener('click', function () {
                var addr = b.getAttribute('data-addr') || '';
                if (!addr) { toast('Alamat belum tersedia', true); return; }
                copyTextToClipboard(addr,
                    function () { toast('📋 Alamat wallet disalin', false, 2000); },
                    function () { toast('Gagal menyalin alamat', true); });
            });
        });
        box.querySelectorAll('.wt-copy-detail').forEach(function (b) {
            b.addEventListener('click', function () {
                var addr = b.getAttribute('data-addr') || '';
                if (!addr) { toast('Alamat belum tersedia', true); return; }
                showDetail(addr);
            });
        });
        // This link is rendered inside box.innerHTML above, so scope the lookup
        // to this generated subtree instead of treating it as a static page ID.
        var loginHint = box.querySelector ? box.querySelector('.wt-login-link') : null;
        if (loginHint && loginHint.addEventListener) {
            loginHint.addEventListener('click', function (ev) {
                ev.preventDefault();
                try {
                    var btn = document.getElementById('btn-login-trigger');
                    if (btn) btn.click();
                } catch (_) {}
            });
        }
    }

    /* ---------------- leaderboard filters UI ---------------- */
    function buildLeaderboardFilters() {
        var bar = $('wt-lb-filters');
        if (!bar) return;
        var html = '<div class="wt-filter-row">' +
            '<label class="wt-filter-label">Urut:</label>' +
            '<select class="wt-select" id="wt-lb-sort">' +
            '<option value="score">Skor AI</option>' +
            '<option value="pnl">PnL $</option>' +
            '<option value="roi">ROI %</option>' +
            '<option value="equity">Equity</option>' +
            '</select>' +
            '<label class="wt-filter-label">Eq $:</label>' +
            '<select class="wt-select" id="wt-lb-mineq">' +
            '<option value="1000">$1K+</option>' +
            '<option value="10000" selected>$10K+</option>' +
            '<option value="50000">$50K+</option>' +
            '<option value="100000">$100K+</option>' +
            '<option value="500000">$500K+</option>' +
            '<option value="1000000">$1M+</option>' +
            '<option value="1000000-15000000">$1M–$15M</option>' +
            '<option value="15000000-30000000">$15M–$30M</option>' +
            '<option value="30000000-50000000">$30M–$50M</option>' +
            '<option value="50000000-100000000">$50M–$100M</option>' +
            '</select>' +
            '<button class="btn btn-secondary wt-lb-refresh" id="wt-lb-refresh" type="button">🔄 Refresh</button>' +
            '</div>';
        bar.innerHTML = html;
        var sortSel = $('wt-lb-sort'), minEqSel = $('wt-lb-mineq'), refreshBtn = $('wt-lb-refresh');
        if (sortSel) { sortSel.value = state.lb.sortBy; if (sortSel.addEventListener) sortSel.addEventListener('change', function () { state.lb.sortBy = this.value; loadLeaderboard(); }); }
        // Nilai select: "min" untuk batas bawah saja, "min-max" untuk bucket whale.
        if (minEqSel) {
            minEqSel.value = state.lb.maxEquity > 0
                ? (state.lb.minEquity + '-' + state.lb.maxEquity)
                : String(state.lb.minEquity);
            if (minEqSel.addEventListener) minEqSel.addEventListener('change', function () {
                var parts = String(this.value || '').split('-');
                state.lb.minEquity = Number(parts[0]) || 10000;
                state.lb.maxEquity = parts.length > 1 ? (Number(parts[1]) || 0) : 0;
                loadLeaderboard();
            });
        }
        if (refreshBtn && refreshBtn.addEventListener) refreshBtn.addEventListener('click', function () { state.lb.loading = false; var t = wt(); if (t && t.clearCache) t.clearCache(); loadLeaderboard(); });
    }

    /* ---------------- init ---------------- */
    function bindWinBar(bar, onClick) {
        if (!bar) return;
        var html = '';
        WIN_BTNS.forEach(function (pair) {
            html += '<button class="tab-btn' + (pair[0] === state.win ? ' active' : '') +
                '" data-wt-win="' + pair[0] + '" type="button">' + pair[1] + '</button>';
        });
        bar.innerHTML = html;
        var btns = bar.querySelectorAll ? bar.querySelectorAll('[data-wt-win]') : [];
        if (!btns || !btns.forEach) btns = [];
        btns.forEach(function (b) {
            if (!b || !b.addEventListener) return;
            b.addEventListener('click', function () {
                state.win = b.getAttribute('data-wt-win');
                var all = bar.querySelectorAll ? bar.querySelectorAll('[data-wt-win]') : [];
                all.forEach && all.forEach(function (x) {
                    if (x && x.classList) x.classList.toggle('active', x === b);
                });
                if (typeof onClick === 'function') onClick();
            });
        });
    }

    function buildWindowTabs() {
        bindWinBar($('wt-windows'), function () {
            // sync win state ke bar leaderboard
            syncLeaderboardWinBar();
            if (state.tab === 'reco') loadReco();
            if (state.tab === 'leaderboard') loadLeaderboard();
        });
        bindWinBar($('wt-lb-windows'), function () {
            syncRecoWinBar();
            loadLeaderboard();
        });
    }

    function syncLeaderboardWinBar() {
        var lbBar = $('wt-lb-windows');
        if (!lbBar || !lbBar.querySelectorAll) return;
        var all = lbBar.querySelectorAll('[data-wt-win]');
        all.forEach && all.forEach(function (x) {
            if (x && x.classList) x.classList.toggle('active', x.getAttribute && x.getAttribute('data-wt-win') === state.win);
        });
    }
    function syncRecoWinBar() {
        var bar = $('wt-windows');
        if (!bar || !bar.querySelectorAll) return;
        var all = bar.querySelectorAll('[data-wt-win]');
        all.forEach && all.forEach(function (x) {
            if (x && x.classList) x.classList.toggle('active', x.getAttribute && x.getAttribute('data-wt-win') === state.win);
        });
    }

    function init() {
        if ($('wt-tabs') && $('wt-tabs').dataset.wtInit) return;
        if (!$('wt-tabs')) return;
        $('wt-tabs').dataset.wtInit = '1';

        document.querySelectorAll('#wt-tabs .tab-btn').forEach(function (b) {
            b.addEventListener('click', function () { showTab(b.getAttribute('data-wt-tab')); });
        });
        buildWindowTabs();
        buildLeaderboardFilters();
        wireSearch();

        var m = $('wt-copy-modal');
        if (m) {
            var cancelBtn = $('wt-copy-cancel'), startBtn = $('wt-copy-start');
            if (cancelBtn && cancelBtn.addEventListener) cancelBtn.addEventListener('click', closeCopyModal);
            if (startBtn && startBtn.addEventListener) startBtn.addEventListener('click', submitCopyModal);
            // Tombol salin alamat + detail di sebelah alamat wallet pada modal copy
            var addrCopyBtn = $('wt-copy-addr-copy');
            if (addrCopyBtn && addrCopyBtn.addEventListener) addrCopyBtn.addEventListener('click', function () {
                var addr = m.getAttribute('data-addr') || '';
                if (!addr) { toast('Alamat belum tersedia', true); return; }
                copyTextToClipboard(addr,
                    function () { toast('📋 Alamat wallet disalin', false, 2000); },
                    function () { toast('Gagal menyalin alamat', true); });
            });
            var addrDetailBtn = $('wt-copy-addr-detail');
            if (addrDetailBtn && addrDetailBtn.addEventListener) addrDetailBtn.addEventListener('click', function () {
                var addr = m.getAttribute('data-addr') || '';
                if (!addr) { toast('Alamat belum tersedia', true); return; }
                closeCopyModal();
                showDetail(addr);
            });
            var closeInModal = m.querySelector ? m.querySelector('.close-btn') : null;
            if (closeInModal && closeInModal.addEventListener) closeInModal.addEventListener('click', closeCopyModal);
            if (m.addEventListener) m.addEventListener('click', function (e) { if (e && e.target === m) closeCopyModal(); });
            var onlyNew = $('wt-set-onlynew'), existing = $('wt-set-existing');
            if (onlyNew && onlyNew.addEventListener) onlyNew.addEventListener('change', function (e) {
                if (e.target && e.target.checked && existing) existing.checked = false;
            });
            if (existing && existing.addEventListener) existing.addEventListener('change', function (e) {
                if (e.target && e.target.checked && onlyNew) onlyNew.checked = false;
            });
        }

        try { if (ct() && typeof ct().restore === 'function') ct().restore(); } catch (_) {}

        loadReco();
        setInterval(function () {
            if (state.tab === 'reco' && !state.detailAddr) loadReco();
            if (state.tab === 'copy') renderCopyList();
        }, 60000);
    }

    var WalletTrackerUI = {
        init: init,
        showTab: showTab,
        showDetail: showDetail,
        renderCopyList: renderCopyList,
        _esc: esc
    };
    window.WalletTrackerUI = WalletTrackerUI;

    // Expose hook supaya main.js (ledger) bisa badge "Copy Trade Aktif"
    window.WTCopyInfo = {
        isCopyAddress: function (addr) {
            var c = ct();
            return !!(c && c.get && c.get(addr));
        },
        isCopyPosition: function (pos) {
            return !!(pos && pos.origin === 'COPY_TRADE' && pos.copyMeta);
        },
        toggleSession: function (addr, enabled) {
            var c = ct();
            if (c && c.setEnabled) c.setEnabled(addr, enabled);
        },
        togglePosition: function (posId, paused) {
            // pos-level pause: mark pos.copyMeta.paused; poll mengabaikannya?
            // Sederhana: tutup posisi bila dipause, buka lagi saat on?
            // Untuk awal cukup toggle session-wide (wallet-wide) yang UX-nya
            // paling mudah dipahami.
        },
        sessions: function () { var c = ct(); return c && c.list ? c.list() : []; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
