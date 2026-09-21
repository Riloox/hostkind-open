'use strict';

/*
 * GET  /api/players                - online player names + max slots
 * POST /api/players/:action        - kick, ban, pardon, op, deop, whitelist-add/remove
 * GET  /api/playerlists            - online / whitelist / ops / banned / recent + whitelist flag
 * GET  /api/players/lookup         - resolve a name via Mojang (canonical name + UUID)
 * POST /api/whitelist/toggle       - whitelist on/off (command when running, file when offline)
 * POST /api/playerlists/:kind/:op  - add/remove whitelist | op | ban (command when running, file when offline)
 *
 * Mounted at /, so router paths are full paths. The /api/players,
 * /api/playerlists and /api/whitelist capability gates registered in
 * server.js precede this mount and keep applying first.
 *
 * Offline edits touch the server's JSON lists directly; online edits go
 * through in-game commands so UUIDs resolve and apply immediately.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

function readJsonArray(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeJsonArray(file, arr) {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
}

function whitelistEnabled(dir) {
  try {
    const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    return /^white-list\s*=\s*true/m.test(props);
  } catch (_) { return false; }
}

// Players the server has seen recently (usercache.json), so they can be acted on
// by clicking instead of typing - even while offline. Drops expired entries and
// anyone already surfaced elsewhere (online / whitelist / ops / banned).
function readUserCache(dir, exclude) {
  const arr = readJsonArray(path.join(dir, 'usercache.json'));
  const now = Date.now();
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const name = x && x.name;
    if (!name || seen.has(name.toLowerCase())) continue;
    if (x.expiresOn) {
      const exp = Date.parse(x.expiresOn);
      if (!Number.isNaN(exp) && exp < now) continue;
    }
    if (exclude.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, uuid: x.uuid || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = function playersRouter({ targetManager, tErr, eKey, localizeManagerResult, fetchJson }) {
  const router = express.Router();

  // Look up a player's Mojang UUID (needed to add to files while offline, online-mode servers).
  async function mojangUuid(name) {
    try {
      const d = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
      if (d && d.id && d.id.length === 32) {
        return d.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
      }
    } catch (_) {}
    return null;
  }

  router.get('/api/players', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.json({ players: [], max: 0 });
    const st = m.moduleState || {};
    res.json({ players: [...(st.players || [])].sort(), max: st.maxPlayers || 0 });
  });

  router.post('/api/players/:action', (req, res) => {
    const name = (req.body && req.body.name || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return res.status(400).json({ error: tErr(req.user, 'errors.invalidName') });
    const map = {
      kick: `kick ${name}`,
      ban: `ban ${name}`,
      pardon: `pardon ${name}`,
      op: `op ${name}`,
      deop: `deop ${name}`,
      'whitelist-add': `whitelist add ${name}`,
      'whitelist-remove': `whitelist remove ${name}`,
    };
    const cmd = map[req.params.action];
    if (!cmd) return res.status(400).json({ error: tErr(req.user, 'errors.unknownAction') });
    const m = targetManager(req);
    res.json(localizeManagerResult(req, m ? m.sendCommand(cmd) : { ok: false, error: eKey('errors.noActiveServer') }));
  });

  router.get('/api/playerlists', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.json({ online: [], whitelist: [], ops: [], banned: [], recent: [], whitelistEnabled: false, running: false });
    const d = m.dir();
    const wl = readJsonArray(path.join(d, 'whitelist.json')).map((x) => x.name).filter(Boolean);
    const ops = readJsonArray(path.join(d, 'ops.json')).map((x) => x.name).filter(Boolean);
    const banned = readJsonArray(path.join(d, 'banned-players.json')).map((x) => ({ name: x.name, reason: x.reason || '' })).filter((x) => x.name);
    const online = [...((m.moduleState && m.moduleState.players) || [])].sort((a, b) => a.localeCompare(b));
    const exclude = new Set([...online, ...wl, ...ops, ...banned.map((b) => b.name)].map((n) => n.toLowerCase()));
    res.json({
      online,
      whitelist: wl.sort((a, b) => a.localeCompare(b)),
      ops: ops.sort((a, b) => a.localeCompare(b)),
      banned,
      recent: readUserCache(d, exclude),
      whitelistEnabled: whitelistEnabled(d),
      running: m.isRunning(),
    });
  });

  // Validate a never-before-seen name against Mojang and return its head-ready
  // canonical name + UUID, so the "add player" search can confirm before adding.
  router.get('/api/players/lookup', async (req, res) => {
    const name = (req.query.name || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPlayerName') });
    try {
      const d = await fetchJson(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
      if (d && d.id && d.name) {
        const uuid = d.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
        return res.json({ ok: true, name: d.name, uuid });
      }
      return res.status(404).json({ error: tErr(req.user, 'errors.couldNotResolvePlayer') });
    } catch (_) {
      return res.status(404).json({ error: tErr(req.user, 'errors.couldNotResolvePlayer') });
    }
  });

  // Toggle the whitelist on/off (sends command when running, edits server.properties when offline).
  router.post('/api/whitelist/toggle', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const on = !!(req.body && req.body.enabled);
    if (m.isRunning()) return res.json(localizeManagerResult(req, m.sendCommand(`whitelist ${on ? 'on' : 'off'}`)));
    try {
      const file = path.join(m.dir(), 'server.properties');
      let props = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (/^white-list\s*=.*/m.test(props)) props = props.replace(/^white-list\s*=.*/m, `white-list=${on}`);
      else props += `${props.endsWith('\n') || !props ? '' : '\n'}white-list=${on}\n`;
      fs.writeFileSync(file, props, 'utf8');
      res.json({ ok: true, note: 'Saved. Takes effect on next start.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Add/remove a player to/from a list, working both online and offline.
  // kind: whitelist | op | ban ; op: add | remove
  router.post('/api/playerlists/:kind/:op', async (req, res) => {
    const name = (req.body && req.body.name || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPlayerName') });
    const { kind, op } = req.params;
    if (!['whitelist', 'op', 'ban'].includes(kind) || !['add', 'remove'].includes(op)) {
      return res.status(400).json({ error: tErr(req.user, 'errors.unknownAction') });
    }
    // Optional free-text ban reason (only used when kind === 'ban' && op === 'add').
    const reason = (req.body && typeof req.body.reason === 'string' ? req.body.reason : '').trim().slice(0, 200);
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });

    // Online: let Minecraft do it (resolves UUIDs, applies immediately).
    if (m.isRunning()) {
      const cmds = {
        'whitelist:add': `whitelist add ${name}`, 'whitelist:remove': `whitelist remove ${name}`,
        'op:add': `op ${name}`, 'op:remove': `deop ${name}`,
        'ban:add': reason ? `ban ${name} ${reason}` : `ban ${name}`, 'ban:remove': `pardon ${name}`,
      };
      return res.json(localizeManagerResult(req, m.sendCommand(cmds[`${kind}:${op}`])));
    }

    // Offline: edit the JSON files directly.
    const d = m.dir();
    const files = { whitelist: 'whitelist.json', op: 'ops.json', ban: 'banned-players.json' };
    const file = path.join(d, files[kind]);
    try {
      if (op === 'remove') {
        const arr = readJsonArray(file);
        const next = arr.filter((x) => (x.name || '').toLowerCase() !== name.toLowerCase());
        writeJsonArray(file, next);
        return res.json({ ok: true, note: 'Updated (server offline).' });
      }
      // add → needs a UUID
      const uuid = await mojangUuid(name);
      if (!uuid) return res.status(400).json({ error: tErr(req.user, 'errors.couldNotResolvePlayer') });
      const arr = readJsonArray(file);
      if (arr.some((x) => (x.name || '').toLowerCase() === name.toLowerCase())) return res.json({ ok: true, note: 'Already listed.' });
      if (kind === 'whitelist') arr.push({ uuid, name });
      else if (kind === 'op') arr.push({ uuid, name, level: 4, bypassesPlayerLimit: false });
      else if (kind === 'ban') arr.push({ uuid, name, created: new Date().toISOString(), source: 'Hostkind', expires: 'forever', reason: reason || 'Banned by an operator' });
      writeJsonArray(file, arr);
      return res.json({ ok: true, note: 'Updated (server offline).' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  });

  return router;
};
