/* config.js — single source of truth for the frontend Supabase configuration.
 *
 * Both values below are PUBLIC by design:
 *   - the project URL, and
 *   - the publishable (browser) API key.
 * They carry no secret authority; Supabase enforces access through Row Level
 * Security. Never place a service-role/secret key here or in any frontend file.
 *
 * A deployment may override both values without editing this file by defining
 * `window.__MASAKO_CONFIG__` in a script tag (or an inline bootstrap) BEFORE
 * this file loads:
 *   window.__MASAKO_CONFIG__ = {
 *     supabaseUrl: 'https://<project-ref>.supabase.co',
 *     supabasePublishableKey: 'sb_publishable_...'
 *   };
 *
 * The backend (`api/_auth.js`) resolves its own Supabase project from the
 * `SUPABASE_URL` environment variable, which must point at the SAME project so
 * that access tokens issued to the browser can be verified server side.
 */
(function resolveSupabaseConfig(globalObj) {
    var DEFAULTS = {
        supabaseUrl: 'https://qxovqhkxisdbvdsujgut.supabase.co',
        supabasePublishableKey: 'sb_publishable_cPFvrWaJuq2tDvzwBHIT9A_fGAO6HFc'
    };
    var RETIRED_HOSTS = ['yvmayttjonepqemvrple.supabase.co'];

    function normalizeUrl(value) {
        var url = String(value || '').trim();
        if (!url) return '';
        // Drop a trailing slash so `${url}/auth/v1` never doubles up.
        return url.replace(/\/+$/, '');
    }

    function isRetiredUrl(value) {
        var lower = String(value || '').toLowerCase();
        for (var i = 0; i < RETIRED_HOSTS.length; i++) {
            if (lower.indexOf(RETIRED_HOSTS[i]) !== -1) return true;
        }
        return false;
    }

    var override = globalObj.__MASAKO_CONFIG__ || {};
    var rawUrl = normalizeUrl(override.supabaseUrl || DEFAULTS.supabaseUrl);
    var url = isRetiredUrl(rawUrl) ? DEFAULTS.supabaseUrl : rawUrl;
    var rawKey = String(override.supabasePublishableKey || DEFAULTS.supabasePublishableKey).trim();
    var key = isRetiredUrl(rawUrl) ? DEFAULTS.supabasePublishableKey : rawKey;
    if (isRetiredUrl(rawUrl) && typeof console !== 'undefined' && console.warn) {
        console.warn('[config] override supabaseUrl points to retired project — using active project ' + DEFAULTS.supabaseUrl);
    }

    // Legacy aliases kept so every existing consumer keeps working. The
    // publishable key occupies the same slot the anon key used to occupy.
    globalObj.SUPABASE_URL = url;
    globalObj.SUPABASE_PUBLISHABLE_KEY = key;
    globalObj.SUPABASE_ANON_KEY = key;

    // Single opt-in switch for verbose browser logging. Off by default so a
    // production console stays clean; enable with localStorage
    // `masako_debug=1` (or `__MASAKO_CONFIG__.debug`) when diagnosing.
    var debug = override.debug;
    if (debug === undefined) {
        try {
            debug = globalObj.localStorage && globalObj.localStorage.getItem('masako_debug') === '1';
        } catch (e) {
            debug = false;
        }
    }
    globalObj.MASAKO_DEBUG = !!debug;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            SUPABASE_URL: url,
            SUPABASE_PUBLISHABLE_KEY: key,
            MASAKO_DEBUG: !!debug
        };
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
