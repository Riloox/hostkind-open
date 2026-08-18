import { useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useI18n } from '@/context/I18nContext';

// Posts `body` to `path` and parses the response as NDJSON, calling `onEvent`
// for every newline-delimited JSON object the server emits. Resolves with the
// final `done` payload (a `{ ok, server }`-shaped object) or rejects with the
// `error` payload's message. The returned controller can be used to abort the
// in-flight request from the UI (e.g. a Cancel button).
export function useApiStream() {
  const { token, logout } = useAuth();
  const { t } = useI18n();

  const stream = useCallback(async (path, { body, onEvent, signal } = {}) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, {
      method: 'POST',
      headers,
      body: body && !(body instanceof FormData) ? JSON.stringify(body) : body,
      signal,
    });
    if (r.status === 401) {
      logout();
      throw new Error(t('common.sessionExpired'));
    }
    if (!r.ok || !r.body) {
      let msg;
      try {
        const data = await r.json();
        msg = data && data.error;
      } catch { /* not JSON */ }
      throw new Error(msg || t('common.httpError', { status: r.status }));
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let doneSeen = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (onEvent) onEvent(evt);
        if (evt && evt.type === 'done') { doneSeen = true; return evt; }
        if (evt && evt.type === 'error') throw new Error(evt.error || 'Server error');
      }
    }
    if (doneSeen) return null;
    throw new Error('Server closed the connection before completion');
  }, [token, logout, t]);

  return stream;
}
