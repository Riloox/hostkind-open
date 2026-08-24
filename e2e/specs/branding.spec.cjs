'use strict';

/*
 * White-labeling: what a hosting provider sees after setting config.branding.
 *
 * The unit tests in test/branding.test.cjs prove the resolution rules. What
 * they cannot tell you is whether the name actually reaches the sidebar, the
 * login door, and the browser tab - which is the entire question a provider is
 * asking when they ask "can we put our name on it?".
 *
 * Every test here needs its own panel: branding is panel-wide config.
 */

const { test, expect, en } = require('../support/fixtures.cjs');
const { brandMark, appShell, loginScreen } = require('../support/pages.cjs');
const { signInFast, openView } = require('../support/actions.cjs');

/** A panel booted with the given config.branding block. */
const branded = (newApp, branding) => newApp({ config: (config) => { config.branding = branding; } });

/*
 * Read a custom property back from the document.
 *
 * Not compared as a string: the browser normalises an OKLCH triple when it
 * round-trips through the cascade ("0.170" comes back as ".17"), so a literal
 * comparison fails for a value that is in fact correct.
 */
async function accentToken(page, token) {
  const raw = await page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);
  return raw.split(/\s+/).map((part) => parseFloat(part));
}

test.describe('default branding', () => {
  test('an unconfigured panel is Hostkind', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await expect(brandMark(page).wordmark).toHaveText(en('brand.name'));
    // The tab is "<game> · <view> — <panel name>", so the name is the suffix.
    await expect(page).toHaveTitle(new RegExp(`— ${en('brand.name')}$`));
    // The built-in glyph, not an <img> - nothing was configured.
    await expect(brandMark(page).customLogo).toHaveCount(0);
    await expect(brandMark(page).supportLink).toHaveCount(0);
  });
});

test.describe('a white-labelled panel', () => {
  test('carries the provider name in the sidebar and the tab', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus Hosting' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await expect(brandMark(page).wordmark).toHaveText('Nimbus Hosting');
    // The tab suffix is the panel's name too - a white-labelled panel that
    // still says "Hostkind" in the browser tab has not been white-labelled.
    await expect(page).toHaveTitle(/— Nimbus Hosting$/);
    await expect(page).not.toHaveTitle(new RegExp(en('brand.name')));
    await expect(brandMark(page).wordmark).not.toHaveText(en('brand.name'));
  });

  test('carries it on the login screen too, before anyone has signed in', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus Hosting' });
    await page.goto(`${panel.url}/`);
    await loginScreen(page).heading.waitFor();

    // The one screen rendered without a token. A provider's customers must not
    // meet someone else's wordmark on the way in.
    await expect(page.getByText('Nimbus Hosting')).toBeVisible();
    await expect(page.getByText(en('brand.name'), { exact: true })).toHaveCount(0);
  });

  test('falls back to appName, which is what existing installs set', async ({ page, newApp }) => {
    const panel = await newApp({ config: (config) => { config.appName = 'Legacy Panel'; } });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await expect(brandMark(page).wordmark).toHaveText('Legacy Panel');
  });

  test('shows a configured logo instead of the built-in glyph', async ({ page, newApp }) => {
    // Served by the panel itself, so the test does not depend on the network.
    const panel = await branded(newApp, { name: 'Nimbus', logoUrl: '/resources/favicon.svg' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    const logo = brandMark(page).customLogo;
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('src', '/resources/favicon.svg');
    // It must actually load - a broken <img> is worse than the glyph.
    expect(await logo.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  });

  test('repaints the accent from one hex', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus', accentColor: '#3b82f6' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    // The panel's colour is an OKLCH component triple behind --primary, so the
    // assertion is on the token the whole UI reads rather than on one element.
    expect(await accentToken(page, '--primary')).toEqual([62.3, 0.188, 259.8]);

    // The derived partners must land too, or a focused button rings in ember
    // on an otherwise blue panel.
    expect(await accentToken(page, '--ring')).toEqual([81.3, 0.068, 259.8]);
  });

  test('leaves the built-in accent alone when the colour is unusable', async ({ page, newApp }) => {
    // Near-black cannot produce a readable button; the panel keeps ember.
    const panel = await branded(newApp, { name: 'Nimbus', accentColor: '#000000' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    // --ember-5, straight out of tokens.css.
    expect(await accentToken(page, '--primary')).toEqual([74, 0.17, 55]);
  });

  test('shows a configured legal footer in the sidebar', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus', legalFooter: '© 2026 Nimbus Hosting' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    await expect(appShell(page).sidebar.getByText('© 2026 Nimbus Hosting')).toBeVisible();
  });

  test('shows no legal footer when none is configured', async ({ page, app }) => {
    await signInFast(page, app);
    await openView(page, 'minecraft', 'dashboard');

    await expect(appShell(page).sidebar).not.toContainText('legalFooter');
  });

  test('serves the brand in the shell title before the bundle mounts', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus Hosting' });
    // The SPA rewrites the title after mount, but the served shell already
    // carries the brand, so a branded install never flashes "Hostkind" in the
    // tab or on the login screen while the bundle loads.
    const response = await page.request.get(`${panel.url}/games`);
    const html = await response.text();
    expect(html).toContain('<title>Nimbus Hosting</title>');
    expect(html).not.toContain('<title>Hostkind</title>');
  });

  test('offers the provider helpdesk in the sidebar when one is configured', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus', supportUrl: 'https://help.example.com/' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    const link = brandMark(page).supportLink;
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://help.example.com/');
    // Opening the helpdesk must not throw away the panel session.
    await expect(link).toHaveAttribute('target', '_blank');
  });

  test('refuses a support URL that could execute', async ({ page, newApp }) => {
    const panel = await branded(newApp, { name: 'Nimbus', supportUrl: 'javascript:alert(1)' });
    await signInFast(page, panel);
    await openView(page, 'minecraft', 'dashboard', { origin: panel.url });

    // Rejected server-side, so the link is simply not offered.
    await expect(brandMark(page).supportLink).toHaveCount(0);
    await expect(appShell(page).sidebar).toBeVisible();
  });
});
