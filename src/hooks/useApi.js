import { useCallback, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useI18n } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';

const DEFAULT_TIMEOUT_MS = 30000;

export function useApi() {
  const { token, logout } = useAuth();
  const { t } = useI18n();
  const { activeServerId } = useServer();
  // The server id rides in a ref so switching servers never invalidates the
  // `api` identity and cascades into every consumer's refetch effects.
  const serverIdRef = useRef(activeServerId);
  serverIdRef.current = activeServerId;

  const api = useCallback(async (path, opts = {}) => {
    const {
      timeout = DEFAULT_TIMEOUT_MS,
      signal: userSignal,
      serverScoped = true,
      serverId,
      silent,
      responseType,
      headers: optHeaders,
      body: optBody,
      ...fetchOpts
    } = opts;
    const headers = { ...optHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const scopedId = serverId ?? serverIdRef.current;
    if (scopedId && serverScoped !== false) headers['X-Hostkind-Server-Id'] = scopedId;
    let body = optBody;
    if (body != null && !(body instanceof FormData) && (typeof body === 'object' || Array.isArray(body))) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (userSignal) {
      if (userSignal.aborted) controller.abort();
      else userSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let timedOut = false;
    let timer = null;
    if (timeout != null && timeout !== Infinity && timeout > 0) {
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    }

    try {
      const r = await fetch(path, { ...fetchOpts, headers, body, signal: controller.signal });
      if (r.status === 401 && !silent) {
        logout();
        throw new Error(t('common.sessionExpired'));
      }
      // Blob downloads (audit CSV/JSON export, template export) reuse the same
      // auth headers and 401 handling; only the body parsing differs. Error
      // responses stay JSON, so fall through to the standard error path below.
      if (responseType === 'blob' && r.ok) return r.blob();
      // Parse by content type: a non-JSON body (proxy error page, gateway
      // timeout HTML, empty 204) must not silently become `{}` on failure -
      // keep the raw text so the thrown error still says something useful.
      const contentType = r.headers?.get?.('content-type') || '';
      let data;
      let rawText = '';
      if (contentType.includes('application/json')) {
        data = await r.json().catch(() => null);
        if (data == null) data = {};
      } else {
        rawText = await r.text().catch(() => '');
        if (!rawText) {
          data = {};
        } else {
          try { data = JSON.parse(rawText); }
          catch { data = {}; }
        }
      }
      if (!r.ok) {
        const rawError = data && typeof data === 'object' ? data.error : null;
        const fallback = rawError || rawText.trim().slice(0, 300) || r.statusText || '';
        const translated = typeof fallback === 'string' && fallback ? t(fallback) : '';
        const message = fallback && translated !== fallback
          ? translated
          : (fallback || t('common.httpError', { status: r.status }));
        const err = new Error(message);
        err.code = data?.code;
        err.status = r.status;
        throw err;
      }
      return data;
    } catch (e) {
      if (e?.name === 'AbortError') {
        // A caller-owned abort stays an AbortError; only our own timeout is
        // translated into a readable error.
        if (!timedOut && userSignal?.aborted) throw e;
        if (timedOut) {
          const key = 'common.requestTimeout';
          const translated = t(key);
          const err = new Error(translated !== key ? translated : `Request timed out after ${timeout}ms`);
          err.code = 'timeout';
          err.cause = e;
          throw err;
        }
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener?.('abort', onExternalAbort);
    }
  }, [token, logout, t]);

  return api;
}
