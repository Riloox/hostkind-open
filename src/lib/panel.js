// Who sees each tab of Hostkind settings (the tab names are PANEL_TABS in
// src/lib/routes.js). One place, so the page's tab bar and the shell's URL
// guard never disagree about it. The API enforces its own checks either way.
//
// `capability` is a user grant; admins hold every grant. `admin` needs the
// admin role itself: an application update replaces the program everyone
// signed in is using. A tab with no rule is for everyone.
const PANEL_TAB_RULES = {
  users: { capability: 'users.manage' },
  audit: { capability: 'audit.view' },
  updates: { admin: true },
};

/** Whether this user sees a tab. `ctx` is `{ isAdmin, can(capability) }`. */
export function panelTabAllowed(tab, { isAdmin, can }) {
  const rule = PANEL_TAB_RULES[tab];
  if (!rule) return true;
  if (rule.admin) return !!isAdmin;
  return !!isAdmin || !!can(rule.capability);
}

/** The tabs of `tabs` this user sees, in order. */
export function visiblePanelTabs(tabs, ctx) {
  return tabs.filter((tab) => panelTabAllowed(tab, ctx));
}
