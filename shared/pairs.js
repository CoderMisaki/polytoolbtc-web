(function attachPairWhitelist(root, factory) {
  const whitelist = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = whitelist;
  }
  if (root) {
    root.MASAKO_ALLOWED_PAIRS = whitelist.ALLOWED_PAIRS.slice();
    root.MASAKO_DEFAULT_PAIR = whitelist.DEFAULT_PAIR;
    root.MASAKO_PAIRS = whitelist;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildPairWhitelist() {
  // CORE LIST — bukan lagi batas hard universe arbitrase.
  //
  // Mode LOCAL ARBITRAGE (src/engines/marketUniverse.js) membangun universe
  // secara dinamis: Top N coin berdasarkan volume futures 24 jam yang tersedia
  // BERSAMAAN di Binance, OKX, dan Bybit (harga + funding + liquidity valid).
  // Coin bertambah/hilang sendiri tiap refresh, jadi daftar di bawah ini hanya
  // berperan sebagai:
  //   1. seed pair selector sebelum universe pertama selesai dimuat,
  //   2. default pair / major yang selalu dihangatkan engine server,
  //   3. fallback bila ketiga API exchange tidak terjangkau.
  //
  // Pair di luar core list TETAP valid selama bentuknya symbol USDT perpetual
  // yang sah — aturan bentuk di bawah dipakai bersama oleh frontend dan backend
  // (api/_validation.js, api/cron-check.js) supaya coin baru hasil intersection
  // tidak ditolak saat posisi demo disimpan.
  const ALLOWED_PAIRS = Object.freeze([
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'DOGEUSDT',
    'XRPUSDT',
    'PEPEUSDT',
    'SHIBUSDT',
    'WIFUSDT',
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'DOTUSDT',
    'OPUSDT',
    'ARBUSDT',
    'TIAUSDT',
    'SUIUSDT',
    'APTUSDT',
    'SEIUSDT',
    'LTCUSDT',
    'BNBUSDT',
    'TONUSDT',
    'NEARUSDT',
    'INJUSDT',
    'ATOMUSDT',
    'FILUSDT',
    'TRXUSDT',
    'ETCUSDT',
    'BCHUSDT',
    'UNIUSDT',
    'AAVEUSDT',
    'MATICUSDT',
    'IMXUSDT',
    'RNDRUSDT',
    'FETUSDT',
    'WLDUSDT',
    'JUPUSDT',
    'STRKUSDT',
    'PYTHUSDT',
    'JTOUSDT',
    'WUSDT',
    'BONKUSDT',
    'FLOKIUSDT',
    'ORDIUSDT',
    'STXUSDT',
    'RUNEUSDT',
    'ARUSDT',
    'SANDUSDT',
    'MANAUSDT',
    'AXSUSDT',
    'GALAUSDT',
    'LDOUSDT',
    'MKRUSDT',
    'DYDXUSDT',
    'ENAUSDT',
    'EIGENUSDT'
  ]);

  // Bentuk symbol USDT perpetual yang sah: 2-20 karakter alfanumerik + "USDT".
  // Cukup ketat untuk menolak sampah/injeksi, cukup longgar untuk coin apa pun
  // yang benar-benar terdaftar di exchange (tanpa daftar coin hardcode).
  const PAIR_SHAPE_RE = /^[A-Z0-9]{2,20}USDT$/;

  /**
   * Apakah `value` symbol USDT perpetual yang sah?
   * Dipakai frontend (pair selector/universe) dan backend (validasi posisi).
   */
  function isUsdtPerpetualPair(value) {
    const pair = String(value === undefined || value === null ? '' : value).toUpperCase();
    if (!PAIR_SHAPE_RE.test(pair)) return false;
    const base = pair.slice(0, -4);
    // Tolak bentuk degeneratif: quote saja ("USDTUSDT") atau base berupa angka.
    if (base === 'USDT') return false;
    if (/^[0-9]+$/.test(base)) return false;
    return true;
  }

  /** Base coin dari pair (BTCUSDT -> BTC, 1000SHIBUSDT -> 1000SHIB). */
  function pairBase(value) {
    const pair = String(value === undefined || value === null ? '' : value).toUpperCase();
    return pair.endsWith('USDT') ? pair.slice(0, -4) : pair;
  }

  return Object.freeze({
    ALLOWED_PAIRS,
    // Alias yang menegaskan peran baru daftar statis ini.
    CORE_PAIRS: ALLOWED_PAIRS,
    DEFAULT_PAIR: ALLOWED_PAIRS[0],
    ALLOWED_PAIR_SET: new Set(ALLOWED_PAIRS),
    PAIR_SHAPE_RE,
    isUsdtPerpetualPair,
    pairBase
  });
});
