// Context-free HTTP plumbing for the panel API.
//
// `useApi` (src/hooks/useApi.js) is the only authenticated caller and must
// stay the single place that attaches tokens, translates errors and handles
// 401s. But it cannot run above its own providers: the auth bootstrap in
// AuthContext and the pre-auth login screen have no Auth/I18n/Server context
// yet (and login must NOT get 401->logout semantics). Those callers use the
// helpers here so header/body conventions still can't drift between the two
// paths.

 // Unauthenticated JSON GET for pre-auth bootstrap calls (/api/auth-mode).
// Returns null on any failure (non-2xx, network error, bad JSON) so callers
// keep their existing "no data, carry on" behavior without try/catch chains.
export async function publicJson(path, init = {}) {
  try {
    const r = await fetch(path, init);
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}
