import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { ErrorState } from '@/components/shared/ErrorState';
import { PromptDialog } from '@/components/shared/PromptDialog';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';
import { fmtBytesRaw, joinRel } from '@/lib/utils';
import { Folder, FileText, ChevronUp, Upload, FolderPlus, RefreshCw, Pencil, PencilLine, Trash2, Download, Search, X } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';

export function FileManagerView() {
  const api = useApi();
  const t = useT();
  const { token } = useAuth();
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editFile, setEditFile] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [editOriginal, setEditOriginal] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingEditorClose, setPendingEditorClose] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null);
  const [showMkdir, setShowMkdir] = useState(false);

  async function load(rel) {
    const p = rel ?? path;
    setLoading(true);
    setError('');
    try {
      const data = await api(`/api/files?path=${encodeURIComponent(p)}`);
      setPath(data.path || '');
      setEntries(data.entries || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { load(''); }, []);

  async function goUp() {
    const i = path.lastIndexOf('/');
    await load(i === -1 ? '' : path.slice(0, i));
  }

  async function fileAction(act, e) {
    const rel = joinRel(path, e.name);
    if (act === 'edit') {
      try {
        const { content } = await api(`/api/files/read?path=${encodeURIComponent(rel)}`);
        setEditFile({ rel, name: e.name });
        setEditContent(content);
        setEditOriginal(content);
      } catch (err) { toast.error(err.message); }
      return;
    }
    if (act === 'rename') {
      setRenameTarget({ rel, name: e.name });
      return;
    }
    if (act === 'delete') {
      setPendingDelete({ rel, name: e.name, isDir: e.dir });
      return;
    }
  }

  function doRename(name) {
    if (!renameTarget || name === renameTarget.name) return;
    api('/api/files/rename', { method: 'POST', body: { path: renameTarget.rel, name } })
      .then(() => load()).catch(err => toast.error(err.message));
  }

  function doMkdir(name) {
    api('/api/files/mkdir', { method: 'POST', body: { path, name } })
      .then(() => load()).catch(err => toast.error(err.message));
  }

  async function upload(e) {
    if (!e.target.files.length) return;
    const fd = new FormData();
    for (const f of e.target.files) fd.append('files', f);
    try {
      await api(`/api/files/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: fd });
      toast.success(t('files.uploadedToast'));
      load();
    } catch (err) { toast.error(err.message); }
    e.target.value = '';
  }

  async function saveEdit() {
    try {
      await api('/api/files/write', { method: 'PUT', body: { path: editFile.rel, content: editContent } });
      setEditFile(null);
      setEditOriginal('');
      toast.success(t('files.savedToast'));
    } catch (e) { toast.error(e.message); }
  }

  function closeEditor() {
    if (editContent !== editOriginal) {
      setPendingEditorClose(true);
      return;
    }
    setEditFile(null);
    setEditOriginal('');
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleEntries = normalizedQuery
    ? entries.filter(e => e.name.toLowerCase().includes(normalizedQuery))
    : entries;

  return (
    <>
      <div className="space-y-6">
        <ViewHeader
          actions={
            <>
              <Button variant="default" size="sm" asChild>
                <label className="cursor-pointer">
                  <Upload className="h-3.5 w-3.5" />
                  {t('files.upload')}
                  <input type="file" multiple hidden onChange={upload} />
                </label>
              </Button>
              <Button variant="glass" size="sm" onClick={() => setShowMkdir(true)}><FolderPlus className="h-3.5 w-3.5" /> {t('files.folder')}</Button>
              <Button variant="glass" size="icon-sm" onClick={() => load()} aria-label={t('common.refresh')}><RefreshCw className="h-3.5 w-3.5" /></Button>
            </>
          }
        />
        <Card>
          <CardContent>
            {/* Breadcrumb + search: intrinsic to the file surface, so it stays here */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">
                <Button variant="glass" size="xs" onClick={goUp} disabled={!path}>
                  <ChevronUp className="h-3 w-3" /> {t('files.up')}
                </Button>
                <span className="truncate text-xs text-primary">/{path}</span>
              </div>
              <div className="relative min-w-[200px] sm:w-[260px]">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t('files.searchPlaceholder')}
                  className="h-8 rounded-full bg-secondary/40 pl-8 pr-8 text-xs"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    aria-label={t('files.clearSearch')}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <Loading />
            ) : error ? (
              <ErrorState error={error} onRetry={() => load()} />
            ) : visibleEntries.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center text-sm text-muted-foreground">
                {normalizedQuery ? t('files.emptySearch') : t('files.empty')}
              </p>
            ) : (
              <div className="-mx-5 -mb-5 border-t-2 border-border">
                <Table>
                  <TableBody>
                    {visibleEntries.map(e => {
                      const rel = joinRel(path, e.name);
                      return (
                        <TableRow
                          key={e.name}
                          className={cn('group', e.dir && 'cursor-pointer')}
                          onClick={e.dir ? () => load(rel) : undefined}
                        >
                          <TableCell className="pl-5">
                            <span className="flex items-center gap-2.5">
                              {e.dir
                                ? <Folder className="h-4 w-4 shrink-0 text-primary" />
                                : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                              <span
                                className={cn('truncate font-medium text-foreground', e.editable && !e.dir && 'cursor-pointer hover:text-primary')}
                                onClick={e.editable && !e.dir ? (ev) => { ev.stopPropagation(); fileAction('edit', e); } : undefined}
                              >
                                {e.name}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
                            {!e.dir && fmtBytesRaw(e.size)}
                          </TableCell>
                          <TableCell className="hidden whitespace-nowrap text-right text-xs text-muted-foreground sm:table-cell">
                            {!e.dir && new Date(e.mtime).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="pr-5">
                            <div className="flex items-center justify-end gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                              {e.editable && !e.dir && (
                                <Button variant="ghost" size="icon-xs" onClick={ev => { ev.stopPropagation(); fileAction('edit', e); }} title={t('files.edit')} aria-label={t('files.edit')}>
                                  <Pencil className="h-3 w-3" />
                                </Button>
                              )}
                              {!e.dir && (
                                <Button variant="ghost" size="icon-xs" asChild onClick={ev => ev.stopPropagation()}>
                                  <a href={`/api/files/download?path=${encodeURIComponent(rel)}&token=${encodeURIComponent(token)}`} download title={t('files.download')} aria-label={t('files.download')}>
                                    <Download className="h-3 w-3" />
                                  </a>
                                </Button>
                              )}
                              <Button variant="ghost" size="icon-xs" onClick={ev => { ev.stopPropagation(); fileAction('rename', e); }} title={t('files.rename')} aria-label={t('files.rename')}>
                                <PencilLine className="h-3 w-3" />
                              </Button>
                              <Button variant="ghost" size="icon-xs"
                                onClick={ev => { ev.stopPropagation(); fileAction('delete', e); }} title={t('common.delete')} aria-label={t('common.delete')}>
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* File editor dialog */}
      <Dialog open={!!editFile} onOpenChange={open => { if (!open) closeEditor(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>{editFile?.name}</DialogTitle></DialogHeader>
          <div className="px-5 py-4">
            <textarea
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              spellCheck={false}
              className="w-full h-[50vh] rounded-md border border-input bg-console px-3 py-2 font-mono text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 resize-y"
            />
          </div>
          <DialogFooter>
            {editContent !== editOriginal && (
              <span className="mr-auto self-center text-xs text-status-warn">{t('configs.unsavedChanges')}</span>
            )}
            <Button variant="glass" onClick={closeEditor}>{t('common.cancel')}</Button>
            <Button variant="default" onClick={saveEdit} disabled={editContent === editOriginal}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingEditorClose}
        onOpenChange={setPendingEditorClose}
        title={t('files.unsavedTitle')}
        description={editFile ? t('files.unsavedBody', { name: editFile.name }) : ''}
        confirmLabel={t('files.discard')}
        destructive
        onConfirm={() => {
          setPendingEditorClose(false);
          setEditFile(null);
          setEditOriginal('');
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title={t('files.deleteTitle')}
        description={pendingDelete
          ? (pendingDelete.isDir
              ? t('files.deleteFolderBody', { name: pendingDelete.name, andEverything: t('common.andEverything'), cannotUndo: t('common.cannotUndo') })
              : t('files.deleteFileBody', { name: pendingDelete.name }))
          : ''}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={async () => {
          try {
            await api(`/api/files?path=${encodeURIComponent(pendingDelete.rel)}`, { method: 'DELETE' });
            toast.success(t('files.deletedToast'));
            load();
          } catch (e) { toast.error(e.message); }
        }}
      />

      <PromptDialog
        open={!!renameTarget}
        onOpenChange={(o) => { if (!o) setRenameTarget(null); }}
        title={t('files.rename')}
        label={t('files.renamePrompt')}
        defaultValue={renameTarget?.name || ''}
        confirmLabel={t('common.save')}
        onSubmit={doRename}
      />

      <PromptDialog
        open={showMkdir}
        onOpenChange={setShowMkdir}
        title={t('files.folder')}
        label={t('files.newFolderPrompt')}
        placeholder={t('files.newFolderPrompt')}
        confirmLabel={t('common.add')}
        onSubmit={doMkdir}
      />
    </>
  );
}
