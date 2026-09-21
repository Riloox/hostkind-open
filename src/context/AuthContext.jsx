import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import { isJwtExpired } from '@/lib/utils';
import { applyBranding } from '@/lib/branding';
import { publicJson } from '@/lib/apiClient';
import { BrandingProvider, NO_BRANDING, useBrandingContext } from '@/context/BrandingContext';

// Compatibility seam: panel identity (branding/gameThemes/accents/
// geoLanguageDetection) now owns its own provider in BrandingContext, so
// branding reads never re-render auth consumers and vice versa. The hooks are
// re-exported here, so existing imports from '@/context/AuthContext' keep
// working unchanged.
export { BrandingProvider, NO_BRANDING, useBranding, useGameThemes, useGameAccents } from '@/context/BrandingContext';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  return (
    <BrandingProvider>
      <AuthInner>{children}</AuthInner>
    </BrandingProvider>
  );
}

function AuthInner({ children }) {
  const {
    branding, setBranding,
    geoLanguageDetection, setGeoLanguageDetection,
    gameThemes, setGameThemes,
    gameAccents, setGameAccents,
  } = useBrandingContext();
  const [token, setToken] = useState(() => localStorage.getItem('fleetdeck_token') || '');
  const [user, setUser] = useState(null);
  // Discovered once on boot from the unauthenticated /api/auth-mode endpoint.
  // authChecked gates the whole app so the login screen never flashes while
  // we find out sign-in is off.
  const [authDisabled, setAuthDisabled] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  // Pre-login default language (server's DEFAULT_LANGUAGE env, "en"/"es"),
  // discovered from the same bootstrap call. Only used before sign-in and
  // only when the browser has no explicitly-saved language preference.
  const [defaultLanguage, setDefaultLanguage] = useState(null);

  // Unauthenticated bootstrap: useApi is unusable here (this provider sits
  // above the Auth/I18n/Server contexts it needs), so the shared context-free
  // helper performs the call. It sends no Authorization header - identical to
  // the raw fetch it replaces.
  useEffect(() => {
    let alive = true;
    publicJson('/api/auth-mode')
      .then((data) => {
        if (!alive || !data) return;
        if (data.authRequired === false) setAuthDisabled(true);
        if (data.defaultLanguage) setDefaultLanguage(data.defaultLanguage);
        if (data.branding) {
          setBranding({ ...NO_BRANDING, ...data.branding });
          applyBranding(data.branding);
        }
        if (data.geoLanguageDetection === true) setGeoLanguageDetection(true);
        if (data.gameThemes) setGameThemes(data.gameThemes);
        if (data.gameAccents) setGameAccents(data.gameAccents);
      })
      .catch(() => {})
      .finally(() => { if (alive) setAuthChecked(true); });
    return () => { alive = false; };
  }, [setBranding, setGeoLanguageDetection, setGameThemes, setGameAccents]);

  const login = useCallback((newToken, newUser) => {
    localStorage.setItem('fleetdeck_token', newToken);
    setToken(newToken);
    setUser(newUser || null);
  }, []);

  // Clears the guest flag too: a 401 means sign-in is back on server-side,
  // so the next render must send the visitor to the login screen.
  const logout = useCallback(() => {
    localStorage.removeItem('fleetdeck_token');
    setToken('');
    setUser(null);
    setAuthDisabled(false);
  }, []);

  const isLoggedIn = authDisabled || (!!token && !isJwtExpired(token));
  const hasCapability = useCallback((capability, serverId = null) => {
    if (user?.role === 'admin' || user?.permissions?.admin) return true;
    return !!user?.permissions?.grants?.some((grant) => grant.capability === capability && (grant.serverId || null) === (serverId || null));
  }, [user]);

  const value = useMemo(() => ({
    token, user, setUser, login, logout, isLoggedIn, hasCapability, authDisabled, authChecked, defaultLanguage,
    branding, gameThemes, setGameThemes, gameAccents, setGameAccents, geoLanguageDetection,
  }), [
    token, user, login, logout, isLoggedIn, hasCapability, authDisabled, authChecked, defaultLanguage,
    branding, gameThemes, gameAccents, geoLanguageDetection, setGameThemes, setGameAccents,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
