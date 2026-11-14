// build-snapshots.mjs — pembangun snapshot precomputed untuk GitHub Pages.
//
// Dijalankan oleh .github/workflows/snapshot.yml tiap 10 menit (dan bisa
// dijalankan manual: `node scripts/build-snapshots.mjs` dari root repo).
// Memakai ulang modul fallback yang ikut ter-deploy di repo ini
// (src/data/bandarFallback.js + src/engines/walletTrackerFallback.js),
// sehingga bentuk JSON-nya IDENTIK dengan yang dipakai frontend — file
// data/*.json di sini bisa langsung dipakai load()/fetchJson() tanpa
// transformasi apa pun.
//
// Kenapa ada: di GitHub Pages tidak ada backend /api. Tanpa snapshot,
// HP pengunjung harus live-fetch ~70 request upstream (bandar) + unduhan
// stats 40MB (tracker) — di 4G itu terasa stuck loading ber menit-menit,
// padahal di Vercel /api menyajikan snapshot precomputed dalam <1 detik.
// Dengan snapshot ini, HP cukup fetch SATU JSON kecil dari origin yang
// sama — pengalaman yang sama mulusnya dengan Vercel.
//
// File yang ditulis (di data/, di-commit kembali oleh workflow):
//   bandar-snapshot.json                 — output buildSnapshot()
//   tracker-recommend-<window>.json      — request('recommend', {window})
//   tracker-leaderboard-<window>.json    — request('leaderboard',
//                                          {window, sortBy:'score', limit:50})
//     untuk window 7d, 14d, 1m, 3m, 6m (default UI: win 7d, sort score,
//     limit 50, tanpa filter — persis yang dipakai snapshot-first di
//     bandarWalletUI.js / walletTracker.js).
//
// Keamanan: semua sumber publik (mempool.space, Hyperliquid API,
// stats-data.hyperliquid.xyz). Tidak ada kredensial, tidak ada data
// privat. Kegagalan per file tidak menggagalkan file lain; file yang
// gagal tidak ditulis ulang sehingga snapshot lama tetap tersaji.
//
// Fail-closed untuk bandar-snapshot.json (2026-11-14): buildSnapshot()
// menoleransi wallet yang gagal dimuat (baris bernilai null) demi
// frontend fallback, TAPI baris null di hypeWallets dibaca konsumen
// alert (diff.mjs / bandar-live-watch) sebagai 0 dan memicu CLOSE palsu.
// Insiden 14 Nov 15:37 WIB: 10/12 wallet hype gagal → 30 alert CLOSE
// palsu + state nol + cooldown 60 mnt. Karena itu builder MENOLAK
// menulis bandar-snapshot.json bila ada satu pun wallet HYPE yang gagal
// dimuat (total == null) — seperti fetch-live.mjs: snapshot lama tetap
// tersaji (stale lebih baik daripada beracun).
// Wallet BTC (spot) SENGAJA tidak ikut guard: mereka gagal 2-7 per run
// di Actions (mis. 34yeXcv1tQSQ, bc1qt26w24cp di hampir semua run) tapi
// tidak berbahaya — notif spot BTC mati, frontend hanya menampilkan "—",
// dan riwayat membuktikan puluhan run dengan BTC null tidak pernah
// memicu alert palsu. Guard yang ikut memblokir BTC akan membekukan
// snapshot selamanya.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');

const bandar = await import('../src/data/bandarFallback.js').then((m) => m.default || m);
const tracker = await import('../src/engines/walletTrackerFallback.js').then((m) => m.default || m);

const WINDOWS = Object.keys((tracker._test && tracker._test.WINDOWS) || { '7d': 1, '14d': 1, '1m': 1, '3m': 1, '6m': 1 });

mkdirSync(DATA_DIR, { recursive: true });

let written = 0;
let failed = 0;

function write(name, obj) {
    const text = JSON.stringify(obj);
    writeFileSync(join(DATA_DIR, name), text);
    written += 1;
    console.log('OK  ' + name + ' (' + text.length + ' bytes)');
}

async function attempt(name, fn) {
    try {
        await fn();
    } catch (e) {
        failed += 1;
        console.log('FAIL ' + name + ': ' + (e && e.message ? e.message : e));
    }
}

// 1. Bandar: snapshot persis buildSnapshot(), hanya storageNote yang
//    diganti menjelaskan mode snapshot (waktu update ada di updatedAt).
//    Guard fail-closed (hype saja — lihat header): tolak menulis bila
//    ada wallet hype yang gagal dimuat — lempar supaya attempt()
//    mencatat FAIL dan file lama tetap tersaji.
await attempt('bandar-snapshot.json', async () => {
    const snap = await bandar.buildSnapshot();
    const failedHype = (snap.hypeWallets || []).filter((w) => w.total == null).length;
    if (failedHype > 0) {
        throw new Error('fail-closed: ' + failedHype + '/' + (snap.hypeWallets || []).length
            + ' hype wallet gagal dimuat — snapshot tidak ditulis');
    }
    snap.storageNote = 'Snapshot diperbarui otomatis tiap 10 menit dari mempool.space + Hyperliquid (mode GitHub Pages — backend /api tidak tersedia selama Vercel pause).';
    write('bandar-snapshot.json', snap);
});

// 2. Tracker: recommend + leaderboard default untuk semua window.
for (const w of WINDOWS) {
    await attempt('tracker-recommend-' + w + '.json', async () => {
        const data = await tracker.request('recommend', { window: w });
        write('tracker-recommend-' + w + '.json', data);
    });
    await attempt('tracker-leaderboard-' + w + '.json', async () => {
        const data = await tracker.request('leaderboard', { window: w, sortBy: 'score', limit: 50 });
        write('tracker-leaderboard-' + w + '.json', data);
    });
}

console.log('Selesai: ' + written + ' ditulis, ' + failed + ' gagal.');
if (written === 0) process.exit(1);
