/* src/data/bandarFallback.js — Fallback client-side untuk modal "Pergerakan
 * Wallet Bandar" saat backend /api tidak terjangkau (mis. GitHub Pages).
 *
 * Kenapa ada file ini (2026-11-05): mirror GitHub Pages hanya menyajikan
 * file statis — /api/bandar-wallets tidak ada sehingga modal selalu 404.
 * Fallback ini membangun snapshot dengan bentuk data YANG SAMA seperti
 * respons /api/bandar-wallets, langsung dari sumber publik yang sama
 * dengan yang dipakai cron server:
 *   - BTC  : mempool.space (alamat + tx terakhir, tanpa API key)
 *   - HYPE : api.hyperliquid.xyz/info + rpc.hyperliquid.xyz/evm (publik)
 * Watchlist di bawah disalin dari api/_bandarWatch.js dan
 * api/_hypeWatch.js (alamat on-chain publik yang memang ditampilkan
 * modal; bukan rahasia). Bila watchlist server berubah, salinan ini
 * wajib ikut diperbarui.
 *
 * Perbedaan yang disengaja vs jalur server (jangan disamakan):
 *   - Riwayat alert TIDAK tersedia (alert hidup di tabel Supabase yang
 *     hanya bisa dibaca service key server) — alerts: [] + storageNote
 *     menjelaskan mode fallback.
 *   - Gagal per wallet = baris bernilai null, bukan gagal total (server
 *     fail-closed karena menulis state; tampilan baca boleh parsial).
 *   - Notifikasi email/Telegram dilaporkan belum diset: notifikasi hanya
 *     dikirim cron server yang sedang tidak jalan.
 */
(function () {
    'use strict';

    var MEMPOOL_API = 'https://mempool.space/api';
    var HL_INFO = 'https://api.hyperliquid.xyz/info';
    var HYPE_RPC = 'https://rpc.hyperliquid.xyz/evm';
    var FETCH_TIMEOUT_MS = 15000;

    var BANDAR_WALLETS = [
        { address: '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo', label: 'Binance cold #1', kind: 'exchange-cold' },
        { address: '3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6', label: 'Binance cold #2', kind: 'exchange-cold' },
        { address: '1Pzaqw98PeRfyHypfqyEgg5yycJRsENrE7', label: 'Binance cold baru', kind: 'exchange-cold' },
        { address: '1PJiGp2yDLvUgqeBsuZVCBADArNsk6XEiw', label: 'Binance cold', kind: 'exchange-cold' },
        { address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', label: 'Binance hot wallet', kind: 'exchange-hot' },
        { address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97', label: 'Bitfinex cold baru', kind: 'exchange-cold' },
        { address: '3D2oetdNuZUqQHPJmcMDDHYoqkyNVsFk9r', label: 'Bitfinex cold lama', kind: 'exchange-cold' },
        { address: '1Kr6QSydW9bFQG1mXiPNNu6WpJGmUa9i1g', label: 'Bitfinex hot', kind: 'exchange-hot' },
        { address: 'bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2', label: 'Robinhood cold', kind: 'exchange-cold' },
        { address: '3MgEAFWu1HKSnZ5ZsC8qf61ZW18xrP5pgd', label: 'OKEx', kind: 'exchange-cold' },
        { address: 'bc1qjasf9z3h7w3jspkhtgatgpyvvzgpa2wwd2lr0eh5tx44reyn2k7sfc27a4', label: 'Tether treasury', kind: 'treasury' },
        { address: '1Ay8vMC7R1UbyCCZRVULMV7iQpHSAbguJP', label: 'Mr.100 (akumulator)', kind: 'whale' },
        { address: '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF', label: 'MtGox hack 2011', kind: 'hack' },
        { address: '33TDwJRsFJbtSEwkXGwtJkj3Ey3Gman3TV', label: 'Pantauan #1 (dari Binance cold #2)', kind: 'watch' },
        { address: '32z4XkTCBMp4QfcoobxaXtJkWngyHqGjHp', label: 'Pantauan #2 (dari Binance cold #2)', kind: 'watch' },
        { address: '3J6tf7fg3B5aWLCwnDqAFFmS72SssK5yeH', label: 'Pantauan #3 (dari Binance cold #2)', kind: 'watch' },
        { address: '3HhbSpPhKsw4t7ond5Mv9oVZBtpQKFu5cx', label: 'Pantauan #4 (dari Binance cold #2)', kind: 'watch' },
        { address: '34yeXcv1tQSQxwNRQXfS5qvFGSKDvk7Yiu', label: 'Pantauan #5 (dari Binance cold #2)', kind: 'watch' },
        { address: 'bc1qt26w24cp6d6kt75kxwejktv9dqftlqva6w8zjp', label: 'Galaxy Digital (on-chain)', kind: 'institusi' }
    ];

    var HYPE_WALLETS = [
        { address: '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00', label: 'Wintermute', kind: 'market-maker', track: ['spot', 'perps'], intel: 'Market maker. Book perps ~$60 jt; short HYPE -62,4 rb @ $91,16 (terverifikasi on-chain 7 Okt 2026). Quoting HYPE $9,7 jt notional.' },
        { address: '0xcac19662ec88d23fa1c81ac0e8570b0cf2ff26b3', label: 'Galaxy Digital', kind: 'institusi', track: ['spot', 'perps'], intel: 'Desk institusional. Short HYPE -9.978 @ $91,74 (terverifikasi on-chain 7 Okt 2026) — posisi bearish terarah.' },
        { address: '0xf58b673c1633ccef0ac58263cdc95ed80f817fc7', label: 'A1', kind: 'whale-trader', track: ['perps'], intel: 'Wallet pengganti (2 Nov 2026). BTC SHORT -83,27 40x (uPnL +$275 rb), ETH LONG 6,65 20x; akun ~$895 rb. Tervalidasi 2 Nov 2026.' },
        { address: '0x24fb52e17e3d4fd62a119b8f53c1a3f3bfe65c2f', label: 'A2', kind: 'whale-trader', track: ['perps'], intel: 'Wallet pengganti (2 Nov 2026). Semua SHORT: ETH -522,7 20x, UNI -68.886 7x, NEAR -110.689 7x; akun ~$286 rb. Tervalidasi 2 Nov 2026.' },
        { address: '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', label: 'A3', kind: 'whale-trader', track: ['perps'], intel: 'Wallet baru (3 Nov 2026). Akun ~$104 jt, total notional ~$443 jt; 100% SHORT ~30 koin — BTC -$149,7 jt, ETH -$83,5 jt, HYPE -$62,8 jt, ZEC -$61,1 jt. Tervalidasi 3 Nov 2026.' },
        { address: '0xd1dd6d99c5fb5d31ff52eacce5046c7158859e85', label: 'A4', kind: 'whale-trader', track: ['perps'], intel: 'Wallet baru (3 Nov 2026). Akun ~$1,78 jt, total notional ~$7,7 jt; 100% SHORT 11 koin — NEAR -$2,7 jt, LIT -$1,4 jt. Tervalidasi 3 Nov 2026.' },
        { address: '0x57da5ca2b92632426bedfe81671dd0c8c3111a50', label: 'A5', kind: 'whale-trader', track: ['perps'], intel: 'Wallet baru (3 Nov 2026). Akun ~$46 rb, total notional ~$355 rb; 100% LONG 6 koin @ ~$50–100 rb (ETH $100 rb 25x). Kecil — pakai alertAll supaya terpantau; notif tetap hanya open/close/flip. Tervalidasi 3 Nov 2026.' },
        { address: '0xca4903c207a0df58bf37d4bc8bbc5210726f53c8', label: 'A6', kind: 'whale-trader', track: ['perps'], intel: 'Wallet baru (3 Nov 2026). Akun ~$14 jt, total notional ~$57,2 jt; 100% SHORT 5 koin, lev 20–40x — BTC -$20,8 jt 40x, ETH -$20,9 jt 25x, SOL -$6,8 jt 20x. Tervalidasi 3 Nov 2026.' }
    ];

    var TRACKED_PERP_COINS = ['BTC', 'ETH', 'SOL', 'STRK', 'W', 'DOGE', 'XRP', 'ENA', 'ZRO', 'ZEC', 'TRX', 'VVV', 'AAVE', 'UNI', 'PUMP', 'ASTER', 'PAXG', 'NEAR', 'XMR'];

    var KNOWN_MAP = {};
    BANDAR_WALLETS.forEach(function (w) { KNOWN_MAP[w.address] = w; });

    function num(v) {
        var n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    function round8(n) { return Math.round(n * 1e8) / 1e8; }
    function round4(n) { return Math.round(n * 1e4) / 1e4; }

    function fetchJson(url, options) {
        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
        var opts = options || {};
        opts.signal = ctrl.signal;
        return fetch(url, opts).then(function (res) {
            clearTimeout(timer);
            if (!res.ok) throw new Error('HTTP ' + res.status + ' untuk ' + url);
            return res.json();
        }).catch(function (e) {
            clearTimeout(timer);
            throw e;
        });
    }

    // Paralel terbatas (port mapLimit dari api/_job_bandarCheck.js).
    function mapLimit(items, limit, fn) {
        var idx = 0;
        var out = new Array(items.length);
        function worker() {
            if (idx >= items.length) return Promise.resolve();
            var i = idx++;
            return Promise.resolve().then(function () { return fn(items[i]); }).then(function (v) {
                out[i] = v;
            }).then(worker);
        }
        var workers = [];
        for (var k = 0; k < Math.min(limit, items.length); k++) workers.push(worker());
        return Promise.all(workers).then(function () { return out; });
    }

    /* ---- Sisi BTC (port api/_bandarWatch.js: netForTx, counterparties, classify) ---- */

    function netForTx(tx, address) {
        var vin = 0, vout = 0, i, o, p;
        var vins = tx.vin || [], vouts = tx.vout || [];
        for (i = 0; i < vins.length; i++) {
            p = vins[i].prevout || {};
            if (p.scriptpubkey_address === address) vin += num(p.value);
        }
        for (o = 0; o < vouts.length; o++) {
            if (vouts[o].scriptpubkey_address === address) vout += num(vouts[o].value);
        }
        return (vout - vin) / 1e8;
    }

    function counterparties(tx, address) {
        var ins = {}, outs = {}, i, p, a;
        var vins = tx.vin || [], vouts = tx.vout || [];
        for (i = 0; i < vins.length; i++) {
            p = vins[i].prevout || {};
            a = p.scriptpubkey_address;
            if (!a || a === address) continue;
            ins[a] = (ins[a] || 0) + num(p.value);
        }
        for (i = 0; i < vouts.length; i++) {
            a = vouts[i].scriptpubkey_address;
            if (!a || a === address) continue;
            outs[a] = (outs[a] || 0) + num(vouts[i].value);
        }
        function top(m) {
            return Object.keys(m).map(function (k) {
                return { address: k, amountBtc: m[k] / 1e8, known: KNOWN_MAP[k] || null };
            }).sort(function (x, y) { return y.amountBtc - x.amountBtc; }).slice(0, 5);
        }
        return { in: top(ins), out: top(outs) };
    }

    function isExchangeKind(kind) { return kind === 'exchange-cold' || kind === 'exchange-hot'; }
    function isInternalKind(kind) { return isExchangeKind(kind) || kind === 'treasury'; }

    function classify(net, wallet, cp) {
        var direction = net >= 0 ? 'MASUK' : 'KELUAR';
        var absNet = Math.abs(net);
        var inKnown = cp.in.filter(function (c) { return !!c.known; });
        var outKnown = cp.out.filter(function (c) { return !!c.known; });
        if (isInternalKind(wallet.kind)) {
            var inInternal = inKnown.filter(function (c) { return isInternalKind(c.known.kind); });
            var outInternal = outKnown.filter(function (c) { return isInternalKind(c.known.kind); });
            var other = direction === 'MASUK' ? inInternal[0] : outInternal[0];
            if (other) {
                return { direction: direction, signal: 'NETRAL', note: 'Transfer internal dengan ' + other.known.label + ' — bukan sinyal jual/beli pasar.' };
            }
        }
        if (direction === 'KELUAR') {
            var toExchange = null;
            for (var i = 0; i < outKnown.length; i++) {
                if (isExchangeKind(outKnown[i].known.kind)) { toExchange = outKnown[i]; break; }
            }
            if (toExchange) {
                return { direction: direction, signal: 'JUAL', note: 'Kirim ' + absNet.toLocaleString('id-ID') + ' BTC ke ' + toExchange.known.label + ' (exchange) — indikasi JUAL / potensi tekanan jual.' };
            }
            return { direction: direction, signal: 'JUAL', note: 'Keluar ' + absNet.toLocaleString('id-ID') + ' BTC dari ' + wallet.label + ' — indikasi distribusi/JUAL.' };
        }
        var fromExchange = null;
        for (var j = 0; j < inKnown.length; j++) {
            if (isExchangeKind(inKnown[j].known.kind)) { fromExchange = inKnown[j]; break; }
        }
        if (fromExchange) {
            return { direction: direction, signal: 'BELI', note: 'Tarik ' + absNet.toLocaleString('id-ID') + ' BTC dari ' + fromExchange.known.label + ' (exchange) — indikasi akumulasi/BELI.' };
        }
        return { direction: direction, signal: 'BELI', note: 'Masuk ' + absNet.toLocaleString('id-ID') + ' BTC ke ' + wallet.label + ' — indikasi akumulasi/BELI.' };
    }

    function getBtcWallet(w) {
        return Promise.all([
            fetchJson(MEMPOOL_API + '/address/' + w.address),
            fetchJson(MEMPOOL_API + '/address/' + w.address + '/txs')
        ]).then(function (parts) {
            var info = parts[0] || {};
            var txs = Array.isArray(parts[1]) ? parts[1] : [];
            var cs = info.chain_stats || {};
            var balanceBtc = round8((num(cs.funded_txo_sum) - num(cs.spent_txo_sum)) / 1e8);
            var windowIn = 0, windowOut = 0, lastMovement = null;
            var recent = txs.slice(0, 25);
            for (var i = 0; i < recent.length; i++) {
                var net = netForTx(recent[i], w.address);
                if (net > 0) windowIn += net; else windowOut += -net;
                if (!lastMovement && Math.abs(net) >= 1) {
                    var cp = counterparties(recent[i], w.address);
                    var c = classify(net, w, cp);
                    lastMovement = {
                        txid: recent[i].txid,
                        time: recent[i].status && recent[i].status.block_time
                            ? new Date(recent[i].status.block_time * 1000).toISOString() : null,
                        net: round8(net),
                        direction: c.direction,
                        signal: c.signal
                    };
                }
            }
            return {
                address: w.address, label: w.label, kind: w.kind, chain: 'BTC',
                balanceBtc: balanceBtc, txCount: num(cs.tx_count),
                windowIn: round8(windowIn), windowOut: round8(windowOut),
                lastMovement: lastMovement
            };
        }).catch(function () {
            return {
                address: w.address, label: w.label, kind: w.kind, chain: 'BTC',
                balanceBtc: null, txCount: null, windowIn: null, windowOut: null,
                lastMovement: null
            };
        });
    }

    /* ---- Sisi HYPE (port api/_hypeWatch.js: getHypePosition + perpPnlPct) ---- */

    function hlInfo(payload) {
        return fetchJson(HL_INFO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    }

    function rpcCall(method, params) {
        return fetchJson(HYPE_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params })
        }).then(function (j) { return j.result; });
    }

    function perpPnlPct(size, entry, mark) {
        if (!Number.isFinite(size) || size === 0) return null;
        if (!Number.isFinite(entry) || entry === 0) return null;
        if (!Number.isFinite(mark) || mark <= 0) return null;
        var pct = Math.sign(size) * ((mark - entry) / entry) * 100;
        return pct === 0 ? 0 : pct;
    }

    function getHypeWallet(w) {
        return Promise.all([
            hlInfo({ type: 'spotClearinghouseState', user: w.address }).catch(function () { return null; }),
            hlInfo({ type: 'delegatorSummary', user: w.address }).catch(function () { return null; }),
            hlInfo({ type: 'clearinghouseState', user: w.address }).catch(function () { return null; }),
            rpcCall('eth_getBalance', [w.address, 'latest']).catch(function () { return null; })
        ]).then(function (parts) {
            var spotState = parts[0], deleg = parts[1], perpState = parts[2], evmBal = parts[3];
            if (!spotState || !Array.isArray(spotState.balances)
                || !deleg || deleg.delegated == null
                || !perpState || !Array.isArray(perpState.assetPositions)
                || evmBal == null) {
                throw new Error('Hyperliquid upstream partial failure');
            }
            var spot = 0;
            var b = null;
            for (var i = 0; i < spotState.balances.length; i++) {
                if (spotState.balances[i].coin === 'HYPE') { b = spotState.balances[i]; break; }
            }
            if (b) spot = num(b.total);
            var staked = num(deleg.delegated);
            var evmNative = parseInt(evmBal || '0x0', 16) / 1e18;
            var perps = {};
            for (var c = 0; c < TRACKED_PERP_COINS.length; c++) perps[TRACKED_PERP_COINS[c]] = { size: 0, entry: null, mark: null };
            var perpSize = 0, perpEntry = null, perpMark = null;
            var positions = perpState.assetPositions || [];
            for (var p = 0; p < positions.length; p++) {
                var pos = positions[p].position || positions[p];
                var coin = String(pos.coin || '');
                if (coin === 'HYPE') {
                    perpSize = num(pos.szi);
                    perpEntry = pos.entryPx != null ? num(pos.entryPx) : null;
                    var pv = num(pos.positionValue);
                    if (perpSize !== 0 && pv > 0) perpMark = Math.round((pv / Math.abs(perpSize)) * 100) / 100;
                }
                if (Object.prototype.hasOwnProperty.call(perps, coin)) {
                    var sz = num(pos.szi);
                    var entry = pos.entryPx != null ? num(pos.entryPx) : null;
                    var pv2 = num(pos.positionValue);
                    var mark = (sz !== 0 && pv2 > 0) ? (pv2 / Math.abs(sz)) : null;
                    if (mark !== null && mark > 0) mark = Number(mark.toPrecision(5));
                    perps[coin] = { size: round4(sz), entry: entry, mark: mark };
                }
            }
            var row = {
                address: w.address, label: w.label, kind: w.kind, chain: 'HYPE',
                intel: w.intel,
                spot: round4(spot), staked: round4(staked), evmNative: round4(evmNative),
                total: round4(spot + staked + evmNative),
                perpSize: round4(perpSize), perpEntry: perpEntry, perpMark: perpMark,
                updatedAt: new Date().toISOString()
            };
            row.perpPnlPct = perpPnlPct(row.perpSize, row.perpEntry, row.perpMark);
            for (var k = 0; k < TRACKED_PERP_COINS.length; k++) {
                var coin = TRACKED_PERP_COINS[k];
                var key = coin.toLowerCase();
                row[key + 'PerpSize'] = perps[coin].size;
                row[key + 'PerpEntry'] = perps[coin].entry;
                row[key + 'PerpMark'] = perps[coin].mark;
                row[key + 'PerpPnlPct'] = perpPnlPct(perps[coin].size, perps[coin].entry, perps[coin].mark);
            }
            return row;
        }).catch(function () {
            var row = {
                address: w.address, label: w.label, kind: w.kind, chain: 'HYPE',
                intel: w.intel,
                spot: null, staked: null, evmNative: null, total: null,
                perpSize: null, perpEntry: null, perpMark: null,
                updatedAt: null
            };
            for (var k = 0; k < TRACKED_PERP_COINS.length; k++) {
                var key = TRACKED_PERP_COINS[k].toLowerCase();
                row[key + 'PerpSize'] = null;
                row[key + 'PerpEntry'] = null;
                row[key + 'PerpMark'] = null;
                row[key + 'PerpPnlPct'] = null;
            }
            row.perpPnlPct = null;
            return row;
        });
    }

    /* ---- Snapshot gabungan (bentuk sama dengan /api/bandar-wallets) ---- */

    function buildSnapshot() {
        return Promise.all([
            mapLimit(BANDAR_WALLETS, 5, getBtcWallet),
            mapLimit(HYPE_WALLETS, 4, getHypeWallet)
        ]).then(function (parts) {
            var wallets = parts[0], hypeWallets = parts[1];
            var totalBtc = 0, totalHype = 0, failed = 0;
            wallets.forEach(function (w) {
                if (w.balanceBtc == null) failed++;
                else totalBtc += w.balanceBtc;
            });
            hypeWallets.forEach(function (w) {
                if (w.total == null) failed++;
                else totalHype += w.total;
            });
            var note = 'Mode fallback: data live langsung dari mempool.space + Hyperliquid '
                + '(backend /api tidak terjangkau — riwayat alert & notifikasi cron tidak tersedia selama Vercel pause).';
            if (failed > 0) note += ' (' + failed + ' wallet gagal dimuat, nilainya tampil —.)';
            return {
                updatedAt: new Date().toISOString(),
                stale: false,
                thresholdBtc: 1000,
                hypeThresholdHype: 10000,
                emailConfigured: false,
                telegramConfigured: false,
                totalBtc: round8(totalBtc),
                totalHype: round4(totalHype),
                wallets: wallets,
                hypeWallets: hypeWallets,
                alerts: [],
                storageNote: note,
                watchCount: BANDAR_WALLETS.length,
                hypeWatchCount: HYPE_WALLETS.length,
                fallback: true
            };
        });
    }

    var BandarFallback = {
        buildSnapshot: buildSnapshot,
        BANDAR_WALLETS: BANDAR_WALLETS,
        HYPE_WALLETS: HYPE_WALLETS,
        TRACKED_PERP_COINS: TRACKED_PERP_COINS,
        _test: {
            netForTx: netForTx,
            counterparties: counterparties,
            classify: classify,
            perpPnlPct: perpPnlPct
        }
    };

    if (typeof window !== 'undefined') window.BandarFallback = BandarFallback;
    if (typeof module !== 'undefined' && module.exports) module.exports = BandarFallback;
})();
