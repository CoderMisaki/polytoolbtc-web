/* googleAuth.js — Masako authentication controller (Supabase Auth).
 *
 * Login is OPTIONAL. The terminal is fully usable while signed out: market
 * data, chart, indicators, the animal neural system and demo positions all run
 * locally and persist to `localStorage`. Signing in additionally mirrors demo
 * positions to the backend so they survive across devices.
 *
 * Supported flows: email/password sign-in, email/password sign-up, password
 * reset and (legacy) Google OAuth.
 *
 * Lifecycle guarantees:
 *   - exactly ONE `onAuthStateChange` subscription, released by `dispose()`;
 *   - every timer created here is tracked and cleared;
 *   - `phase` always resolves (LOADING -> AUTHENTICATED | UNAUTHENTICATED |
 *     ERROR), so no caller can wait forever on the auth state;
 *   - no repeated auth requests: the SDK's INITIAL_SESSION event is the single
 *     source of truth, `getSession()` is only a bounded fallback.
 */
(function initMasakoAuth(windowObj) {
    const AUTH_PHASE = {
        LOADING: 'LOADING',
        AUTHENTICATED: 'AUTHENTICATED',
        UNAUTHENTICATED: 'UNAUTHENTICATED',
        ERROR: 'ERROR'
    };

    // Bounds the LOADING phase even when the SDK/CDN misbehaves. Login is
    // optional, so timing out into UNAUTHENTICATED is always a safe outcome.
    const INITIAL_EVENT_TIMEOUT_MS = 4000;
    const SESSION_FALLBACK_TIMEOUT_MS = 3000;

    const AuthState = {
        client: null,
        session: null,
        onChange: null,
        phase: AUTH_PHASE.LOADING,
        error: null,
        subscription: null,
        unsubscribe: null,
        timers: new Set(),
        initPromise: null,
        disposed: false
    };

    function trackTimer(id) {
        if (id === null || id === undefined) return null;
        AuthState.timers.add(id);
        return id;
    }

    function clearTimer(id) {
        if (id === null || id === undefined) return;
        try { windowObj.clearTimeout(id); } catch (e) { /* noop */ }
        AuthState.timers.delete(id);
    }

    function clearAllTimers() {
        AuthState.timers.forEach((id) => {
            try { windowObj.clearTimeout(id); } catch (e) { /* noop */ }
        });
        AuthState.timers.clear();
    }

    function describeError(err) {
        const message = String((err && err.message) || err || 'Unknown error');
        if (/invalid login credentials/i.test(message)) return 'Email atau password salah.';
        if (/email not confirmed/i.test(message)) return 'Email belum dikonfirmasi. Cek inbox kamu.';
        if (/user already registered/i.test(message)) return 'Email sudah terdaftar. Silakan login.';
        if (/rate limit/i.test(message)) return 'Terlalu banyak percobaan. Coba lagi sebentar.';
        if (/password should be at least/i.test(message)) return 'Password minimal 6 karakter.';
        if (/unable to validate email/i.test(message)) return 'Format email tidak valid.';
        return message;
    }

    function applySession(session, phaseOverride, errorOverride) {
        if (AuthState.disposed) return;
        const previousUserId = AuthState.session?.user?.id || null;
        const nextUserId = session?.user?.id || null;
        AuthState.session = session || null;
        AuthState.error = errorOverride || null;

        const isAuthenticated = Boolean(session && session.access_token);
        AuthState.phase = phaseOverride
            || (isAuthenticated ? AUTH_PHASE.AUTHENTICATED : AUTH_PHASE.UNAUTHENTICATED);

        windowObj.MasakoAuth = Object.assign(windowObj.MasakoAuth || {}, {
            user: (session && session.user) || null,
            token: (session && session.access_token) || null,
            email: (session && session.user && session.user.email) || null,
            isAuthenticated: isAuthenticated,
            phase: AuthState.phase,
            error: AuthState.error
        });
        if (previousUserId !== nextUserId && windowObj.FuturesEngine?.onAuthChanged) {
            windowObj.FuturesEngine.onAuthChanged(nextUserId);
        }

        if (typeof AuthState.onChange === 'function') {
            try { AuthState.onChange(windowObj.MasakoAuth); }
            catch (e) { console.error('[Auth] onAuthChange handler failed', e); }
        }
    }

    function cleanUrlToken() {
        try {
            if (windowObj.location.hash || windowObj.location.search) {
                windowObj.history.replaceState(null, '', windowObj.location.pathname);
            }
        } catch (e) { /* noop */ }
    }

    function subscribeAuthEvents(client) {
        let receivedEvent = false;
        const result = client.auth.onAuthStateChange((event, session) => {
            receivedEvent = true;
            clearTimer(AuthState.initialTimer);
            AuthState.initialTimer = null;

            if (session) {
                applySession(session);
                if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') cleanUrlToken();
            } else if (event === 'SIGNED_OUT') {
                applySession(null);
            } else if (event === 'INITIAL_SESSION') {
                // No persisted session: resolve immediately as signed out.
                applySession(null);
            }
            // TOKEN_REFRESHED / USER_UPDATED with a null session keep the
            // current phase instead of flapping the UI.
        });

        const subscription = result && result.data ? result.data.subscription : null;
        AuthState.subscription = subscription;
        AuthState.unsubscribe = subscription && typeof subscription.unsubscribe === 'function'
            ? () => subscription.unsubscribe()
            : null;

        // Bounded fallback for SDK builds that never emit INITIAL_SESSION.
        AuthState.initialTimer = trackTimer(windowObj.setTimeout(() => {
            AuthState.initialTimer = null;
            if (receivedEvent || AuthState.disposed) return;
            client.auth.getSession().then(({ data }) => {
                if (AuthState.disposed) return;
                applySession(data && data.session ? data.session : null);
            }).catch((err) => {
                if (AuthState.disposed) return;
                applySession(null, AUTH_PHASE.ERROR, describeError(err));
            });
        }, INITIAL_EVENT_TIMEOUT_MS));
    }

    async function initSupabaseAuth({ url, anonKey, onAuthChange } = {}) {
        if (AuthState.initPromise) return AuthState.initPromise;

        AuthState.initPromise = (async () => {
            AuthState.onChange = onAuthChange || null;
            if (!url || !anonKey) {
                applySession(null, AUTH_PHASE.ERROR, 'Konfigurasi Supabase tidak tersedia.');
                return windowObj.MasakoAuth;
            }
            if (!windowObj.supabase || typeof windowObj.supabase.createClient !== 'function') {
                applySession(null, AUTH_PHASE.ERROR, 'Supabase SDK belum dimuat.');
                return windowObj.MasakoAuth;
            }

            try {
                AuthState.client = windowObj.supabase.createClient(url, anonKey, {
                    auth: {
                        autoRefreshToken: true,
                        persistSession: true,
                        detectSessionInUrl: true
                    }
                });
                subscribeAuthEvents(AuthState.client);
            } catch (err) {
                applySession(null, AUTH_PHASE.ERROR, describeError(err));
            }

            // Hard stop for the LOADING phase.
            trackTimer(windowObj.setTimeout(() => {
                if (AuthState.disposed || AuthState.phase !== AUTH_PHASE.LOADING) return;
                applySession(null, AUTH_PHASE.UNAUTHENTICATED, null);
            }, INITIAL_EVENT_TIMEOUT_MS + SESSION_FALLBACK_TIMEOUT_MS));

            return windowObj.MasakoAuth;
        })();

        return AuthState.initPromise;
    }

    async function signInWithPassword(email, password) {
        if (!AuthState.client) return { ok: false, error: 'Auth belum siap.' };
        try {
            const { data, error } = await AuthState.client.auth.signInWithPassword({ email, password });
            if (error) return { ok: false, error: describeError(error) };
            if (data && data.session) applySession(data.session);
            return { ok: true, user: (data && data.user) || null };
        } catch (err) {
            return { ok: false, error: describeError(err) };
        }
    }

    async function signUp(email, password) {
        if (!AuthState.client) return { ok: false, error: 'Auth belum siap.' };
        try {
            const { data, error } = await AuthState.client.auth.signUp({
                email,
                password,
                options: { emailRedirectTo: windowObj.location.origin + '/' }
            });
            if (error) return { ok: false, error: describeError(error) };
            if (data && data.session) {
                applySession(data.session);
                return { ok: true, user: data.user || null, needsEmailConfirmation: false };
            }
            return { ok: true, user: (data && data.user) || null, needsEmailConfirmation: true };
        } catch (err) {
            return { ok: false, error: describeError(err) };
        }
    }

    async function resetPassword(email) {
        if (!AuthState.client) return { ok: false, error: 'Auth belum siap.' };
        try {
            const { error } = await AuthState.client.auth.resetPasswordForEmail(email, {
                redirectTo: windowObj.location.origin + '/'
            });
            if (error) return { ok: false, error: describeError(error) };
            return { ok: true };
        } catch (err) {
            return { ok: false, error: describeError(err) };
        }
    }

    async function signInWithGoogle() {
        if (!AuthState.client) return { ok: false, error: 'Auth belum siap.' };
        try {
            const { error } = await AuthState.client.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: windowObj.location.origin + '/' }
            });
            if (error) return { ok: false, error: describeError(error) };
            return { ok: true };
        } catch (err) {
            return { ok: false, error: describeError(err) };
        }
    }

    async function signOut() {
        // Stop in-flight account callbacks immediately, not after the SDK's
        // network sign-out completes. The portfolio itself is left untouched.
        applySession(null);
        if (windowObj.MarketFeed && windowObj.MarketFeed.stop) windowObj.MarketFeed.stop();
        // Sign-out ends the SESSION; it must not destroy the demo portfolio.
        // The old blanket wipe of every `masako_*` key deleted positions, the
        // ledger and preferences together — one accidental signOut and the
        // whole trading history was gone with no recovery path. Auth state
        // itself lives in the Supabase session (`sb-*` keys) which
        // `client.auth.signOut()` below clears. Demo positions mirrored while
        // signed in are recoverable from the account; locally-only state
        // survives as plain demo state and is reconciled on the next sign-in.
        if (AuthState.client) {
            try { await AuthState.client.auth.signOut(); }
            catch (err) { console.warn('Supabase signOut gagal:', err); }
        }
        applySession(null);
        windowObj.__MASAKO_APP_STARTED__ = false;
        windowObj.location.reload();
    }

    /** Release the SDK subscription and every timer owned by this module. */
    function dispose() {
        AuthState.disposed = true;
        clearAllTimers();
        try { if (AuthState.unsubscribe) AuthState.unsubscribe(); } catch (e) { /* noop */ }
        AuthState.unsubscribe = null;
        AuthState.subscription = null;
        AuthState.onChange = null;
        AuthState.client = null;
    }

    windowObj.MasakoAuth = {
        AUTH_PHASE,
        initSupabaseAuth,
        signInWithPassword,
        signUp,
        resetPassword,
        signInWithGoogle,
        signOut,
        dispose,
        user: null,
        token: null,
        email: null,
        isAuthenticated: false,
        phase: AUTH_PHASE.LOADING,
        error: null,
        isLoading: () => AuthState.phase === AUTH_PHASE.LOADING,
        isReady: () => AuthState.phase !== AUTH_PHASE.LOADING
    };

    if (typeof windowObj.addEventListener === 'function') {
        // A page that is being unloaded must not keep the SDK subscription or
        // pending timers alive.
        windowObj.addEventListener('pagehide', dispose, { once: true });
    }
})(window);

let authUiBound = false;

window.setupAuthUI = function setupAuthUI() {
    // Idempotent: the overlay lives for the whole page lifetime, so binding it
    // twice would fire every handler twice (double submit, double sign-out).
    if (authUiBound) return;
    const overlay = document.getElementById('auth-overlay');
    if (!overlay) return;
    authUiBound = true;
    const logoutBtn = document.getElementById('btn-logout');
    const loginTriggerBtn = document.getElementById('btn-login-trigger');
    const settingsBtn = document.getElementById('btn-open-settings');

    const form = document.getElementById('auth-email-form');
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const submitBtn = document.getElementById('auth-submit');
    const modeToggle = document.getElementById('auth-mode-toggle');
    const resetBtn = document.getElementById('auth-forgot');
    const messageEl = document.getElementById('auth-message');
    const googleBtn = document.getElementById('btn-login-google');

    let mode = 'login';

    const setMessage = (text, isError) => {
        if (!messageEl) return;
        messageEl.textContent = text || '';
        messageEl.classList.toggle('is-error', !!isError);
        messageEl.classList.toggle('is-hidden', !text);
    };

    const setBusy = (busy) => {
        if (submitBtn) {
            submitBtn.disabled = !!busy;
            submitBtn.textContent = busy ? 'Memproses...' : (mode === 'login' ? 'Login' : 'Daftar');
        }
    };

    const applyMode = (next) => {
        mode = next === 'register' ? 'register' : 'login';
        if (submitBtn) submitBtn.textContent = mode === 'login' ? 'Login' : 'Daftar';
        if (modeToggle) modeToggle.textContent = mode === 'login'
            ? 'Belum punya akun? Daftar'
            : 'Sudah punya akun? Login';
        setMessage('');
    };

    const syncAccountUi = (auth) => {
        const isAuthed = Boolean(auth && auth.isAuthenticated);
        if (window.FuturesEngine && window.FuturesEngine.syncOpenPositionButtons) {
            window.FuturesEngine.syncOpenPositionButtons();
        }
        if (overlay && isAuthed) overlay.classList.remove('active');
        if (logoutBtn) logoutBtn.classList.toggle('is-hidden', !isAuthed);
        if (loginTriggerBtn) loginTriggerBtn.classList.toggle('is-hidden', isAuthed);
        // Settings (Auto Backtest AI, winrate, data pola) belong to logged-in
        // email accounts, so the gear only appears once a session exists.
        if (settingsBtn) settingsBtn.classList.toggle('is-hidden', !isAuthed);
        try {
            if (window.AutoBacktestAI && typeof window.AutoBacktestAI.setUser === 'function') {
                window.AutoBacktestAI.setUser(auth);
            }
        } catch (e) { /* settings module is optional */ }
        try {
            if (isAuthed && window.AutoBacktestAI && typeof window.AutoBacktestAI.renderPanel === 'function') {
                window.AutoBacktestAI.renderPanel();
            }
        } catch (e) { /* panel is best-effort */ }
    };

    const openOverlay = () => {
        if (overlay) overlay.classList.add('active');
        if (emailInput) emailInput.focus();
    };

    const closeOverlay = () => {
        if (overlay) overlay.classList.remove('active');
        setMessage('');
    };

    const bootApp = () => {
        // The app boots independently of auth (see `startTerminalOnce` in
        // main.js); this only covers the case where auth resolves first.
        if (typeof window.startTerminalOnce === 'function') {
            window.startTerminalOnce();
            return;
        }
        if (window.__MASAKO_APP_STARTED__) return;
        window.__MASAKO_APP_STARTED__ = true;
        if (typeof window.initApp === 'function') window.initApp();
    };

    window.MasakoAuth.initSupabaseAuth({
        url: window.SUPABASE_URL,
        anonKey: window.SUPABASE_PUBLISHABLE_KEY || window.SUPABASE_ANON_KEY,
        onAuthChange: (auth) => {
            syncAccountUi(auth);
            bootApp();
            if (auth && auth.isAuthenticated && window.FuturesEngine
                && typeof window.FuturesEngine.syncStateFromServer === 'function') {
                window.FuturesEngine.syncStateFromServer();
            }
        }
    }).catch((err) => {
        console.error('Auth init gagal:', err);
        syncAccountUi({ isAuthenticated: false });
        bootApp();
    });

    if (loginTriggerBtn) loginTriggerBtn.addEventListener('click', openOverlay);
    if (overlay) {
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) closeOverlay();
        });
    }
    const closeBtn = document.getElementById('auth-close');
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

    if (modeToggle) modeToggle.addEventListener('click', () => applyMode(mode === 'login' ? 'register' : 'login'));

    if (form) {
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const email = (emailInput && emailInput.value ? emailInput.value : '').trim();
            const password = passwordInput && passwordInput.value ? passwordInput.value : '';
            if (!email || !password) {
                setMessage('Email dan password wajib diisi.', true);
                return;
            }
            setBusy(true);
            setMessage('');
            const result = mode === 'login'
                ? await window.MasakoAuth.signInWithPassword(email, password)
                : await window.MasakoAuth.signUp(email, password);
            setBusy(false);
            if (!result.ok) {
                setMessage(result.error || 'Autentikasi gagal.', true);
                return;
            }
            if (result.needsEmailConfirmation) {
                setMessage('Akun dibuat. Cek email kamu untuk konfirmasi, lalu login.');
                applyMode('login');
                return;
            }
            if (passwordInput) passwordInput.value = '';
            closeOverlay();
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            const email = (emailInput && emailInput.value ? emailInput.value : '').trim();
            if (!email) {
                setMessage('Isi email terlebih dahulu untuk reset password.', true);
                return;
            }
            const result = await window.MasakoAuth.resetPassword(email);
            setMessage(result.ok
                ? 'Email reset password dikirim.'
                : (result.error || 'Gagal mengirim email reset.'), !result.ok);
        });
    }

    if (googleBtn) {
        googleBtn.addEventListener('click', async () => {
            const result = await window.MasakoAuth.signInWithGoogle();
            if (!result.ok) setMessage(result.error || 'Google login gagal.', true);
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await window.MasakoAuth.signOut();
            syncAccountUi({ isAuthenticated: false });
        });
    }

    applyMode('login');
    syncAccountUi(window.MasakoAuth);
};
