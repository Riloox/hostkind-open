import { Suspense, useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loading } from '@/components/shared/Loading';
import { SectionPageContext } from '@/components/layout/Page';
import { useT } from '@/context/I18nContext';
import { useSectionContext } from '@/hooks/useSections';
import { visibleTabs, resolveTab } from '@/lib/sections';

/**
 * The tab bar of a section (Mods, Worlds, Settings). Each tab is a URL, so
 * choosing one navigates. A section with a single tab for this server shows no
 * bar at all: one tab is not a choice.
 */
export function SectionTabs({ tabs, value, onChange, label }) {
  const t = useT();
  if (!tabs || tabs.length < 2) return null;
  return (
    <Tabs value={value} onValueChange={onChange}>
      {/* Scrolls sideways rather than spilling off a narrow screen. */}
      <TabsList aria-label={label} data-section-tabs className="max-w-full overflow-x-auto">
        {tabs.map((entry) => (
          <TabsTrigger key={entry.tab} value={entry.tab} data-section-tab={entry.tab}>
            {t(entry.labelKey)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * A tabbed section: the tabs this server has, then the open one. `panels`
 * maps each tab name to a function rendering it, so only the open tab mounts.
 * The URL may name no tab, or one this server lacks; either way the section
 * opens on its first tab. `notice(tab)` may add a line between the bar and
 * the page (e.g. FirstStartNotice). The page's ViewHeader learns from
 * SectionPageContext whether the bar already names it.
 */
export function TabbedSection({ view, tab, onTab, panels, notice }) {
  const t = useT();
  const ctx = useSectionContext();
  const tabs = visibleTabs(view, ctx);
  const current = resolveTab(view, tab, ctx);
  const render = current ? panels[current] : null;
  const tabBar = tabs.length > 1;
  // The open page's actions (ViewHeader) render into this spot at the end of
  // the tab bar's row, instead of on a row of their own under it.
  const [actionsSlot, setActionsSlot] = useState(null);
  const page = useMemo(() => ({ view, tabBar, onTab, actionsSlot }), [view, tabBar, onTab, actionsSlot]);
  return (
    <div className="space-y-5">
      {tabBar ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTabs tabs={tabs} value={current} onChange={onTab} label={t(`nav.${view}`)} />
          <div ref={setActionsSlot} data-section-actions className="flex flex-wrap items-center gap-2 empty:hidden" />
        </div>
      ) : null}
      {current && notice ? notice(current) : null}
      <Suspense fallback={<Loading size="lg" className="py-24" />}>
        {render ? (
          <SectionPageContext.Provider value={page}>
            <div key={current}>{render()}</div>
          </SectionPageContext.Provider>
        ) : null}
      </Suspense>
    </div>
  );
}
