// What a server offers: which sections appear in its sidebar and which tabs
// each section shows. One place, so the sidebar, the shell's URL guards and the
// sections themselves never disagree about it.
//
// Every check takes a context `{ supports, can }`: `supports(capability)` asks
// the server's module (ServerContext), `can(capability)` asks the signed-in
// user's grants (AuthContext). A list of module capabilities means "any of".

const anyOf = (supports, list) => list.some((capability) => supports(capability));

function allowed(entry, { supports, can }) {
  if (entry.capability && !can(entry.capability)) return false;
  if (entry.module && !anyOf(supports, entry.module)) return false;
  if (entry.requires && !entry.requires.every((capability) => supports(capability))) return false;
  return true;
}

// Sections split into tabs. The first visible tab is the section's default.
export const SECTION_TABS = {
  worlds: [
    // Two world models, one tab: Minecraft's folder-per-world and Terraria's
    // or Valheim's file-per-world. A server declares whichever one it has.
    { tab: 'worlds', labelKey: 'sections.worlds', module: ['worlds', 'terraria-worlds', 'valheim-worlds'], capability: 'worlds.view' },
    { tab: 'map', labelKey: 'sections.map', module: ['map'] },
  ],
  mods: [
    { tab: 'installed', labelKey: 'sections.installed', module: ['addons', 'terraria-mods'] },
    { tab: 'browse', labelKey: 'sections.browse', module: ['content-install'] },
    // Plugin and mod updates. Only servers that install content from a
    // catalogue have any; a game build update is Settings → Version.
    { tab: 'updates', labelKey: 'sections.updates', module: ['updates'], requires: ['content-install'] },
  ],
  settings: [
    { tab: 'game', labelKey: 'sections.game', module: ['configs'] },
    { tab: 'general', labelKey: 'sections.general' },
    { tab: 'version', labelKey: 'sections.version', module: ['palworld-updates', 'valheim-updates'] },
    { tab: 'files', labelKey: 'sections.files', module: ['files'] },
  ],
};

// Sections without tabs, and what they need.
const VIEW_RULES = {
  console: { module: ['console'] },
  players: { module: ['players', 'terraria-tshock'], capability: 'players.view' },
  backups: { module: ['backups'] },
  tasks: { module: ['schedules'] },
};

// Where a tab goes when this server does not have it but has an equivalent.
// Old "updates" links meant plugin updates on Minecraft and the game build
// everywhere else.
const TAB_FALLBACKS = {
  'mods/updates': { view: 'settings', tab: 'version' },
};

/** The tabs of a section this server shows, in order. */
export function visibleTabs(view, ctx) {
  return (SECTION_TABS[view] || []).filter((entry) => allowed(entry, ctx));
}

/** Whether this server has a view at all. Views not listed here always exist. */
export function viewAvailable(view, ctx) {
  if (SECTION_TABS[view]) return visibleTabs(view, ctx).length > 0;
  const rule = VIEW_RULES[view];
  return rule ? allowed(rule, ctx) : true;
}

/** Whether this server shows a given tab of a section. */
export function tabAvailable(view, tab, ctx) {
  return visibleTabs(view, ctx).some((entry) => entry.tab === tab);
}

/** The tab a section opens on: the one asked for when it is shown, else the first. */
export function resolveTab(view, tab, ctx) {
  const tabs = visibleTabs(view, ctx);
  if (tab && tabs.some((entry) => entry.tab === tab)) return tab;
  return tabs[0]?.tab || null;
}

/**
 * Where a server location should go instead, or null when it can be shown as
 * it is. A tab the server lacks goes to its equivalent elsewhere when there is
 * one, else to the section's default tab; a section the server lacks goes to
 * the overview.
 */
export function settleSection(view, tab, ctx) {
  if (SECTION_TABS[view] && tab && !tabAvailable(view, tab, ctx)) {
    const fallback = TAB_FALLBACKS[`${view}/${tab}`];
    if (fallback && tabAvailable(fallback.view, fallback.tab, ctx)) return fallback;
    if (viewAvailable(view, ctx)) return { view, tab: null };
    return { view: 'dashboard', tab: null };
  }
  if (!viewAvailable(view, ctx)) return { view: 'dashboard', tab: null };
  return null;
}
