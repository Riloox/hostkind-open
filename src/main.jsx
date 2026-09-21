import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ServerProvider } from './context/ServerContext';
import { StatsProvider } from './context/StatsContext';
import { I18nProvider } from './context/I18nContext';
import './index.css';
// Root primitives (ember/coal/ink ramps). src/tokens.css only holds per-game
// overrides - without this import every unthemed surface loses its tokens.
import '../tokens.css';
import './tokens.css';

// Bridges AuthContext's /api/auth-mode result (which carries the server's
// DEFAULT_LANGUAGE) into I18nProvider, so the pre-login language can follow
// panel-wide config without a second network round trip.
function I18nBridge({ children }) {
  const { defaultLanguage } = useAuth();
  return <I18nProvider serverDefaultLang={defaultLanguage}>{children}</I18nProvider>;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <I18nBridge>
        <ServerProvider>
          <StatsProvider>
          <App />
          <Toaster
            theme="dark"
            position="bottom-right"
            className="fleetdeck-toaster"
            richColors
            closeButton
            duration={3500}
            gap={8}
            swipeDirections={['left', 'right', 'bottom']}
            toastOptions={{
              classNames: {
                toast: 'rounded border-2 shadow-none text-sm',
                title: 'font-bold font-display',
                closeButton: 'border-border bg-card text-muted-foreground hover:text-foreground',
              },
            }}
          />
          </StatsProvider>
        </ServerProvider>
      </I18nBridge>
    </AuthProvider>
  </React.StrictMode>
);
