import { lazy } from 'react';
import { TabbedSection } from '@/components/layout/SectionTabs';
import { useServer } from '@/context/ServerContext';
import { FirstStartNotice } from '@/components/shared/FirstStartNotice';

// The sections that merge several older pages behind tabs. Each tab's page is
// its own lazy chunk, so opening Mods does not load the Settings editors.
const AddonsView = lazy(() => import('@/views/AddonsView').then((m) => ({ default: m.AddonsView })));
const TerrariaModsView = lazy(() => import('@/views/TerrariaModsView').then((m) => ({ default: m.TerrariaModsView })));
const ContentView = lazy(() => import('@/views/ModrinthView').then((m) => ({ default: m.ContentView })));
const UpdatesView = lazy(() => import('@/views/UpdatesView').then((m) => ({ default: m.UpdatesView })));
const WorldsView = lazy(() => import('@/views/WorldsView').then((m) => ({ default: m.WorldsView })));
const MapView = lazy(() => import('@/views/MapView').then((m) => ({ default: m.MapView })));
const ConfigsView = lazy(() => import('@/views/ConfigsView').then((m) => ({ default: m.ConfigsView })));
const GeneralSettings = lazy(() => import('@/views/settings/GeneralSettings').then((m) => ({ default: m.GeneralSettings })));
const FileManagerView = lazy(() => import('@/views/FileManagerView').then((m) => ({ default: m.FileManagerView })));

// Pages that show what the server generates on its first start.
const firstStartNotice = () => <FirstStartNotice />;
const SETTINGS_CONTENT_TABS = new Set(['game', 'files']);

/** Mods: what is installed, the catalogue to add from, and updates for both. */
export function ModsSection({ tab, onTab }) {
  const { supports } = useServer();
  return (
    <TabbedSection
      view="mods"
      tab={tab}
      onTab={onTab}
      notice={firstStartNotice}
      panels={{
        installed: () => (supports('terraria-mods') ? <TerrariaModsView /> : <AddonsView />),
        browse: () => <ContentView />,
        // UpdatesView picks plugin updates here: only servers with a
        // catalogue get this tab (src/lib/sections.js).
        updates: () => <UpdatesView />,
      }}
    />
  );
}

/** Worlds, and the map of them where the game has one. */
export function WorldsSection({ tab, onTab }) {
  return (
    <TabbedSection
      view="worlds"
      tab={tab}
      onTab={onTab}
      notice={firstStartNotice}
      panels={{
        worlds: () => <WorldsView />,
        map: () => <MapView />,
      }}
    />
  );
}

/**
 * Settings: the game's own settings first, then the server's profile, its
 * game build (Palworld, Valheim) and, last, raw files.
 */
export function SettingsSection({ tab, onTab, onRefresh }) {
  return (
    <TabbedSection
      view="settings"
      tab={tab}
      onTab={onTab}
      notice={(current) => (SETTINGS_CONTENT_TABS.has(current) ? <FirstStartNotice /> : null)}
      panels={{
        game: () => <ConfigsView />,
        general: () => <GeneralSettings onRefresh={onRefresh} />,
        // UpdatesView picks the game build view for Palworld and Valheim.
        version: () => <UpdatesView />,
        files: () => <FileManagerView />,
      }}
    />
  );
}
