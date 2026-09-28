import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useT } from '@/context/I18nContext';

function Page({ className, children }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1680px] space-y-6', className)}>
      {children}
    </div>
  );
}

// Set by a tabbed section (SectionTabs.jsx) around its open tab: which
// section it is, whether its tab bar is showing, `onTab(tab)` to open a
// sibling tab (an empty Installed list links to Browse), and the element on
// the tab bar's row that the page's actions render into.
const SectionPageContext = createContext(null);

/** The tabbed section this page sits in, or null. */
function useSectionPage() {
  return useContext(SectionPageContext);
}

/**
 * ViewHeader - a page's title and its page-level actions. The app header
 * already names the server and its game, so there is no "where am I" line
 * here, and no explainer paragraph: a page that needs one gets renamed.
 *
 * Inside a tabbed section the tab bar names the page, so only the actions
 * remain. When the bar is hidden (the section has one tab for this server),
 * the title is the section's own name, never a second name for it.
 */
function ViewHeader({ title, actions, className }) {
  const t = useT();
  const section = useContext(SectionPageContext);
  const resolvedTitle = section ? (section.tabBar ? null : t(`nav.${section.view}`)) : title;
  if (!resolvedTitle && !actions) return null;
  // Under a tab bar the actions join its row (SectionTabs.jsx).
  if (!resolvedTitle && section?.actionsSlot) return createPortal(actions, section.actionsSlot);
  return (
    <section
      data-view-header
      className={cn(
        'flex flex-wrap items-center gap-3',
        resolvedTitle ? 'justify-between' : 'justify-end',
        className,
      )}
    >
      {resolvedTitle && (
        <h2 className="min-w-0 overflow-wrap-anywhere font-display text-xl font-extrabold tracking-tight text-foreground">
          {resolvedTitle}
        </h2>
      )}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </section>
  );
}

export { Page, ViewHeader, SectionPageContext, useSectionPage };
