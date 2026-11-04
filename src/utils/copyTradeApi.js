/* src/utils/copyTradeApi.js — thin client untuk /api/copy-trade (persist session).
 * Dipanggil dari src/engines/copyTrade.js untuk sync state ke server saat user
 * login (fallback diam-diam ke localStorage-only saat guest / server gagal).
 */
(function () {
    'use strict';

    async function apiCall(method, path, body) {
        var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
        if (body !== undefined) opts.body = JSON.stringify(body);
        try {
            var res = await fetch('/api/copy-trade' + (path || ''), opts);
            var data = null;
            try { data = await res.json(); } catch (_) {}
            if (!res.ok) {
                var msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
                throw new Error(msg);
            }
            return data || { ok: false };
        } catch (e) {
            // Jika fetch gagal (offline / server error), kembalikan guest agar
            // engine tidak crash — copy akan tetap jalan localStorage-only.
            return { ok: false, offline: true, error: e.message };
        }
    }

    var CopyTradeApi = {
        list: function () { return apiCall('GET', ''); },
        start: function (address, settings) { return apiCall('POST', '', { address: address, settings: settings }); },
        stop: function (address) { return apiCall('POST', '/' + address + '/stop'); },
        toggle: function (address, enabled) { return apiCall('POST', '/' + address + '/toggle', { enabled: !!enabled }); }
    };

    if (typeof window !== 'undefined') window.CopyTradeApi = CopyTradeApi;
    if (typeof module !== 'undefined' && module.exports) module.exports = CopyTradeApi;
})();
