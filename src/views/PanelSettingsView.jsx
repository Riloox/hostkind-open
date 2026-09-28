import { lazy, Suspense } from 'react';
import { SectionTabs } from '@/components/layout/SectionTabs';
import { Loading } from '@/components/shared/Loading';
import { useAuth, useBranding } from '@/context/AuthContext';
import { useT } from '@/context/I18nContext';
import { PANEL_TABS } from '@/lib/routes';
import { visiblePanelTabs } from '@/lib/panel';

// Each tab is its own lazy chunk, so opening Preferences does not load the
// audit log.
const Preferences = lazy(() => import('@/views/panel/Preferences').then((m) => ({ default: m.Preferences })));
const UsersView = lazy(() => import('@/views/UsersView').then((m) => ({ default: m.UsersView })));
const AuditView = lazy(() => import('@/views/AuditView').then((m) => ({ default: m.AuditView })));
const ApplicationUpdateSection = lazy(() => import('@/components/shared/ApplicationUpdate').then((m) => ({ default: m.ApplicationUpdateSection })));

// Label and content of each tab, keyed by the names in PANEL_TABS.
const PANELS = {
  preferences: { labelKey: 'panelSettings.preferences', render: () => <Preferences /> },
  users: { labelKey: 'nav.users', render: () => <UsersView /> },
  audit: { labelKey: 'nav.audit', render: () => <AuditView /> },
  updates: { labelKey: 'panelSettings.updates', render: () => <div className="max-w-xl"><ApplicationUpdateSection /></div> },
};

/**
 * Hostkind settings (`/settings[/<tab>]`): everything about the panel rather
 * than one server. Each tab is a URL; a tab this user may not see, or none,
 * opens Preferences (the shell also rewrites such a URL).
 */
export function PanelSettingsView({ tab, onTab }) {
  const t = useT();
  const { user, hasCapability } = useAuth();
  const branding = useBranding();
  const tabs = visiblePanelTabs(PANEL_TABS.filter((name) => PANELS[name]), {
    isAdmin: user?.role === 'admin',
    can: (capability) => hasCapability(capability),
  });
  const current = tabs.includes(tab) ? tab : tabs[0];

  return (
    <div className="space-y-5">
      <SectionTabs
        tabs={tabs.map((name) => ({ tab: name, labelKey: PANELS[name].labelKey }))}
        value={current}
        onChange={onTab}
        label={t('nav.panelSettings', { name: branding.name || t('brand.name') })}
      />
      <Suspense fallback={<Loading size="lg" className="py-24" />}>
        <div key={current}>{PANELS[current].render()}</div>
      </Suspense>
    </div>
  );
}
