'use strict';

/*
 * Locators, in one place, so a copy or markup change is a one-line fix here
 * rather than a sweep through the specs.
 *
 * Text-based locators read their strings from i18n.cjs (the same dictionary
 * the UI renders), so reworded copy does not break a test that was never
 * about the wording. Where the markup gives something better than text - a
 * form control's autocomplete role, the shell's data attributes - that wins.
 *
 * Note: Field (src/components/ui/field.jsx) renders its <Label> without a
 * `for`, so the login inputs are not reachable via getByLabel and are matched
 * by their autocomplete tokens instead.
 */

const { en, TOKEN_KEY } = require('./fixtures.cjs');

function loginScreen(page) {
  return {
    heading: page.getByRole('heading', { name: en('login.heading') }),
    subheading: page.getByText(en('login.subheading')),
    identifier: page.locator('input[autocomplete="username"]'),
    password: page.locator('input[autocomplete="current-password"]'),
    submit: page.getByRole('button', { name: en('login.submit'), exact: true }),
    submitting: page.getByRole('button', { name: en('login.submitting') }),
    error: page.getByRole('alert'),
    revealPassword: page.getByRole('button', { name: en('login.showPassword') }),
    hidePassword: page.getByRole('button', { name: en('login.hidePassword') }),
    // The pre-auth facts pane: node, build, link security.
    plate: page.locator('.login-plate').first(),
  };
}

/* What `/` shows: the game picker when there are no servers yet, the list of
 * every server when there are several. (With exactly one, `/` opens it;
 * `/servers` always shows the list.) */
function homeScreen(page) {
  return {
    firstServer: page.getByRole('heading', { name: en('home.firstTitle') }),
    gameChoice: (id) => page.locator(`[data-game-choice="${id}"]`),
    serverList: page.locator('[data-server-list]'),
    addServer: page.getByRole('button', { name: en('addServer.button'), exact: true }),
    // Trash sits under the list (and under the picker) for admins, and only
    // when something is in it.
    trash: page.getByText(en('portability.trashTitle'), { exact: true }),
    restore: page.getByRole('button', { name: en('portability.restore') }),
  };
}

/* A server-scoped URL: `/servers/<id>` for the overview, or
 * `/servers/<id>/<segment>` for a section. The id defaults to any. */
function serverUrl(segment = '', id = '[^/]+') {
  return new RegExp(`/servers/${id}${segment ? `/${segment}` : ''}$`);
}

function appShell(page) {
  return {
    header: page.locator('header[data-app-header]'),
    profileButton: page.locator('[data-profile-menu]'),
    sidebar: page.locator('[data-app-sidebar]'),
    navItem: (view) => page.locator(`[data-nav-item="${view}"]`),
    /* A tab of the open section (Mods, Worlds, Settings). */
    sectionTab: (tab) => page.locator(`[data-section-tab="${tab}"]`),
    // Profile menu. "Hostkind settings" carries the panel's name, so it never
    // reads like the open server's own Settings.
    menuSettings: page.getByRole('menuitem', { name: en('nav.panelSettings', { name: en('brand.name') }) }),
    menuWhatsNew: page.getByRole('menuitem', { name: en('whatsNew.title') }),
    menuReportProblem: page.getByRole('menuitem', { name: en('bugReport.menu') }),
    /* The unread mark on the profile button after an update. */
    whatsNewDot: page.locator('[data-whats-new-dot]'),
    menuLanguage: page.getByRole('menuitem', { name: en('settings.language') }),
    menuLogout: page.getByRole('menuitem', { name: en('sidebar.logout') }),
    changelog: page.getByRole('dialog', { name: en('whatsNew.title') }),
    /* Above Mods, Worlds and Settings -> Game/Files of a never-started server. */
    firstStartNotice: page.locator('[data-first-start-notice]'),
  };
}

/* The open server's controls: its status and start / stop / restart in the
 * header, and the server switcher at the top of the sidebar. Start and
 * stop/restart are never mounted at the same time - the header swaps them as
 * the lifecycle moves - so a spec waits for the one it expects.
 *
 * `exact` everywhere below is load-bearing: accessible-name matching is a
 * substring match by default, and "Restart" contains "start". */
function serverControls(page) {
  const root = page.locator('[data-server-controls]');
  return {
    root,
    // The pill reports the status in words; the dot beside it is decorative.
    // Two pills: one beside the name, one on the second line on phones.
    status: page.locator('header[data-app-header] .status-pill:visible'),
    picker: page.locator('[data-server-switcher]'),
    pickerOption: (name) => page.getByRole('option', { name }),
    start: root.getByRole('button', { name: en('header.start'), exact: true }),
    stop: root.getByRole('button', { name: en('header.stop'), exact: true }),
    restart: root.getByRole('button', { name: en('header.restart'), exact: true }),
  };
}

/* A table row identified by one exact cell value. `hasText` is a substring
 * match, which quietly picks up "world_nether" when you asked for "world" -
 * so match a cell whose whole text is the name instead. */
function tableRow(page, name) {
  return page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
}

/* One row of the all-servers list. Clicking the row opens the server; Start
 * and Stop act in place (never both at once, like the header). Editing,
 * cloning and removing live on the server's Settings -> General and in the
 * header's menu, not here. */
function serverRow(page, name) {
  const root = tableRow(page, name);
  const action = (label) => root.getByRole('button', { name: label, exact: true });
  return {
    root,
    status: root.locator('.status-pill'),
    start: action(en('servers.btnStart')),
    stop: action(en('servers.btnStop')),
    open: action(en('servers.btnOpenNamed', { name })),
    attention: root.locator('[data-attention-count]'),
    staleBackup: root.locator('[data-backup-stale]'),
  };
}

/* The open server's Settings -> General page: its profile form and the
 * buttons that clone it, remove it, or (Palworld) open its tools. */
function generalSettings(page) {
  const button = (key) => page.locator('main').getByRole('button', { name: en(key), exact: true });
  return {
    save: button('common.save'),
    clone: button('servers.cloneWithoutWorlds'),
    remove: button('servers.btnRemove'),
    tools: button('serverSettings.openTools'),
  };
}

/* Hostkind settings (`/settings[/<tab>]`): the panel's own page, tabbed.
 * `group` is one settings group of the Preferences tab (profile, password,
 * language, watchdog, game-colors, hotkeys, legal). */
function panelSettings(page) {
  return {
    root: page.locator('main'),
    tab: (name) => page.locator(`[data-section-tab="${name}"]`),
    tabs: page.locator('[data-section-tab]'),
    group: (name) => page.locator(`[data-settings-group="${name}"]`),
  };
}

/* The header's `⋯` menu for the open server (admins only). */
function serverMenu(page) {
  const item = (key) => page.getByRole('menuitem', { name: en(key), exact: true });
  return {
    trigger: page.locator('[data-server-menu]'),
    settings: item('servers.menuSettings'),
    clone: item('servers.cloneWithoutWorlds'),
    remove: item('servers.btnRemove'),
  };
}

/* Sonner's toasts. Success and error both land here; the variant is on the
 * element's data-type, which is what tells them apart. */
function toasts(page) {
  return {
    any: page.locator('[data-sonner-toast]'),
    error: page.locator('[data-sonner-toast][data-type="error"]'),
    success: page.locator('[data-sonner-toast][data-type="success"]'),
    withText: (text) => page.locator('[data-sonner-toast]').filter({ hasText: text }),
  };
}

/* One account in the users list. It is not a table, so the row is found as the
 * innermost element holding both the identifier and that row's Edit button. */
function userRow(page, identifier) {
  const root = page.locator('div')
    .filter({ has: page.getByRole('button', { name: en('common.edit') }) })
    .filter({ has: page.getByText(identifier, { exact: true }) })
    .last();
  return {
    root,
    edit: root.getByRole('button', { name: en('common.edit') }),
    permissions: root.getByRole('button', { name: en('users.permissions') }),
    // The delete control is the trailing icon button, with no text of its own.
    remove: root.getByRole('button').last(),
  };
}

/* One key in the API keys card. Rows carry data-api-key-row rather than being
 * found by text: key names are free-form, and "Billing" would otherwise also
 * match "Billing (staging)". */
function apiKeyRow(page, name) {
  const root = page.locator(`[data-api-key-row="${name}"]`);
  return {
    root,
    permissions: root.getByRole('button', { name: en('users.permissions') }),
    // The revoke control is the trailing icon button, with no text of its own.
    revoke: root.getByRole('button').last(),
  };
}

/* The panel's identity, wherever it is rendered. `wordmark` is the sidebar
 * mark; the login screen prints the name without that class, so a branding
 * spec checking the login door asserts on the text instead. */
function brandMark(page) {
  return {
    wordmark: page.locator('.brand-wordmark'),
    icon: page.locator('.brand-icon'),
    customLogo: page.locator('img.brand-icon--custom'),
    supportLink: page.getByRole('link', { name: en('sidebar.supportLabel') }),
  };
}

/*
 * The form control that belongs to a visible label.
 *
 * `Field` and the wizards render `<Label>` without a `for`, so getByLabel does
 * not work (see the note at the top). This finds the innermost element holding
 * both that exact label text and a control, which is the field group, and
 * returns its control - number and password inputs included, which a role
 * lookup would miss.
 */
function fieldByLabel(scope, label) {
  const page = typeof scope.page === 'function' ? scope.page() : scope;
  const CONTROL = 'input, textarea, select';
  return scope.locator('div')
    .filter({ has: page.getByText(label, { exact: true }) })
    .filter({ has: page.locator(CONTROL) })
    .last()
    .locator(CONTROL)
    .first();
}

/*
 * The Minecraft branch of the create wizard.
 *
 * Its version list is resolved upstream when the branch opens and again on
 * every type change, so `version` and `submit` are both gated on that call -
 * submitting without a version is a 400 from /api/create, and the wizard is
 * what has to make that unreachable.
 */
function minecraftWizard(page) {
  const root = page.getByRole('dialog', { name: en('servers.createTitle') });
  return {
    root,
    type: fieldByLabel(root, en('minecraft.servers.fieldType')),
    version: root.locator('#mc-version'),
    submit: root.getByRole('button', { name: en('minecraft.servers.downloadAndCreate'), exact: true }),
  };
}

/*
 * The presets at the top of every create wizard (views/servers/PresetPicker.jsx).
 * A preset button is aria-pressed while the form still matches it, so editing
 * a field it set clears the highlight.
 */
function presetButton(root, id) {
  return root.locator(`[data-server-preset="${id}"]`);
}

/*
 * Worlds -> Map while no map is showing (components/shared/MapSetup.jsx): the
 * map plugins to install, the "already installed" card, the restart prompt,
 * and BlueMap's download consent banner above the card.
 */
function mapSetup(page) {
  return {
    plugin(key) {
      const root = page.locator(`[data-map-plugin="${key}"]`);
      return { root, install: root.getByRole('button') };
    },
    showMap: page.getByRole('button', { name: en('minecraft.mapView.showMap'), exact: true }),
    consent: page.getByRole('button', { name: en('minecraft.mapView.blueMapConsentAction'), exact: true }),
    frame: page.locator(`iframe[title="${en('minecraft.mapView.title')}"]`),
  };
}

/*
 * The panel's own folder browser: the fallback a wizard opens when the host's
 * native dialog cannot be used.
 *
 * `at` is the folder it is currently sitting in, and it is worth waiting for -
 * the listing arrives over HTTP, and until it does the browser is on no folder
 * at all and "Use this folder" answers "navigate into a folder first" instead
 * of closing.
 */
function folderBrowser(page) {
  const root = page.getByRole('dialog', { name: en('servers.pickFolderTitle') });
  return {
    root,
    at: (dir) => root.getByText(dir, { exact: true }),
    use: root.getByRole('button', { name: en('servers.useThisFolder'), exact: true }),
    cancel: root.getByRole('button', { name: en('common.cancel'), exact: true }),
  };
}

/*
 * The Health screen's three tabs, and the Resources tab's charts.
 *
 * The charts are uPlot, which paints to a <canvas> inside a .uplot wrapper -
 * there is no SVG geometry to assert on, so a spec checks that the expected
 * number of plots mounted and got real width, and reads the headline value out
 * of the card beside each one.
 */
/** A server's Overview: KPI cards, Needs attention, the facts line. */
function overviewView(page) {
  const attention = page.locator('[data-attention]');
  return {
    kpi: (key) => page.locator(`[data-kpi="${key}"]`),
    attention,
    heading: attention.getByRole('heading'),
    item: (kind) => attention.locator(`[data-attention-item="${kind}"]`),
    items: attention.locator('[data-attention-item]'),
    allClear: attention.locator('[data-attention-clear]'),
    facts: page.locator('[data-overview-facts]'),
  };
}

function detailsView(page) {
  return {
    plots: page.locator('.uplot'),
    noData: page.getByText(en('metrics.noData')),
    range: (key) => page.getByRole('button', { name: en(key), exact: true }),
    /* One metric card, found by its exact title; the reading sits beside it. */
    card: (title) => page.locator('div')
      .filter({ has: page.getByText(title, { exact: true }) })
      .filter({ has: page.locator('.uplot') })
      .last(),
  };
}

/* The panel's one waiting affordance (src/components/shared/Loading.jsx). It
 * is found by its data-slot rather than its role: Sonner's toasts are also
 * role="status", and the spinner's own label is screen-reader-only text, which
 * is not what names a live region. */
function loadingSpinner(page) {
  return page.locator('[data-slot="loading"]');
}

/* Radix dialogs, which every destructive action in the panel goes through. */
function dialog(page, name) {
  const root = name ? page.getByRole('dialog', { name }) : page.getByRole('dialog');
  return {
    root,
    title: root.getByRole('heading'),
    confirm: root.getByRole('button', { name: en('common.confirm') }),
    cancel: root.getByRole('button', { name: en('common.cancel') }),
    close: root.getByRole('button', { name: en('common.close') }),
    field: (label) => root.getByLabel(label),
  };
}

/* The wrench dialog on a Palworld server: connectivity and profile export. */
function serverTools(page) {
  const root = page.getByRole('dialog');
  const tab = (key) => root.getByRole('tab', { name: en(`portability.${key}`), exact: true });
  return {
    root,
    tabs: root.getByRole('tablist'),
    tab,
    // Two buttons are named "Close": the footer's, and the X the dialog
    // primitive puts in the corner. The footer's comes first in the markup.
    close: root.getByRole('button', { name: en('common.close'), exact: true }).first(),
  };
}

module.exports = {
  loginScreen, homeScreen, serverUrl, appShell, serverControls,
  serverRow, generalSettings, serverMenu, panelSettings, tableRow, userRow, apiKeyRow, brandMark, overviewView, detailsView,
  toasts, dialog, fieldByLabel, minecraftWizard, presetButton, mapSetup, folderBrowser, loadingSpinner,
  serverTools,
};
