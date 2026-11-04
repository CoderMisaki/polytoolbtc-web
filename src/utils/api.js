function normalizeApiPath(path) {
    const value = String(path || '');
    if (!value.startsWith('/api/')) return `/api/${value.replace(/^\/+/, '')}`;
    return value;
}

function getAuthToken() {
    return window.MasakoAuth?.token || null;
}

function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getAuthToken();
    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
    } else if (!token) {
        console.warn(`[API] Missing token for request to ${path}. MasakoAuth.token is null.`);
    }

    if (options.body !== undefined && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }

    if (typeof MASAKO_DEBUG !== 'undefined' && MASAKO_DEBUG) {
        console.log(`[API] Fetching ${path}`, { method: options.method || 'GET', hasToken: !!token });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    return fetch(normalizeApiPath(path), { ...options, headers, signal: controller.signal })
        .then(res => {
            clearTimeout(timeoutId);
            if (typeof MASAKO_DEBUG !== 'undefined' && MASAKO_DEBUG) {
                console.log(`[API] Response from ${path}: ${res.status}`);
            }
            return res;
        })
        .catch(err => {
            clearTimeout(timeoutId);
            throw err;
        });
}

if (typeof window !== 'undefined') {
    window.apiFetch = apiFetch;
    window.normalizeApiPath = normalizeApiPath;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizeApiPath };
}
