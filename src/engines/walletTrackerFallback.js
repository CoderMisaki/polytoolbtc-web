/* src/engines/walletTrackerFallback.js — Fallback client-side untuk fitur
 * Wallet Tracker (Smart Money) saat backend /api tidak terjangkau
 * (mis. GitHub Pages, tempat /api/hl-wallet tidak ada sehingga semua tab
 * tracker 404).
 *
 * Kenapa ada file ini (2026-11-05): modul ini mem-port logika
 * api/hl-wallet.js ke browser — request yang sama langsung ke upstream
 * publik yang sama (api.hyperliquid.xyz/info + stats-data.hyperliquid.xyz
 * yang CORS-nya terbuka `Access-Control-Allow-Origin: *`), dengan bentuk
 * output yang SAMA sehingga UI tracker tidak perlu diubah. Dipakai HANYA
 * bila fetch /api gagal (lihat patch fetchJson di walletTracker.js);
 * di Vercel jalur ini tidak pernah tersentuh.
 *
 * Perbedaan yang disengaja vs jalur server:
 *   - Tanpa cache server & tanpa rate-limit terpusat: tiap pengunjung
 *     memakai kuota Hyperliquid per IP-nya sendiri (1200 weight/menit).
 *     Karena itu enrichment leaderboard di-batch 10 paralel (server:
 *     Promise.all sekaligus) — hasil sama, latensi lebih aman.
 *   - File leaderboard stats-data ~40MB diunduh sekali per sesi lalu
 *     di-cache di memori 10 menit (dipakai bersama recommend +
 *     leaderboard); di koneksi lambat pemuatan pertama bisa >30 detik.
 *   - Tidak ada filter/validasi server-side tambahan; validasi alamat &
 *     window dipertahankan sama persis dengan server.
 */
(function () {
    'use strict';

    var HL_INFO = 'https://api.hyperliquid.xyz/info';
    var HL_STATS = 'https://stats-data.hyperliquid.xyz/Mainnet';
    var ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
    var WINDOWS = { '7d': 7, '14d': 14, '1m': 30, '3m': 90, '6m': 180 };
    var NATIVE_BUCKET = { '7d': 'week', '1m': 'month' };

    // Cache mentah leaderboard + vaults (sekali per sesi, 10/30 menit).
    var RAW_CACHE = {};
    function rawGet(key, ttlMs) {
        var e = RAW_CACHE[key];
        if (!e) return null;
        if (Date.now() - e.at > ttlMs) { delete RAW_CACHE[key]; return null; }
        return e.value;
    }
    function rawSet(key, value) {
        RAW_CACHE[key] = { at: Date.now(), value: value };
    }

    function num(v) {
        var n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    function fetchWithTimeout(url, options, timeoutMs) {
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
        var opts = options || {};
        opts.signal = ctrl.signal;
        return fetch(url, opts).then(function (res) {
            clearTimeout(t);
            if (!res.ok) throw new Error('HTTP ' + res.status + ' untuk ' + url);
            return res;
        }).catch(function (e) {
            clearTimeout(t);
            throw e;
        });
    }

    function hlPost(payload, opts) {
        var o = opts || {};
        var timeoutMs = o.timeoutMs || 15000;
        var maxBytes = o.maxBytes || 2 * 1024 * 1024;
        return fetchWithTimeout(HL_INFO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }, timeoutMs).then(function (res) {
            var len = Number(res.headers.get('content-length') || 0);
            if (len > maxBytes) throw new Error('Upstream response too large');
            return res.json();
        });
    }

    function statsGet(path, opts) {
        var o = opts || {};
        // 120 dtk (server: 60 dtk) — file leaderboard ~40MB di 4G bisa
        // melebihi 60 dtk; timeout di sini hanya pengaman, bukan target.
        return fetchWithTimeout(HL_STATS + path, {}, o.timeoutMs || 120000).then(function (res) {
            return res.json();
        });
    }

    // Batch paralel terbatas (hasil sama dengan Promise.all, beban lebih aman).
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

    /* ---- Helper murni (port verbatim api/hl-wallet.js) ---- */

    function perfOf(row, bucket) {
        var wp = Array.isArray(row.windowPerformances) ? row.windowPerformances : [];
        for (var i = 0; i < wp.length; i++) {
            if (wp[i][0] === bucket) return wp[i][1] || {};
        }
        return {};
    }

    function windowPnl(pnlHist, acctHist, days) {
        if (!Array.isArray(pnlHist) || pnlHist.length < 2) return { pnl: 0, roi: 0, points: 0 };
        var end = pnlHist[pnlHist.length - 1][0];
        var cutoff = end - days * 86400 * 1000;
        var startIdx = 0;
        for (var i = 0; i < pnlHist.length; i++) {
            if (pnlHist[i][0] >= cutoff) { startIdx = i; break; }
            startIdx = i;
        }
        var pnl = num(pnlHist[pnlHist.length - 1][1]) - num(pnlHist[startIdx][1]);
        var equity0 = 0;
        if (Array.isArray(acctHist)) {
            for (var j = 0; j < acctHist.length; j++) {
                if (acctHist[j][0] >= cutoff) { equity0 = num(acctHist[j][1]); break; }
            }
            if (!(equity0 > 0)) {
                for (var k = 0; k < acctHist.length; k++) {
                    var v = num(acctHist[k][1]);
                    if (v > 0) { equity0 = v; break; }
                }
            }
        }
        return { pnl: pnl, roi: equity0 > 0 ? pnl / equity0 : 0, points: pnlHist.length - startIdx };
    }

    function bucketOf(portfolio, name) {
        if (!Array.isArray(portfolio)) return null;
        for (var i = 0; i < portfolio.length; i++) {
            if (portfolio[i][0] === name) return portfolio[i][1];
        }
        return null;
    }

    function deriveOpenTimes(assetPositions, fills) {
        var byCoin = {};
        (fills || []).forEach(function (f) {
            var coin = String(f.coin || '');
            if (!coin) return;
            if (!byCoin[coin]) byCoin[coin] = [];
            byCoin[coin].push(f);
        });
        var out = {};
        (assetPositions || []).forEach(function (ap) {
            var pos = ap.position || ap;
            var coin = String(pos.coin || '');
            if (!coin) return;
            var cf = (byCoin[coin] || []).slice().sort(function (a, b) { return b.time - a.time; });
            var openTime = null;
            for (var i = 0; i < cf.length; i++) {
                var f = cf[i];
                var start = num(f.startPosition);
                var sz = num(f.sz);
                var signed = /short/i.test(String(f.dir || '')) ? -sz : sz;
                var crossedZero = start !== 0 && Math.sign(start) !== Math.sign(start + signed);
                if (Math.abs(start) < 1e-12 || crossedZero) { openTime = num(f.time) || null; break; }
            }
            out[coin] = openTime;
        });
        return out;
    }

    function normalizePosition(ap) {
        var p = ap.position || ap;
        var szi = num(p.szi);
        var lev = p.leverage && typeof p.leverage === 'object' ? p.leverage : {};
        return {
            coin: String(p.coin || ''),
            side: szi > 0 ? 'LONG' : (szi < 0 ? 'SHORT' : 'FLAT'),
            entryPx: num(p.entryPx),
            size: Math.abs(szi),
            notional: Math.abs(num(p.positionValue)),
            uPnl: num(p.unrealizedPnl),
            roe: num(p.returnOnEquity),
            leverage: num(lev.value) || 0,
            levType: String(lev.type || ''),
            liqPx: num(p.liquidationPx),
            marginUsed: num(p.marginUsed),
            maxLeverage: num(p.maxLeverage) || 0
        };
    }

    function positionStats(assetPositions) {
        var active = 0, wins = 0, losses = 0, upnl = 0, grossProfit = 0, grossLoss = 0;
        (assetPositions || []).forEach(function (ap) {
            var p = normalizePosition(ap);
            if (p.side === 'FLAT') return;
            active++;
            var u = p.uPnl;
            upnl += u;
            if (u > 0) { wins++; grossProfit += u; }
            else if (u < 0) { losses++; grossLoss += -u; }
        });
        var decided = wins + losses;
        return { active: active, wins: wins, losses: losses, upnl: upnl, grossProfit: grossProfit, grossLoss: grossLoss, winRate: decided > 0 ? wins / decided : 0 };
    }

    function inEquityRange(equity, minEquity, maxEquity) {
        if (equity < Math.max(1000, minEquity || 0)) return false;
        if (maxEquity > 0 && equity > maxEquity) return false;
        return true;
    }

    function passesLeaderboardGate(pos) {
        if (!pos || pos.active < 1) return false;
        return pos.wins / pos.active >= 0.75;
    }

    function scoreCandidate(c) {
        var roi = Math.max(-1, Math.min(5, c.roi));
        var roiScore = Math.max(0, Math.min(30, ((roi + 1) / 6) * 30));
        var pnlScore = Math.max(0, Math.min(20, (Math.log10(1 + Math.max(0, c.pnl)) / 7) * 20));
        var ddScore = c.roi < 0 ? 0 : 15;
        var vlmScore = Math.max(0, Math.min(10, (Math.log10(1 + Math.max(0, c.vlm)) / 10) * 10));
        var posScore = 12.5;
        if (c.pos && c.pos.active > 0) {
            var decided = c.pos.wins + c.pos.losses;
            if (decided === 0) {
                posScore = 12.5;
            } else {
                var winRate = c.pos.wins / decided;
                var gross = c.pos.grossProfit + c.pos.grossLoss;
                var dominance = gross > 0 ? c.pos.grossProfit / gross : 0.5;
                posScore = 15 * winRate + 10 * dominance;
            }
        }
        var score = roiScore + pnlScore + ddScore + vlmScore + posScore;
        if (c.pos && c.pos.active >= 3) {
            var d2 = c.pos.wins + c.pos.losses;
            if (d2 >= 3 && c.pos.wins / d2 < 0.5) score *= 0.7;
        }
        return score;
    }

    /* ---- Handler action (port api/hl-wallet.js) ---- */

    function getLeaderboardRows() {
        var hit = rawGet('hl:leaderboard-rows', 10 * 60 * 1000);
        if (hit) return Promise.resolve(hit);
        return statsGet('/leaderboard').then(function (lb) {
            var rows = Array.isArray(lb.leaderboardRows) ? lb.leaderboardRows : [];
            rawSet('hl:leaderboard-rows', rows);
            return rows;
        });
    }

    function getVaultAddresses() {
        var hit = rawGet('hl:vaultAddrs', 30 * 60 * 1000);
        if (hit) return Promise.resolve(hit);
        return statsGet('/vaults').then(function (data) {
            var list = Array.isArray(data) ? data : (data.vaults || data.data || []);
            var set = {};
            list.forEach(function (v) {
                var a = v.vaultAddress || v.address || v.vault_address;
                if (typeof a === 'string' && ADDR_RE.test(a)) set[a.toLowerCase()] = true;
            });
            rawSet('hl:vaultAddrs', set);
            return set;
        }).catch(function () {
            // Vaults opsional (server: rekomendasi tetap jalan).
            return {};
        });
    }

    function handleWallet(address) {
        var addr = address.toLowerCase();
        return Promise.all([
            hlPost({ type: 'portfolio', user: addr }),
            hlPost({ type: 'clearinghouseState', user: addr }),
            hlPost({ type: 'userFills', user: addr }, { maxBytes: 8 * 1024 * 1024 })
        ]).then(function (parts) {
            var portfolio = parts[0], chState = parts[1], fills = parts[2];
            if (!chState || !chState.marginSummary || !Array.isArray(chState.assetPositions)) {
                throw new Error('Hyperliquid upstream malformed clearinghouseState');
            }
            var positions = (chState.assetPositions || []).map(normalizePosition).filter(function (p) { return p.side !== 'FLAT'; });
            var openTimes = deriveOpenTimes(chState.assetPositions || [], fills);
            var windows = {};
            Object.keys(WINDOWS).forEach(function (key) {
                var days = WINDOWS[key];
                var b = bucketOf(portfolio, days <= 31 ? 'month' : 'allTime');
                var precise = days === 7 ? (bucketOf(portfolio, 'week') || b) : b;
                if (precise) windows[key] = windowPnl(precise.pnlHistory, precise.accountValueHistory, days);
            });
            var recentFills = (fills || []).slice(0, 50).map(function (f) {
                return {
                    coin: String(f.coin || ''), dir: String(f.dir || ''), px: num(f.px),
                    sz: num(f.sz), time: num(f.time), closedPnl: num(f.closedPnl),
                    fee: Math.abs(num(f.fee))
                };
            });
            var wins = 0, closes = 0, grossWin = 0, grossLoss = 0;
            (fills || []).forEach(function (f) {
                if (/^close/i.test(String(f.dir || ''))) {
                    closes++;
                    var p = num(f.closedPnl);
                    if (p > 0) { wins++; grossWin += p; } else grossLoss += Math.abs(p);
                }
            });
            return {
                address: addr,
                equity: num(chState.marginSummary && chState.marginSummary.accountValue),
                marginUsed: num(chState.marginSummary && chState.marginSummary.totalMarginUsed),
                withdrawable: num(chState.withdrawable),
                windows: windows,
                positions: positions.map(function (p) {
                    var o = {};
                    Object.keys(p).forEach(function (k) { o[k] = p[k]; });
                    o.openTime = openTimes[p.coin] || null;
                    return o;
                }),
                recentFills: recentFills,
                stats: {
                    fills: (fills || []).length,
                    closes: closes,
                    winRate: closes ? wins / closes : 0,
                    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
                },
                fetchedAt: new Date().toISOString()
            };
        });
    }

    function handleFills(address) {
        var addr = address.toLowerCase();
        return hlPost({ type: 'userFills', user: addr }, { maxBytes: 8 * 1024 * 1024 }).then(function (fills) {
            return {
                address: addr,
                fills: (fills || []).slice(0, 200).map(function (f) {
                    return {
                        coin: String(f.coin || ''), dir: String(f.dir || ''), px: num(f.px),
                        sz: num(f.sz), time: num(f.time), startPosition: num(f.startPosition),
                        closedPnl: num(f.closedPnl)
                    };
                }),
                fetchedAt: new Date().toISOString()
            };
        });
    }

    function handleMids() {
        return hlPost({ type: 'allMids' }, { maxBytes: 512 * 1024 }).then(function (raw) {
            var mids = {};
            Object.keys(raw || {}).forEach(function (k) {
                if (k.charAt(0) === '#') return;
                var n = num(raw[k]);
                if (n > 0) mids[k] = n;
            });
            return { mids: mids, fetchedAt: new Date().toISOString() };
        });
    }

    function handleRecommend(windowKey) {
        return Promise.all([getLeaderboardRows(), getVaultAddresses()]).then(function (parts) {
            var rows = parts[0], vaults = parts[1];
            var cands = [];
            rows.forEach(function (r) {
                var addr = String(r.ethAddress || '').toLowerCase();
                if (!ADDR_RE.test(addr)) return;
                if (vaults[addr]) return;
                var equity = num(r.accountValue);
                if (equity < 10000) return;
                cands.push({ address: addr, displayName: r.displayName || null, equity: equity, row: r });
            });
            var days = WINDOWS[windowKey];
            var native = NATIVE_BUCKET[windowKey];
            if (native) {
                var ranked = cands.map(function (c) {
                    var perf = perfOf(c.row, native);
                    var pnl = num(perf.pnl), roi = num(perf.roi), vlm = num(perf.vlm);
                    return { address: c.address, displayName: c.displayName, equity: c.equity, pnl: pnl, roi: roi, vlm: vlm, score: 0 };
                }).filter(function (c) { return c.pnl > 0 && c.vlm > 0; });
                ranked.forEach(function (c) { c.score = scoreCandidate(c); });
                ranked.sort(function (a, b) { return b.score - a.score; });
                ranked = ranked.slice(0, 5);
                return finishRecommend(windowKey, days, ranked);
            }
            var proxyBucket = days <= 14 ? 'week' : 'month';
            var prelim = cands.map(function (c) {
                var perf = perfOf(c.row, proxyBucket);
                return { address: c.address, displayName: c.displayName, equity: c.equity, pnl: num(perf.pnl), roi: num(perf.roi), vlm: num(perf.vlm), score: 0 };
            }).filter(function (c) { return c.pnl > 0 && c.vlm > 0; });
            prelim.forEach(function (c) { c.score = scoreCandidate(c); });
            prelim.sort(function (a, b) { return b.score - a.score; });
            var shortlist = prelim.slice(0, 60);
            var bucketName = days <= 31 ? 'month' : 'allTime';
            return mapLimit(shortlist, 10, function (c) {
                return hlPost({ type: 'portfolio', user: c.address }, { timeoutMs: 12000 }).then(function (pf) {
                    var b = bucketOf(pf, bucketName);
                    if (!b) return null;
                    var w = windowPnl(b.pnlHistory, b.accountValueHistory, days);
                    return { address: c.address, displayName: c.displayName, equity: c.equity, pnl: w.pnl, roi: w.roi, vlm: num(b.vlm), score: 0 };
                }).catch(function () { return null; });
            }).then(function (results) {
                var detailed = results.filter(function (r) { return r && r.pnl > 0; });
                detailed.forEach(function (c) { c.score = scoreCandidate(c); });
                detailed.sort(function (a, b) { return b.score - a.score; });
                return finishRecommend(windowKey, days, detailed.slice(0, 5));
            });
        });
    }

    function finishRecommend(windowKey, days, ranked) {
        return {
            window: windowKey,
            days: days,
            generatedAt: new Date().toISOString(),
            wallets: ranked.map(function (c, i) {
                return {
                    rank: i + 1,
                    address: c.address,
                    displayName: c.displayName,
                    equity: Math.round(c.equity * 100) / 100,
                    pnl: Math.round(c.pnl * 100) / 100,
                    roi: Math.round(c.roi * 10000) / 10000,
                    volume: Math.round(c.vlm * 100) / 100,
                    score: Math.round(c.score * 10) / 10
                };
            })
        };
    }

    function handleLeaderboard(windowKey, opts) {
        opts = opts || {};
        var minEquity = num(opts.minEquity) || 0;
        var maxEquity = num(opts.maxEquity) || 0;
        var minWinRate = num(opts.minWinRate) || 0;
        var limit = Math.min(100, Math.max(10, Math.round(num(opts.limit) || 50)));
        var sortBy = String(opts.sortBy || 'score').slice(0, 32);
        return Promise.all([getLeaderboardRows(), getVaultAddresses()]).then(function (parts) {
            var rows = parts[0], vaults = parts[1];
            var days = WINDOWS[windowKey];
            var native = NATIVE_BUCKET[windowKey];
            var out = [];
            if (native) {
                rows.forEach(function (r) {
                    var addr = String(r.ethAddress || '').toLowerCase();
                    if (!ADDR_RE.test(addr)) return;
                    if (vaults[addr]) return;
                    var equity = num(r.accountValue);
                    if (!inEquityRange(equity, minEquity, maxEquity)) return;
                    var perf = perfOf(r, native);
                    var pnl = num(perf.pnl), roi = num(perf.roi), vlm = num(perf.vlm);
                    if (!(pnl > 0 && vlm > 0) && minWinRate > 0) return;
                    var cand = { address: addr, displayName: r.displayName || null, equity: equity, pnl: pnl, roi: roi, vlm: vlm, winRate: 0, closes: 0, score: 0 };
                    cand.score = scoreCandidate(cand);
                    out.push(cand);
                });
            } else {
                var proxyBucket = days <= 14 ? 'week' : 'month';
                var prelim = [];
                rows.forEach(function (r) {
                    var addr = String(r.ethAddress || '').toLowerCase();
                    if (!ADDR_RE.test(addr)) return;
                    if (vaults[addr]) return;
                    var equity = num(r.accountValue);
                    if (!inEquityRange(equity, minEquity, maxEquity)) return;
                    var perf = perfOf(r, proxyBucket);
                    prelim.push({ address: addr, displayName: r.displayName || null, equity: equity, pnl: num(perf.pnl), roi: num(perf.roi), vlm: num(perf.vlm), winRate: 0, closes: 0, row: r, score: 0 });
                });
                prelim.sort(function (a, b) { return b.pnl - a.pnl; });
                var shortlist = prelim.slice(0, 120);
                var bucketName = days <= 31 ? 'month' : 'allTime';
                return mapLimit(shortlist, 10, function (c) {
                    return hlPost({ type: 'portfolio', user: c.address }, { timeoutMs: 12000 }).then(function (pf) {
                        var b = bucketOf(pf, bucketName);
                        if (!b) return null;
                        var w = windowPnl(b.pnlHistory, b.accountValueHistory, days);
                        return { address: c.address, displayName: c.displayName, equity: c.equity, pnl: w.pnl, roi: w.roi, vlm: num(b.vlm), winRate: 0, closes: 0, score: 0 };
                    }).catch(function () { return null; });
                }).then(function (results) {
                    results.forEach(function (r) { if (r && r.pnl > -1e9) out.push(r); });
                    out.forEach(function (c) { c.score = scoreCandidate(c); });
                    return enrichAndFinish(out, sortBy, limit, windowKey, days, minEquity, maxEquity, minWinRate);
                });
            }
            return enrichAndFinish(out, sortBy, limit, windowKey, days, minEquity, maxEquity, minWinRate);
        });
    }

    function enrichAndFinish(out, sortBy, limit, windowKey, days, minEquity, maxEquity, minWinRate) {
        var enrichSet = {};
        var enrichList = [];
        function add(c) {
            if (!enrichSet[c.address]) { enrichSet[c.address] = c; enrichList.push(c); }
        }
        out.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 150).forEach(add);
        if (sortBy !== 'score') {
            var sorted = out.slice();
            if (sortBy === 'equity') sorted.sort(function (a, b) { return b.equity - a.equity; });
            else if (sortBy === 'pnl') sorted.sort(function (a, b) { return b.pnl - a.pnl; });
            else if (sortBy === 'roi') sorted.sort(function (a, b) { return b.roi - a.roi; });
            sorted.slice(0, limit).forEach(add);
        }
        return mapLimit(enrichList, 10, function (c) {
            return hlPost({ type: 'clearinghouseState', user: c.address }, { timeoutMs: 12000 }).then(function (ch) {
                return { address: c.address, pos: positionStats(ch.assetPositions || []) };
            }).catch(function () { return null; });
        }).then(function (posResults) {
            posResults.forEach(function (r) {
                if (!r) return;
                var c = enrichSet[r.address];
                if (!c) return;
                c.pos = r.pos;
                c.score = scoreCandidate(c);
            });
            var gated = out.filter(function (c) { return passesLeaderboardGate(c.pos); });
            if (sortBy === 'equity') gated.sort(function (a, b) { return b.equity - a.equity; });
            else if (sortBy === 'pnl') gated.sort(function (a, b) { return b.pnl - a.pnl; });
            else if (sortBy === 'roi') gated.sort(function (a, b) { return b.roi - a.roi; });
            else gated.sort(function (a, b) { return b.score - a.score; });
            var final = gated.slice(0, limit).map(function (c, i) {
                return {
                    rank: i + 1, address: c.address, displayName: c.displayName,
                    equity: Math.round(c.equity * 100) / 100,
                    pnl: Math.round(c.pnl * 100) / 100,
                    roi: Math.round(c.roi * 10000) / 10000,
                    volume: Math.round(c.vlm * 100) / 100,
                    winRate: c.winRate || 0,
                    closes: c.closes || 0,
                    score: Math.round(c.score * 10) / 10,
                    activePositions: c.pos ? c.pos.active : 0,
                    winPositions: c.pos ? c.pos.wins : 0,
                    lossPositions: c.pos ? c.pos.losses : 0,
                    upnl: c.pos ? Math.round(c.pos.upnl * 100) / 100 : 0
                };
            });
            return {
                window: windowKey, days: days, sortBy: sortBy, limit: limit,
                filters: { minEquity: minEquity, maxEquity: maxEquity, minWinRate: minWinRate },
                generatedAt: new Date().toISOString(),
                total: gated.length,
                wallets: final
            };
        });
    }

    function request(action, params) {
        params = params || {};
        var a = String(action || '').toLowerCase();
        if (a === 'recommend') {
            var windowKey = String(params.window || '7d').toLowerCase();
            if (!Object.prototype.hasOwnProperty.call(WINDOWS, windowKey)) return Promise.reject(new Error('window tidak valid (7d|14d|1m|3m|6m)'));
            return handleRecommend(windowKey);
        }
        if (a === 'wallet' || a === 'fills') {
            var address = String(params.address || '');
            if (!ADDR_RE.test(address)) return Promise.reject(new Error('address tidak valid (0x… 40 hex)'));
            return a === 'wallet' ? handleWallet(address) : handleFills(address);
        }
        if (a === 'mids') return handleMids();
        if (a === 'leaderboard') {
            var wk = String(params.window || '7d').toLowerCase();
            if (!Object.prototype.hasOwnProperty.call(WINDOWS, wk)) return Promise.reject(new Error('window tidak valid (7d|14d|1m|3m|6m)'));
            return handleLeaderboard(wk, params);
        }
        return Promise.reject(new Error('action tidak dikenal (recommend|wallet|fills|mids|leaderboard)'));
    }

    var WalletTrackerFallback = {
        request: request,
        _test: {
            windowPnl: windowPnl,
            deriveOpenTimes: deriveOpenTimes,
            normalizePosition: normalizePosition,
            scoreCandidate: scoreCandidate,
            positionStats: positionStats,
            inEquityRange: inEquityRange,
            passesLeaderboardGate: passesLeaderboardGate,
            perfOf: perfOf,
            bucketOf: bucketOf,
            ADDR_RE: ADDR_RE,
            WINDOWS: WINDOWS
        }
    };

    if (typeof window !== 'undefined') window.WalletTrackerFallback = WalletTrackerFallback;
    if (typeof module !== 'undefined' && module.exports) module.exports = WalletTrackerFallback;
})();
