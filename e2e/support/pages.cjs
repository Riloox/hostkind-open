'use strict';

/*
 * Locators, in one place, so a copy or markup change is a one-line fix here
 * rather than a sweep through the specs.
 *
 * Text-based locators read their strings from i18n.cjs (the same dictionary
 * the UI renders), so reworded copy does not break a test that was never
 * about the wording. Where the markup gives something better than text - a
 * form control's autocomplete role, the tour's data attributes - that wins.
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

function gamesHub(page) {
  return {
    carousel: page.getByRole('region', { name: en('games.count') }),
    game: (id) => page.locator(`.game-carousel-slide[data-game="${id}"]`),
  };
}

function appShell(page) {
  return {
    header: page.locator('header[data-tour="header"]'),
    profileButton: page.locator('[data-tour="profile"]'),
    sidebar: page.locator('[data-tour="sidebar"]'),
    navItem: (view) => page.locator(`[data-nav-item="${view}"]`),
    menuSettings: page.getByRole('menuitem', { name: en('sidebar.settings') }),
    menuLogout: page.getByRole('menuitem', { name: en('sidebar.logout') }),
    tour: page.getByRole('dialog', { name: en('tour.welcome.title') }),
  };
}

/* The bar pinned to the bottom of every in-game screen: server picker, status,
 * and start / stop / restart for the server that is selected. Start and
 * stop/restart are never mounted at the same time - the dock swaps them as the
 * lifecycle moves - so a spec waits for the one it expects.
 *
 * `exact` everywhere below is load-bearing: accessible-name matching is a
 * substring match by default, and "Restart" contains "start". */
function controlBar(page) {
  const root = page.locator('[data-tour="controlbar"]');
  return {
    root,
    // The pill reports the status in words; the dot beside it is decorative.
    status: root.locator('.status-pill'),
    picker: root.locator('button[aria-haspopup="listbox"]'),
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

/* One row of the registered-servers table. The action buttons are labelled by
 * their `title`, and again: exact, or "Start" also finds "Restart". */
function serverRow(page, name) {
  const root = tableRow(page, name);
  const action = (key) => root.getByTitle(en(key), { exact: true });
  return {
    root,
    status: root.locator('.status-pill'),
    start: action('servers.btnStart'),
    stop: action('servers.btnStop'),
    restart: action('servers.btnRestart'),
    setActive: action('servers.btnSetActive'),
    edit: action('servers.btnEdit'),
    tools: action('portability.serverTools'),
    remove: action('servers.btnRemove'),
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
function healthView(page) {
  const tab = (key) => page.getByRole('tab', { name: en(key), exact: true });
  return {
    tabs: { overview: tab('health.overview'), resources: tab('health.resources'), crashes: tab('health.crashes') },
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
  loginScreen, gamesHub, appShell, controlBar,
  serverRow, tableRow, userRow, apiKeyRow, brandMark, healthView,
  toasts, dialog, fieldByLabel, minecraftWizard, folderBrowser, loadingSpinner,
  serverTools,
};
