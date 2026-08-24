import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Clock, Download, Search, ShieldCheck } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth, useBranding } from '@/context/AuthContext';
import { useT } from '@/context/I18nContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shared/EmptyState';
import { Loading } from '@/components/shared/Loading';

const INITIAL = { serverId: '', actorId: '', action: '', outcome: '', from: '', to: '' };

function Field({ label, htmlFor, children }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-label font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </label>
      {children}
    </div>
  );
}

// Audit rows are read forensically, so the absolute timestamp stays the
// primary text always. This only adds a muted "how recent" hint, and only
// for the window where it's actually useful - under 24h old.
function relativeSuffix(ts, t) {
  const diff = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(diff) || diff < 0 || diff >= 24 * 60 * 60 * 1000) return null;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('notifications.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('notifications.minutesAgo', { m: min });
  const hr = Math.floor(min / 60);
  return t('notifications.hoursAgo', { h: hr });
}

export function AuditView() {
  const api = useApi();
  const { token } = useAuth();
  const branding = useBranding();
  const t = useT();
  const [filters, setFilters] = useState(INITIAL);
  const [applied, setApplied] = useState(INITIAL);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [retention, setRetention] = useState({ open: false, cutoff: '', preview: null });

  const query = useCallback((values, nextCursor) => {
    const params = new URLSearchParams();
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
    if (nextCursor) params.set('cursor', nextCursor);
    params.set('limit', '100');
    return params.toString();
  }, []);

  const load = useCallback(async (values = applied, nextCursor = null) => {
    setLoading(true);
    try {
      const data = await api(`/api/audit?${query(values, nextCursor)}`);
      setItems((current) => nextCursor ? [...current, ...data.items] : data.items);
      setCursor(data.nextCursor);
    } catch (error) { toast.error(error.message); }
    setLoading(false);
  }, [api, applied, query]);

  useEffect(() => { load(INITIAL); }, []);

  function applyFilters() {
    setApplied(filters);
    load(filters);
  }

  async function download(format) {
    try {
      const response = await fetch(`/api/audit/export?format=${format}&${query(applied)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(t('audit.exportFailed'));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      // The downloaded archive is named after the panel, not the stock product,
      // so a white-labelled install ships files under its own brand.
      const base = (branding.name || 'hostkind').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'hostkind';
      anchor.download = `${base}-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { toast.error(error.message); }
  }

  async function previewRetention() {
    try {
      const preview = await api('/api/audit/retention/preview', { method: 'POST', body: { cutoff: retention.cutoff } });
      setRetention((value) => ({ ...value, preview }));
    } catch (error) { toast.error(error.message); }
  }

  async function applyRetention() {
    try {
      const result = await api('/api/audit/retention/apply', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: { previewToken: retention.preview.previewToken } });
      toast.success(t('audit.deletedToast', { count: result.deletedCount }));
      setRetention({ open: false, cutoff: '', preview: null });
      load(applied);
    } catch (error) { toast.error(error.message); }
  }

  const field = (name) => (event) => setFilters((value) => ({ ...value, [name]: event.target.value }));

  return <>
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" />{t('audit.title')}</CardTitle>
        <div className="flex gap-2">
          <Button variant="glass" size="sm" onClick={() => download('csv')}><Download className="h-3.5 w-3.5" />CSV</Button>
          <Button variant="glass" size="sm" onClick={() => download('json')}><Download className="h-3.5 w-3.5" />JSON</Button>
          <Button variant="glass" size="sm" onClick={() => setRetention({ open: true, cutoff: '', preview: null })}><Clock className="h-3.5 w-3.5" />{t('audit.retention')}</Button>
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs text-muted-foreground">{t('audit.hint')}</p>
        <div className="mb-4 grid gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Field label={t('audit.server')} htmlFor="audit-filter-server">
            <Input id="audit-filter-server" value={filters.serverId} onChange={field('serverId')} placeholder={t('audit.server')} />
          </Field>
          <Field label={t('audit.actor')} htmlFor="audit-filter-actor">
            <Input id="audit-filter-actor" value={filters.actorId} onChange={field('actorId')} placeholder={t('audit.actor')} />
          </Field>
          <Field label={t('audit.action')} htmlFor="audit-filter-action">
            <Input id="audit-filter-action" value={filters.action} onChange={field('action')} placeholder={t('audit.action')} />
          </Field>
          <Field label={t('audit.outcome')} htmlFor="audit-filter-outcome">
            <NativeSelect id="audit-filter-outcome" value={filters.outcome} onChange={field('outcome')} options={[{ value: '', label: t('audit.anyOutcome') }, { value: 'success', label: t('audit.success') }, { value: 'failure', label: t('audit.failure') }, { value: 'denied', label: t('audit.denied') }]} />
          </Field>
          <Field label={t('audit.from')} htmlFor="audit-filter-from">
            <Input id="audit-filter-from" type="date" value={filters.from} onChange={field('from')} />
          </Field>
          <Field label={t('audit.to')} htmlFor="audit-filter-to">
            <Input id="audit-filter-to" type="date" value={filters.to} onChange={field('to')} />
          </Field>
        </div>
        <Button size="sm" className="mb-4" onClick={applyFilters}><Search className="h-3.5 w-3.5" />{t('audit.filter')}</Button>
        {loading && items.length === 0 ? <Loading /> : items.length === 0 ? <EmptyState icon={ShieldCheck} title={t('audit.empty')} /> : <>
          <p className="mb-2 text-xs text-muted-foreground">{t(cursor ? 'audit.countPartial' : 'audit.count', { count: items.length })}</p>
          <Table>
          <TableHeader><TableRow><TableHead>{t('audit.date')}</TableHead><TableHead>{t('audit.actor')}</TableHead><TableHead>{t('audit.server')}</TableHead><TableHead>{t('audit.action')}</TableHead><TableHead>{t('audit.outcome')}</TableHead></TableRow></TableHeader>
          <TableBody>{items.map((event) => {
            const rel = relativeSuffix(event.ts, t);
            return <TableRow key={event.id} className="cursor-pointer" onClick={() => setDetail(event)}>
              <TableCell className="whitespace-nowrap text-xs">
                {new Date(event.ts).toLocaleString()}
                {rel && <span className="ml-1 text-muted-foreground/70">({rel})</span>}
              </TableCell>
              <TableCell>{event.actorUsername || event.actorId || t('audit.system')}</TableCell>
              <TableCell>{event.serverId || '—'}</TableCell><TableCell className="text-xs">{event.action}</TableCell>
              <TableCell><Badge variant={event.outcome === 'success' ? 'softPrimary' : 'destructive'}>{event.outcome}</Badge></TableCell>
            </TableRow>;
          })}</TableBody>
        </Table>
        </>}
        {cursor && <Button variant="glass" size="sm" className="mt-4" disabled={loading} onClick={() => load(applied, cursor)}>{t('audit.loadMore')}</Button>}
      </CardContent>
    </Card>
    <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}><DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{t('audit.details')}</DialogTitle></DialogHeader><pre className="m-5 max-h-[60vh] overflow-auto rounded-lg bg-muted p-4 text-xs whitespace-pre-wrap">{JSON.stringify(detail, null, 2)}</pre></DialogContent></Dialog>
    <Dialog open={retention.open} onOpenChange={(open) => setRetention((value) => ({ ...value, open }))}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('audit.retentionTitle')}</DialogTitle></DialogHeader><div className="space-y-3 px-5 py-4"><p className="text-xs text-muted-foreground">{t('audit.retentionHint')}</p><Input type="date" value={retention.cutoff} onChange={(event) => setRetention({ ...retention, cutoff: event.target.value, preview: null })} />{retention.preview && <p className="rounded-lg bg-destructive/15 p-3 text-sm">{t('audit.retentionCount', { count: retention.preview.count })}</p>}</div><DialogFooter><Button variant="glass" onClick={() => setRetention({ ...retention, open: false })}>{t('common.cancel')}</Button>{retention.preview ? <Button variant="destructive" onClick={applyRetention}>{t('audit.confirmDelete')}</Button> : <Button onClick={previewRetention}>{t('audit.preview')}</Button>}</DialogFooter></DialogContent></Dialog>
  </>;
}
