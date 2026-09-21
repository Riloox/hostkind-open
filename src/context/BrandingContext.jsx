import { createContext, useContext, useState, useMemo } from 'react';

// Split out of AuthContext (AuthContext.jsx:78): panel identity is not
// authentication. It arrives on the same /api/auth-mode bootstrap call, but it
// now owns its own provider so branding/theme reads never re-render auth
// consumers and auth churn never re-renders branding consumers. AuthContext
// re-exports these hooks, so existing imports keep working unchanged.
const BrandingContext = createContext(null);

// What the panel calls itself before /api/auth-mode answers, and if it ever
// fails to. Keeping the shape complete means no consumer needs a null check.
export const NO_BRANDING = Object.freeze({ name: '', logoUrl: '', faviconUrl: '', supportUrl: '', legalFooter: '', accent: null });

export function BrandingProvider({ children }) {
  // Branding comes from the /api/auth-mode bootstrap call because the login
  // screen needs it: it renders before any token exists, and a white-labelled
  // panel must not flash someone else's wordmark on the way in.
  const [branding, setBranding] = useState(NO_BRANDING);
  // When false (the default) the login page will NOT call ipify.org or any
  // external service to auto-detect the client's IP / language.
  const [geoLanguageDetection, setGeoLanguageDetection] = useState(false);
  const [gameThemes, setGameThemes] = useState({});
  const [gameAccents, setGameAccents] = useState({});

  const value = useMemo(
    () => ({
      branding, setBranding,
      geoLanguageDetection, setGeoLanguageDetection,
      gameThemes, setGameThemes,
      gameAccents, setGameAccents,
    }),
    [branding, geoLanguageDetection, gameThemes, gameAccents],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBrandingContext() {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('branding hooks must be used within a BrandingProvider');
  return ctx;
}

/*
 * Branding is not authentication, but it arrives on the auth bootstrap call and
 * splitting it into its own provider would mean fetching /api/auth-mode twice.
 * This hook is the seam: everything that renders the panel's identity asks for
 * it here and never learns where it came from.
 */
export function useBranding() {
  return useBrandingContext().branding || NO_BRANDING;
}
export function useGameThemes() { return useBrandingContext().gameThemes || {}; }
export function useGameAccents() { return useBrandingContext().gameAccents || {}; }
