import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Play, Pencil, Trash2, Plus, CalendarClock, Info } from 'lucide-react';
import { gameForServer } from '@/lib/games';

const CRON_PRESETS = [
  { labelKey: 'tasks.presetHourly', cron: '0 * * * *' },
  { labelKey: 'tasks.presetDaily4am', cron: '0 4 * * *' },
  { labelKey: 'tasks.presetEvery6h', cron: '0 */6 * * *' },
  { labelKey: 'tasks.presetWeekly', cron: '0 3 * * 0' },
];

const TRIGGERS = [
  { kind: 'cron', labelKey: 'tasks.triggerCron', palworldOnly: false },
  { kind: 'interval', labelKey: 'tasks.triggerInterval', palworldOnly: false },
  { kind: 'player-joined', labelKey: 'tasks.triggerPlayerJoined', palworldOnly: true },
  { kind: 'server-empty', labelKey: 'tasks.triggerServerEmpty', palworldOnly: true },
  { kind: 'update-available', labelKey: 'tasks.triggerUpdateAvailable', palworldOnly: true },
];

const ACTIONS = [
  { kind: 'restart', labelKey: 'tasks.actionRestart', palworld: 'never' },
  { kind: 'backup', labelKey: 'tasks.actionBackup', palworld: 'any' },
  { kind: 'backup-offline', labelKey: 'tasks.actionBackupOffline', palworld: 'never', terrariaOnly: true },
  { kind: 'say', labelKey: 'tasks.actionSay', palworld: 'never', terrariaOnly: true },
  { kind: 'command', labelKey: 'tasks.actionCommand', palworld: 'never' },
  { kind: 'announce', labelKey: 'tasks.actionAnnounce', palworld: 'only' },
  { kind: 'save', labelKey: 'tasks.actionSave', palworld: 'only' },
  { kind: 'graceful-restart', labelKey: 'tasks.actionGracefulRestart', palworld: 'only' },
  { kind: 'apply-update-policy', labelKey: 'tasks.actionApplyUpdatePolicy', palworld: 'only' },
  { kind: 'stop-when-empty', labelKey: 'tasks.actionStopWhenEmpty', palworld: 'only' },
];

const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50';

const EMPTY_FORM = {
  name: '',
  serverId: '',
  enabled: true,
  triggerKind: 'cron',
  cron: '0 4 * * *',
  intervalMinutes: 60,
  catchUp: false,
  maxCatchUpMinutes: 120,
  playerId: '',
  delaySeconds: 5,
  cooldownMinutes: 60,
  actionKind: 'restart',
  command: '',
  message: '',
  announceSeconds: 300,
  offlineMode: 'skip',
  minimumEmptyMinutes: 15,
  graceSeconds: 120,
  minimumUptimeMinutes: 10,
  sessions: 'all',
};

function formFromTask(task) {
  const trigger = task.trigger || { kind: 'cron', expression: task.cron };
  const action = task.action || { kind: task.type, command: task.command };
  return {
    ...EMPTY_FORM,
    name: task.name || '',
    serverId: task.serverId,
    enabled: task.enabled !== false,
    triggerKind: trigger.kind,
    cron: trigger.expression || EMPTY_FORM.cron,
    intervalMinutes: trigger.minutes ?? EMPTY_FORM.intervalMinutes,
    catchUp: trigger.catchUp === true,
    maxCatchUpMinutes: trigger.maxCatchUpMinutes ?? EMPTY_FORM.maxCatchUpMinutes,
    playerId: trigger.playerId || '',
    delaySeconds: trigger.delaySeconds ?? EMPTY_FORM.delaySeconds,
    cooldownMinutes: trigger.cooldownMinutes ?? EMPTY_FORM.cooldownMinutes,
    actionKind: action.kind,
    command: action.command || '',
    message: action.message || '',
    announceSeconds: action.announceSeconds ?? EMPTY_FORM.announceSeconds,
    offlineMode: action.offlineMode || EMPTY_FORM.offlineMode,
    minimumEmptyMinutes: action.minimumEmptyMinutes ?? trigger.minimumEmptyMinutes ?? EMPTY_FORM.minimumEmptyMinutes,
    graceSeconds: action.graceSeconds ?? trigger.graceSeconds ?? EMPTY_FORM.graceSeconds,
    minimumUptimeMinutes: action.minimumUptimeMinutes ?? trigger.minimumUptimeMinutes ?? EMPTY_FORM.minimumUptimeMinutes,
    sessions: action.sessions || trigger.sessions || EMPTY_FORM.sessions,
  };
}

function payloadFromForm(form, id) {
  const stopWhenEmpty = {
    minimumEmptyMinutes: Number(form.minimumEmptyMinutes),
    graceSeconds: Number(form.graceSeconds),
    minimumUptimeMinutes: Number(form.minimumUptimeMinutes),
    sessions: form.sessions,
    message: form.message,
  };
  const trigger = { kind: form.triggerKind };
  if (form.triggerKind === 'cron') {
    Object.assign(trigger, { expression: form.cron, catchUp: form.catchUp, maxCatchUpMinutes: Number(form.maxCatchUpMinutes) });
  } else if (form.triggerKind === 'interval') {
    Object.assign(trigger, { minutes: Number(form.intervalMinutes), catchUp: form.catchUp, maxCatchUpMinutes: Number(form.maxCatchUpMinutes) });
  } else if (form.triggerKind === 'player-joined') {
    Object.assign(trigger, { playerId: form.playerId || null, delaySeconds: Number(form.delaySeconds), cooldownMinutes: Number(form.cooldownMinutes) });
  } else if (form.triggerKind === 'server-empty') {
    Object.assign(trigger, stopWhenEmpty);
  }

  const action = { kind: form.actionKind };
  if (form.actionKind === 'command') action.command = form.command;
  if (['announce', 'say'].includes(form.actionKind)) action.message = form.message;
  if (form.actionKind === 'backup') action.offlineMode = form.offlineMode;
  if (form.actionKind === 'graceful-restart') Object.assign(action, { announceSeconds: Number(form.announceSeconds), message: form.message });
  if (form.actionKind === 'stop-when-empty') Object.assign(action, stopWhenEmpty);

  return { id, version: 2, name: form.name, serverId: form.serverId, enabled: form.enabled, trigger, action };
}

function TriggerPreview({ preview }) {
  const t = useT();
  if (!preview) return null;
  const times = preview.next || [];
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs space-y-1">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Info className="h-3.5 w-3.5" />
        {t('tasks.previewTitle')}
      </div>
      {preview.condition && <p className="text-muted-foreground">{preview.condition}</p>}
      {times.length > 0 ? (
        <ul className="text-muted-foreground space-y-0.5">
          {times.map(item => <li key={item.at}>{new Date(item.at).toLocaleString()}</li>)}
        </ul>
      ) : (!preview.condition && <p className="text-muted-foreground">{t('tasks.previewNone')}</p>)}
      {preview.timezone && <p className="text-muted-foreground">{t('tasks.previewTimezone', { zone: preview.timezone })}</p>}
      {preview.offsetChanges && <p className="text-status-warn">{t('tasks.previewOffsetChange')}</p>}
    </div>
  );
}

function TaskModal({ open, onOpenChange, task, server, onSaved }) {
  const api = useApi();
  const t = useT();
  const [form, setForm] = useState(EMPTY_FORM);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setPreview(null);
    setForm(task ? formFromTask(task) : { ...EMPTY_FORM, serverId: server?.id || '' });
  }, [open, task, server?.id]);

  const isPalworld = gameForServer(server) === 'palworld';
  const isTerraria = gameForServer(server) === 'terraria';

  // Keep the trigger/action pair valid for the selected game.
  useEffect(() => {
    setForm(prev => {
      const next = { ...prev };
      if (!isPalworld && TRIGGERS.find(x => x.kind === prev.triggerKind)?.palworldOnly) next.triggerKind = 'cron';
      const action = ACTIONS.find(x => x.kind === prev.actionKind);
      if (action && ((isPalworld && action.palworld === 'never') || (!isPalworld && action.palworld === 'only'))) {
        next.actionKind = isPalworld ? 'backup' : 'restart';
      }
      if (next.triggerKind === 'server-empty') next.actionKind = 'stop-when-empty';
      return next;
    });
  }, [isPalworld, form.triggerKind]);

  // Preview is authoritative: it comes from the same code that schedules.
  useEffect(() => {
    if (!open || !form.serverId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api('/api/tasks/preview', { method: 'POST', body: payloadFromForm(form, task?.id) });
        if (!cancelled) { setPreview(result.preview); setError(''); }
      } catch (e) {
        if (!cancelled) { setPreview(null); setError(e.message); }
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, form]);

  async function save() {
    try {
      const body = payloadFromForm(form, task?.id);
      if (task?.id) await api(`/api/tasks/${task.id}`, { method: 'PUT', body });
      else await api('/api/tasks', { method: 'POST', body });
      onSaved(task ? t('tasks.updatedToast') : t('tasks.createdToast'));
      onOpenChange(false);
    } catch (e) { setError(e.message); }
  }

  const f = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(p => ({ ...p, [k]: v }));
  };

  const triggers = TRIGGERS.filter(item => isPalworld || !item.palworldOnly);
  const actions = ACTIONS.filter(item => (isPalworld ? item.palworld !== 'never' : item.palworld !== 'only')
    && (!item.terrariaOnly || isTerraria));
  const showMessage = ['announce', 'say', 'graceful-restart', 'stop-when-empty'].includes(form.actionKind)
    || form.triggerKind === 'server-empty';
  const showStopWhenEmpty = form.actionKind === 'stop-when-empty' || form.triggerKind === 'server-empty';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{task ? t('tasks.editTitle') : t('tasks.newTitle')}</DialogTitle></DialogHeader>
        <div className="px-5 py-4 space-y-4 max-h-[65vh] overflow-y-auto">
          <div className="space-y-1.5">
            <Label>{t('tasks.fieldName')}</Label>
            <Input value={form.name} onChange={f('name')} placeholder={t('tasks.namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('tasks.fieldTrigger')}</Label>
            <select className={SELECT_CLASS} value={form.triggerKind} onChange={f('triggerKind')}>
              {triggers.map(item => <option key={item.kind} value={item.kind}>{t(item.labelKey)}</option>)}
            </select>
          </div>

          {form.triggerKind === 'cron' && (
            <div className="space-y-1.5">
              <Label>{t('tasks.fieldCron')}</Label>
              <Input value={form.cron} onChange={f('cron')} placeholder={t('tasks.cronPlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('tasks.localTime')}</p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {CRON_PRESETS.map(p => (
                  <button key={p.cron} type="button"
                    onClick={() => setForm(prev => ({ ...prev, cron: p.cron }))}
                    className="rounded px-2 py-0.5 text-xs border border-border bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {form.triggerKind === 'interval' && (
            <div className="space-y-1.5">
              <Label>{t('tasks.fieldIntervalMinutes')}</Label>
              <Input type="number" min={5} value={form.intervalMinutes} onChange={f('intervalMinutes')} />
            </div>
          )}
          {['cron', 'interval'].includes(form.triggerKind) && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={form.catchUp} onChange={f('catchUp')} className="accent-primary" />
                <span className="text-muted-foreground">{t('tasks.fieldCatchUp')}</span>
              </label>
              {form.catchUp && (
                <div className="space-y-1.5">
                  <Label>{t('tasks.fieldMaxCatchUpMinutes')}</Label>
                  <Input type="number" min={1} value={form.maxCatchUpMinutes} onChange={f('maxCatchUpMinutes')} />
                </div>
              )}
            </div>
          )}
          {form.triggerKind === 'player-joined' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5 col-span-2">
                <Label>{t('tasks.fieldPlayerId')}</Label>
                <Input value={form.playerId} onChange={f('playerId')} placeholder={t('tasks.playerIdPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('tasks.fieldDelaySeconds')}</Label>
                <Input type="number" min={0} value={form.delaySeconds} onChange={f('delaySeconds')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('tasks.fieldCooldownMinutes')}</Label>
                <Input type="number" min={0} value={form.cooldownMinutes} onChange={f('cooldownMinutes')} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t('tasks.fieldAction')}</Label>
            <select className={SELECT_CLASS} value={form.actionKind} onChange={f('actionKind')}
              disabled={form.triggerKind === 'server-empty'}>
              {actions.map(item => <option key={item.kind} value={item.kind}>{t(item.labelKey)}</option>)}
            </select>
            {isPalworld && <p className="text-xs text-muted-foreground">{t('tasks.hintPalworld')}</p>}
          </div>

          {form.actionKind === 'command' && (
            <div className="space-y-1.5">
              <Label>{t('tasks.fieldCommand')}</Label>
              <Input value={form.command} onChange={f('command')} placeholder={t('tasks.commandPlaceholder')} />
            </div>
          )}
          {form.actionKind === 'backup' && (
            <div className="space-y-1.5">
              <Label>{t('tasks.fieldOfflineMode')}</Label>
              <select className={SELECT_CLASS} value={form.offlineMode} onChange={f('offlineMode')}>
                <option value="skip">{t('tasks.offlineSkip')}</option>
                <option value="catch-up">{t('tasks.offlineCatchUp')}</option>
                <option value="run">{t('tasks.offlineRun')}</option>
              </select>
            </div>
          )}
          {form.actionKind === 'graceful-restart' && (
            <div className="space-y-1.5">
              <Label>{t('tasks.fieldAnnounceSeconds')}</Label>
              <Input type="number" min={0} value={form.announceSeconds} onChange={f('announceSeconds')} />
            </div>
          )}
          {showStopWhenEmpty && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>{t('tasks.fieldMinimumEmptyMinutes')}</Label>
                <Input type="number" min={1} value={form.minimumEmptyMinutes} onChange={f('minimumEmptyMinutes')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('tasks.fieldGraceSeconds')}</Label>
                <Input type="number" min={0} value={form.graceSeconds} onChange={f('graceSeconds')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('tasks.fieldMinimumUptimeMinutes')}</Label>
                <Input type="number" min={0} value={form.minimumUptimeMinutes} onChange={f('minimumUptimeMinutes')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('tasks.fieldSessions')}</Label>
                <select className={SELECT_CLASS} value={form.sessions} onChange={f('sessions')}>
                  <option value="all">{t('tasks.sessionsAll')}</option>
                  <option value="automatic">{t('tasks.sessionsAutomatic')}</option>
                  <option value="manual">{t('tasks.sessionsManual')}</option>
                </select>
              </div>
            </div>
          )}
          {showMessage && (
            <div className="space-y-1.5">
              <Label>{t('tasks.fieldMessage')}</Label>
              <Input value={form.message} onChange={f('message')} placeholder={t('tasks.messagePlaceholder')} />
              <p className="text-xs text-muted-foreground">{t('tasks.messageHint')}</p>
            </div>
          )}

          <TriggerPreview preview={preview} />
          {isTerraria && ['backup', 'backup-offline', 'restart', 'command', 'say'].includes(form.actionKind)
            && <p className="text-xs text-muted-foreground">{t(`terraria.backups.schedulePreview.${form.actionKind}`)}</p>}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={f('enabled')} className="accent-primary" />
            <span className="text-muted-foreground">{t('tasks.enabled')}</span>
          </label>
          {error && <p className="text-xs text-status-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="default" onClick={save}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// When a task next fires, for sorting; tasks with nothing coming sort last.
function nextRunAt(task) {
  const at = task.enabled ? task.preview?.next?.[0]?.at : null;
  return at ? new Date(at).getTime() : Number.MAX_SAFE_INTEGER;
}

function triggerLabel(task, t) {
  const trigger = task.trigger || { kind: 'cron', expression: task.cron };
  if (trigger.kind === 'cron') return trigger.expression;
  if (trigger.kind === 'interval') return `${trigger.minutes}m`;
  const entry = TRIGGERS.find(item => item.kind === trigger.kind);
  return entry ? t(entry.labelKey) : trigger.kind;
}

function actionLabel(task, t) {
  const action = task.action || { kind: task.type, command: task.command };
  if (action.kind === 'command') return `${t('tasks.commandPrefix')}${action.command}`;
  const entry = ACTIONS.find(item => item.kind === action.kind);
  return entry ? t(entry.labelKey) : action.kind;
}

export function TasksView() {
  const api = useApi();
  const t = useT();
  const { activeServer } = useServer();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { tasks: list } = await api('/api/tasks');
      setTasks(list);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // Schedules belongs to the open server: its own tasks, the next one due
  // first, and those with nothing coming (paused, event triggers) after.
  const visibleTasks = tasks
    .filter(task => task.serverId === activeServer?.id)
    .sort((a, b) => nextRunAt(a) - nextRunAt(b) || String(a.name).localeCompare(String(b.name)));
  const listEmpty = !loading && !error && visibleTasks.length === 0;
  const newButton = (
    <Button variant="default" size="sm" onClick={() => { setEditTask(null); setModalOpen(true); }}>
      <Plus className="h-3.5 w-3.5" />
      {t('tasks.newTask')}
    </Button>
  );

  async function runTask(id) {
    try {
      await api(`/api/tasks/${id}/run`, { method: 'POST' });
      toast.success(t('tasks.ranToast'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  async function deleteTask(id) {
    try {
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
      toast.success(t('tasks.deletedToast'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <>
      <div className="space-y-6">
        {/* An empty list carries the button itself; one is enough. */}
        <ViewHeader title={t('nav.schedules')} actions={listEmpty ? null : newButton} />
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : visibleTasks.length === 0 ? (
          <Card><CardContent className="py-4"><EmptyState icon={CalendarClock} title={t('tasks.empty')} message={t('tasks.emptyHint')} action={newButton} /></CardContent></Card>
        ) : (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5">{t('tasks.fieldName')}</TableHead>
                  <TableHead>{t('tasks.fieldAction')}</TableHead>
                  <TableHead>{t('tasks.colTrigger')}</TableHead>
                  <TableHead>{t('tasks.lastRun')}</TableHead>
                  <TableHead className="pr-5 text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleTasks.map(task => (
                  <TableRow key={task.id}>
                    <TableCell className="pl-5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{task.name}</span>
                        {!task.enabled && <Badge variant="offline" className="px-1 py-0.5 text-label">{t('tasks.paused')}</Badge>}
                      </div>
                      {task.state?.cancelledReason && (
                        <p className="text-label text-muted-foreground">
                          {t('tasks.cancelledReason', { reason: task.state.cancelledReason })}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{actionLabel(task, t)}</TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{triggerLabel(task, t)}</code>
                      {task.preview?.next?.[0] && (
                        <p className="text-label text-muted-foreground">{new Date(task.preview.next[0].at).toLocaleString()}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {task.state?.lastFireAt ? new Date(task.state.lastFireAt).toLocaleString() : t('tasks.never')}
                    </TableCell>
                    <TableCell className="pr-5">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="glass" size="xs" onClick={() => runTask(task.id)}><Play className="h-3 w-3" />{t('tasks.run')}</Button>
                        <Button variant="ghost" size="icon-xs" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => { setEditTask(task); setModalOpen(true); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon-xs" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => setPendingDelete(task)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
      <TaskModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        task={editTask}
        server={activeServer}
        onSaved={(msg) => { toast.success(msg); load(); }}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title={t('tasks.deleteTitle')}
        description={pendingDelete ? t('tasks.deleteBody', { name: pendingDelete.name }) : ''}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => { deleteTask(pendingDelete.id); setPendingDelete(null); }}
      />
    </>
  );
}
