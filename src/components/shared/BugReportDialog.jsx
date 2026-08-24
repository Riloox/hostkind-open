import { useState, useEffect } from 'react';
import { Bug, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useT } from '@/context/I18nContext';
import { useApi } from '@/hooks/useApi';

/*
 * The report-a-bug modal. The form fields carry name attributes
 * (summary/description/repro/expected) that double as the API payload
 * contract; the current screen context (game, view, route) is captured by
 * the launcher when the dialog opens and rendered read-only, and the submit
 * posts to /api/bug-reports outside server scoping (a report describes the
 * panel, not one game server).
 *
 * Only the shared DialogContent's X (sr-only "Close") answers to common.close
 * - a second close-labelled button would trip Playwright strict mode.
 */
export function BugReportDialog({ open, onOpenChange, context }) {
  const t = useT();
  const api = useApi();
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [repro, setRepro] = useState('');
  const [expected, setExpected] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  // Fresh form + result every time the dialog opens (it stays mounted while
  // closed, so state would otherwise leak between reports).
  useEffect(() => {
    if (!open) return;
    setSummary('');
    setDescription('');
    setRepro('');
    setExpected('');
    setSubmitting(false);
    setResult(null);
  }, [open]);

  async function onSubmit(event) {
    event.preventDefault();
    // Double-submit guard: the button also disables, but a programmatic or
    // forced second click must never reach the network either.
    if (submitting) return;
    const title = summary.trim();
    const body = description.trim();
    if (!title || !body) return;
    setSubmitting(true);
    try {
      const data = await api('/api/bug-reports', {
        method: 'POST',
        serverScoped: false,
        body: {
          title,
          description: body,
          repro: repro.trim(),
          expected: expected.trim(),
          game: context?.game ?? null,
          view: context?.view ?? null,
          route: context?.route ?? null,
        },
      });
      const sync = data && data.sync;
      if (sync && sync.state === 'synced' && sync.url) {
        setResult({ kind: 'synced', url: sync.url });
      } else if (sync && sync.state === 'pending') {
        setResult({
          kind: sync.reason === 'not_configured' ? 'not_configured' : 'pending',
          // The translated not-configured copy already explains the state;
          // avoid repeating the same backend diagnostic below it.
          message: sync.reason === 'not_configured' ? null : (sync.message || sync.error),
          // For local-only installs (the open edition's default) the dialog
          // offers a direct link to the configured repo's issue tracker so
          // the user can still report upstream.
          trackerUrl: sync.trackerUrl || null,
        });
      } else {
        setResult({ kind: 'synced', url: null });
      }
    } catch (error) {
      setResult({ kind: 'error', message: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Bug className="h-4 w-4" />
            </span>
            {t('bugReport.title')}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 pt-2">
          {result ? (
            <div role="status" className="space-y-3">
              {result.kind === 'synced' && (
                <p className="flex items-start gap-2 text-sm text-foreground">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-online" />
                  <span>
                    {t('bugReport.success')}
                    {result.url && (
                      <>
                        {' '}
                        <a
                          href={result.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium break-all text-primary underline underline-offset-4"
                        >
                          {result.url}
                        </a>
                      </>
                    )}
                  </span>
                </p>
              )}
              {(result.kind === 'pending' || result.kind === 'not_configured') && (
                <p className="flex items-start gap-2 text-sm text-foreground">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
                  <span>
                    {t(result.kind === 'not_configured' ? 'bugReport.notConfigured' : 'bugReport.pending')}
                    {result.message ? ` — ${result.message}` : ''}
                  </span>
                </p>
              )}
              {result.kind === 'not_configured' && result.trackerUrl && (
                <p className="pl-6 text-sm">
                  <a
                    href={result.trackerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium break-all text-primary underline underline-offset-4"
                  >
                    {t('bugReport.openTracker')}
                  </a>
                </p>
              )}
              {result.kind === 'error' && (
                <p className="flex items-start gap-2 text-sm text-status-error">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{result.message}</span>
                </p>
              )}
            </div>
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              {/* Current screen, captured when the dialog opened */}
              <div className="space-y-1.5">
                <Label>{t('bugReport.context')}</Label>
                <div className="space-y-0.5 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                  <p data-bug-report-context-game={context?.game ?? ''}>{context?.game ?? '—'}</p>
                  <p data-bug-report-context-view={context?.view ?? ''}>{context?.view ?? '—'}</p>
                  <p data-bug-report-context-route={context?.route ?? ''}>{context?.route ?? '—'}</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>
                  {t('bugReport.summary')} <span className="text-status-error">*</span>
                </Label>
                <Input
                  name="summary"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  required
                  maxLength={200}
                  placeholder={t('bugReport.summary')}
                />
              </div>

              <div className="space-y-1.5">
                <Label>
                  {t('bugReport.description')} <span className="text-status-error">*</span>
                </Label>
                <Textarea
                  name="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  maxLength={4000}
                  placeholder={t('bugReport.description')}
                />
              </div>

              <div className="space-y-1.5">
                <Label>{t('bugReport.repro')}</Label>
                <Textarea
                  name="repro"
                  value={repro}
                  onChange={(e) => setRepro(e.target.value)}
                  maxLength={4000}
                  placeholder={t('bugReport.repro')}
                />
              </div>

              <div className="space-y-1.5">
                <Label>{t('bugReport.expected')}</Label>
                <Textarea
                  name="expected"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  maxLength={2000}
                  placeholder={t('bugReport.expected')}
                />
              </div>

              <p className="text-label leading-relaxed text-muted-foreground">{t('bugReport.privacy')}</p>

              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={submitting} aria-busy={submitting}>
                  {t('bugReport.submit')}
                </Button>
              </div>
            </form>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
