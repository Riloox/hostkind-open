'use strict';

/*
 * GET  /api/tasks          - list tasks (migrated shape + server name + capability + state + preview)
 * POST /api/tasks/preview  - validate a draft and preview its trigger + required capability
 * POST /api/tasks          - create a task (capability of its action required)
 * PUT  /api/tasks/:id      - update a task (capability of old and new action required)
 * DELETE /api/tasks/:id    - delete a task and drop its persisted state
 * POST /api/tasks/:id/run  - run a task by hand (same capability as its action)
 *
 * Mounted at /api/tasks, so router paths are relative. There is no prefix
 * capability gate for tasks: each mutating route checks the capability of the
 * task's own action, so running a task by hand never bypasses permissions.
 *
 * Execution and scheduling stay in server.js (runTask, setupSchedulers,
 * taskState persistence); this router only validates, projects, and persists
 * the task list.
 */

const express = require('express');

module.exports = function tasksRouter({
  config, automation, validateCron, findServer, eKey, tErr, localizeErr, httpError,
  genId, saveConfig, setupSchedulers, runTask, taskState, foundationCapabilities,
}) {
  const router = express.Router();

  function publicTask(t) {
    const s = findServer(t.serverId);
    const task = automation.migrateTask(t);
    return {
      ...task,
      serverName: s ? s.name : '(deleted server)',
      serverType: s ? s.type || 'minecraft' : null,
      capability: automation.capabilityForAction(task.action),
      state: taskState(t.id),
      preview: automation.previewTrigger(task.trigger, { lastFireAt: taskState(t.id).lastFireAt }),
    };
  }

  function validateTask(body) {
    const serverId = String(body.serverId || '').trim();
    const server = findServer(serverId);
    if (!server) return { error: eKey('errors.unknownServer') };
    const normalized = automation.normalizeTask(body, {
      serverType: server.type || 'minecraft',
      validateCron,
    });
    if (normalized.error) return { error: eKey(normalized.error) };
    return { value: { serverId, ...normalized.value } };
  }

  function requireTaskActionCapability(req, res, task) {
    const capability = automation.capabilityForAction(automation.migrateTask(task).action);
    if (!foundationCapabilities.has(req.user, task.serverId, capability)) {
      res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability });
      return false;
    }
    return true;
  }

  router.get('/', (req, res) => {
    res.json({ tasks: (config.tasks || []).map(publicTask) });
  });

  router.post('/preview', (req, res) => {
    const v = validateTask(req.body || {});
    if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
    res.json({
      ok: true,
      preview: automation.previewTrigger(v.value.trigger, { lastFireAt: taskState(req.body.id).lastFireAt }),
      capability: automation.capabilityForAction(v.value.action),
    });
  });

  router.post('/', (req, res) => {
    const v = validateTask(req.body || {});
    if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
    if (!requireTaskActionCapability(req, res, v.value)) return;
    if (!Array.isArray(config.tasks)) config.tasks = [];
    const task = { id: genId(), ...v.value };
    config.tasks.push(task);
    saveConfig(config);
    setupSchedulers();
    res.json({ ok: true, task: publicTask(task) });
  });

  router.put('/:id', (req, res) => {
    const t = (config.tasks || []).find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: tErr(req.user, 'errors.taskNotFound') });
    const v = validateTask({ ...automation.migrateTask(t), ...req.body });
    if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
    if (!requireTaskActionCapability(req, res, v.value) || !requireTaskActionCapability(req, res, t)) return;
    for (const key of ['trigger', 'action', 'cron', 'command', 'type']) delete t[key];
    Object.assign(t, v.value);
    saveConfig(config);
    setupSchedulers();
    res.json({ ok: true, task: publicTask(t) });
  });

  router.delete('/:id', (req, res) => {
    if (!Array.isArray(config.tasks)) config.tasks = [];
    const before = config.tasks.length;
    config.tasks = config.tasks.filter((x) => x.id !== req.params.id);
    if (config.tasks.length === before) return res.status(404).json({ error: tErr(req.user, 'errors.taskNotFound') });
    if (config.taskState) delete config.taskState[req.params.id];
    saveConfig(config);
    setupSchedulers();
    res.json({ ok: true });
  });

  // Running a task by hand never bypasses the permission its action requires.
  router.post('/:id/run', async (req, res) => {
    const t = (config.tasks || []).find((x) => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: tErr(req.user, 'errors.taskNotFound') });
    if (!requireTaskActionCapability(req, res, t)) return;
    try {
      await runTask(t);
      res.json({ ok: true });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  return router;
};
