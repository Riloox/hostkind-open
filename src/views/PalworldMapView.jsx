import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Crosshair, Eye, EyeOff, LocateFixed, Map as MapIcon, Minus, Plus, RotateCcw, Search, Settings, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

function ageLabel(t, value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  return seconds < 2 ? t('palworld.map.now') : t('palworld.map.secondsAgo', { seconds });
}

// Bounds that frame every observed player with a margin, so an admin can align a
// custom map to the world without reading coordinates out of the game by hand.
function boundsAroundPlayers(players) {
  const xs = players.map((player) => Number(player.location.x)).filter(Number.isFinite);
  const ys = players.map((player) => Number(player.location.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1000);
  const padding = span * 0.6;
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  return {
    minX: Math.round(centerX - span / 2 - padding),
    maxX: Math.round(centerX + span / 2 + padding),
    minY: Math.round(centerY - span / 2 - padding),
    maxY: Math.round(centerY + span / 2 + padding),
  };
}

function CalibrationDialog({ open, onOpenChange, data, players, onSaved }) {
  const api = useApi();
  const t = useT();
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      source: data?.asset?.builtin ? '' : data?.asset?.source || '',
      author: data?.asset?.builtin ? '' : data?.asset?.author || '',
      license: data?.asset?.builtin ? '' : data?.asset?.license || '',
      version: data?.asset?.builtin ? '' : data?.asset?.version || '',
      bounds: data?.calibration?.bounds || data?.defaults?.bounds || {},
      contentRect: data?.calibration?.contentRect || null,
      assetData: '',
      fileName: '',
    });
    setPreview(null);
    setAdvanced(false);
  }, [open, data]);

  const update = (key, value) => { setPreview(null); setForm((current) => ({ ...current, [key]: value })); };
  const updateBound = (key, value) => { setPreview(null); setForm((current) => ({ ...current, bounds: { ...current.bounds, [key]: value } })); };
  const applyBounds = (bounds) => { setPreview(null); setForm((current) => ({ ...current, bounds })); };
  const chooseFile = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setForm((current) => ({ ...current, assetData: reader.result, fileName: file.name }));
      // A padded-to-square upload carries letterbox bars; the world bounds map
      // onto the content band only. Derive the band from the image's own aspect
      // so markers land on the artwork, not the padding.
      const probe = new Image();
      probe.onload = () => {
        const side = Math.max(probe.naturalWidth, probe.naturalHeight) || 1;
        const padLeft = Math.max(0, Math.round((side - probe.naturalWidth) / 2));
        const padTop = Math.max(0, Math.round((side - probe.naturalHeight) / 2));
        setForm((current) => ({
          ...current,
          contentRect: {
            u0: padLeft / side,
            v0: padTop / side,
            u1: 1 - (side - probe.naturalWidth - padLeft) / side,
            v1: 1 - (side - probe.naturalHeight - padTop) / side,
          },
        }));
      };
      probe.src = reader.result;
    };
    setPreview(null);
    reader.readAsDataURL(file);
  };
  const fitToPlayers = () => {
    const bounds = boundsAroundPlayers(players);
    if (!bounds) return toast.error(t('palworld.map.fitUnavailable'));
    applyBounds(bounds);
  };
  const resetToDefault = async () => {
    setBusy(true);
    try {
      const result = await api('/api/palworld/map/calibration', { method: 'PUT', body: { resetToDefault: true } });
      toast.success(t('palworld.map.resetDone'));
      onSaved(result);
      onOpenChange(false);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  };
  const submit = async (previewOnly) => {
    setBusy(true);
    try {
      const result = await api('/api/palworld/map/calibration', {
        method: 'PUT',
        body: {
          revision: data.revision,
          preview: previewOnly,
          previewToken: previewOnly ? undefined : preview?.previewToken,
          asset: { source: form.source, author: form.author, license: form.license, version: form.version },
          assetData: form.assetData || undefined,
          contentRect: form.contentRect || undefined,
          bounds: form.bounds,
        },
      });
      if (previewOnly) setPreview(result);
      else {
        toast.success(t('palworld.map.saved'));
        onSaved(result);
        onOpenChange(false);
      }
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true);
    try {
      const result = await api('/api/palworld/map/calibration', {
        method: 'PUT', body: { restoreRevision: data.previousRevision },
      });
      onSaved(result);
      onOpenChange(false);
      toast.success(t('palworld.map.restored'));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  };

  if (!form) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('palworld.map.calibration')}</DialogTitle>
          <DialogDescription>{t('palworld.map.calibrationHint')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="flex items-center gap-3 border border-border bg-secondary/30 p-3 text-xs">
            <MapIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 text-muted-foreground">
              {form.fileName || (data.asset?.builtin ? t('palworld.map.usingBuiltIn') : data.asset?.source || t('palworld.map.usingCustom'))}
            </span>
            <span className="text-label text-muted-foreground">{data.calibration?.assetVersion}</span>
          </div>

          <label className="block space-y-1 text-xs font-semibold text-muted-foreground">
            {t('palworld.map.replaceImage')}
            <Input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseFile} />
            <span className="block font-normal normal-case">{t('palworld.map.replaceImageHint')}</span>
          </label>

          {/* Provenance is only meaningful for an image the admin supplies, so it
              stays out of the way until one is chosen - and stays optional. */}
          {form.assetData && (
            <div className="grid gap-3 sm:grid-cols-2">
              {['source', 'author', 'license', 'version'].map((key) => (
                <label key={key} className="space-y-1 text-xs font-semibold text-muted-foreground">
                  {t(`palworld.map.${key}`)} <span className="font-normal">{t('palworld.map.optional')}</span>
                  <Input value={form[key]} onChange={(event) => update(key, event.target.value)} />
                </label>
              ))}
            </div>
          )}

          <div className="border-t border-border pt-4">
            <Button variant="ghost" size="sm" className="px-0" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {t('palworld.map.worldBounds')}
            </Button>
            {advanced && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-muted-foreground">{t('palworld.map.worldBoundsHint')}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {['minX', 'maxX', 'minY', 'maxY'].map((key) => (
                    <label key={key} className="space-y-1 text-xs text-muted-foreground">
                      {key}
                      <Input type="number" value={form.bounds[key]} onChange={(event) => updateBound(key, event.target.value)} />
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={fitToPlayers}><LocateFixed className="h-4 w-4" />{t('palworld.map.fitToPlayers')}</Button>
                  <Button variant="outline" size="sm" onClick={() => applyBounds(data.defaults.bounds)}>{t('palworld.map.useDefaultBounds')}</Button>
                </div>
              </div>
            )}
          </div>

          {preview && (
            <div className="border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
              {t('palworld.map.previewReady', { checksum: preview.asset.checksum.slice(0, 23) })}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {!data.isDefault && <Button variant="ghost" disabled={busy} onClick={resetToDefault}><Undo2 className="h-4 w-4" />{t('palworld.map.resetToDefault')}</Button>}
          {data.previousRevision && <Button variant="ghost" disabled={busy} onClick={restore}><RotateCcw className="h-4 w-4" />{t('palworld.map.restore')}</Button>}
          <Button variant="outline" disabled={busy} onClick={() => submit(true)}>{t('palworld.map.preview')}</Button>
          <Button disabled={busy || !preview} onClick={() => submit(false)}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PalworldMapView() {
  const api = useApi();
  const t = useT();
  const { token, user, hasCapability } = useAuth();
  const { activeServer, activeServerId } = useServer();
  const viewportRef = useRef(null);
  const dragRef = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [playerAction, setPlayerAction] = useState(null);
  const canManage = user?.role === 'admin' && hasCapability('map.manage', activeServerId);
  const canManagePlayers = hasCapability('players.manage', activeServerId);

  const load = useCallback(async () => {
    try {
      const result = await api('/api/palworld/map');
      setData(result);
      setError('');
    } catch (loadError) { setError(loadError.message); }
  }, [api]);

  useEffect(() => {
    load();
    let timer;
    const schedule = () => {
      clearInterval(timer);
      timer = setInterval(load, document.hidden ? 30000 : 10000);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [load]);

  // React attaches synthetic wheel listeners passively at the root, so
  // preventDefault() inside onWheel is ignored (the page scrolls while the map
  // zooms) and Chrome logs a warning on every tick. Attach a native non-passive
  // listener to the canvas instead; keyed on readiness so it binds exactly once.
  const mapReady = !!(data?.asset && data?.calibration);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      setTransform((current) => ({
        ...current,
        scale: Math.max(0.5, Math.min(5, current.scale * (event.deltaY > 0 ? 0.9 : 1.1))),
      }));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [mapReady]);

  const players = useMemo(() => (data?.players || []).filter((player) => player.location && player.mapPosition), [data]);
  const filtered = useMemo(() => players.filter((player) => player.name.toLowerCase().includes(query.toLowerCase())), [players, query]);
  const imageUrl = data?.asset?.url ? `${data.asset.url}&token=${encodeURIComponent(token)}` : '';
  const setScale = (scale) => setTransform((current) => ({ ...current, scale: Math.max(0.5, Math.min(5, scale)) }));
  const reset = () => setTransform({ x: 0, y: 0, scale: 1 });
  const fitPlayers = () => {
    const visible = players.filter((player) => !hidden.has(player.userId) && player.mapPosition.inBounds);
    if (!visible.length) return reset();
    const us = visible.map((player) => player.mapPosition.u);
    const vs = visible.map((player) => player.mapPosition.v);
    const span = Math.max(Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs), 0.15);
    setTransform({ x: 0, y: 0, scale: Math.min(4, 0.8 / span) });
  };
  const toggle = (id) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const applyPlayerAction = async () => {
    const action = playerAction;
    if (!action) return;
    try {
      await api(`/api/palworld/players/${encodeURIComponent(action.player.userId)}/${action.type}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: {},
      });
      toast.success(t(`palworld.${action.type}Accepted`));
      setSelected(null);
      load();
    } catch (actionError) { toast.error(actionError.message); }
  };
  const pointerDown = (event) => {
    // A marker button is a child of the canvas. Capturing the pointer for any
    // pointerdown inside it would retarget the subsequent click to the canvas
    // and the marker's onClick would never fire - so only start a drag from
    // the canvas/map itself, never from a button (marker, zoom, etc.).
    if (event.target.closest?.('button')) return;
    dragRef.current = { x: event.clientX, y: event.clientY, originX: transform.x, originY: transform.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    setTransform((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.x,
      y: drag.originY + event.clientY - drag.y,
    }));
  };

  return (
    <div className="space-y-4">
      <ViewHeader actions={canManage && (
        <Button variant="glass" size="sm" onClick={() => setCalibrationOpen(true)}><Settings className="h-4 w-4" />{t('palworld.map.calibration')}</Button>
      )} />
      <div className="grid min-h-[70vh] gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="relative min-h-[55vh] overflow-hidden border-2">
          {/* The bundled map means `asset` is always present for a Palworld
              server; this branch only covers the first load and error states. */}
          {!data?.asset || !data?.calibration ? (
            <div className="absolute inset-0 flex items-center justify-center">
              {data && <EmptyState icon={MapIcon} title={t('palworld.map.noAsset')} message={canManage ? t('palworld.map.noAssetAdmin') : t('palworld.map.noAssetViewer')} />}
            </div>
          ) : (
            <>
              <div className="absolute left-3 top-3 z-20 flex gap-1">
                <Button size="icon" variant="secondary" aria-label={t('palworld.map.zoomIn')} onClick={() => setScale(transform.scale * 1.25)}><Plus className="h-4 w-4" /></Button>
                <Button size="icon" variant="secondary" aria-label={t('palworld.map.zoomOut')} onClick={() => setScale(transform.scale / 1.25)}><Minus className="h-4 w-4" /></Button>
                <Button size="icon" variant="secondary" aria-label={t('palworld.map.reset')} onClick={reset}><Crosshair className="h-4 w-4" /></Button>
                <Button size="icon" variant="secondary" aria-label={t('palworld.map.fitPlayers')} onClick={fitPlayers}><LocateFixed className="h-4 w-4" /></Button>
              </div>
              <div className={`absolute right-3 top-3 z-20 border px-2 py-1 text-xs font-semibold ${data.restHealth?.state === 'healthy' ? 'border-status-online/40 bg-background text-status-online' : 'border-status-warn/40 bg-background text-status-warn'}`}>
                {data.restHealth?.state === 'healthy' ? t('palworld.map.live') : t('palworld.map.stale')}
              </div>
              <div
                ref={viewportRef}
                tabIndex={0}
                role="application"
                aria-label={t('palworld.map.canvasLabel')}
                className="absolute inset-0 cursor-grab overflow-hidden bg-background focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring active:cursor-grabbing"
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={() => { dragRef.current = null; }}
                onPointerCancel={() => { dragRef.current = null; }}
                onKeyDown={(event) => {
                  const delta = event.shiftKey ? 60 : 20;
                  if (event.key === '+') setScale(transform.scale * 1.25);
                  else if (event.key === '-') setScale(transform.scale / 1.25);
                  else if (event.key.startsWith('Arrow')) {
                    event.preventDefault();
                    setTransform((current) => ({ ...current, x: current.x + (event.key === 'ArrowLeft' ? delta : event.key === 'ArrowRight' ? -delta : 0), y: current.y + (event.key === 'ArrowUp' ? delta : event.key === 'ArrowDown' ? -delta : 0) }));
                  }
                }}
              >
                {/* Markers live inside the image box, not the card, so they stay
                    aligned regardless of how wide the viewport is. */}
                <div className="absolute inset-0 flex origin-center items-center justify-center motion-reduce:transition-none" style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}>
                  <div className="relative aspect-square h-full max-h-full w-auto max-w-full">
                  {/* A custom map may be any shape; letting it fill the square
                      would stretch it away from the content rect calibration
                      was measured against, so it is contained, not stretched. */}
                  <img src={imageUrl} alt="" draggable="false" className="h-full w-full select-none object-contain" />
                  {players.map((player) => {
                    if (hidden.has(player.userId) || !player.mapPosition.inBounds) return null;
                    const isSelected = selected?.userId === player.userId;
                    const tone = player.state === 'live' ? 'bg-status-online' : player.state === 'offline' ? 'bg-muted-foreground' : 'bg-status-warn';
                    return (
                      <button
                        key={player.userId}
                        type="button"
                        className={`group absolute h-5 w-5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${player.state === 'offline' ? 'opacity-70' : ''}`}
                        style={{
                          left: `${player.mapPosition.u * 100}%`,
                          top: `${player.mapPosition.v * 100}%`,
                          // Markers ride inside the zoomed canvas, so undo the
                          // zoom: a pin stays the same readable, clickable size
                          // whether the map is at 0.5x or 5x.
                          transform: `translate(-50%, -50%) scale(${1 / transform.scale})`,
                          zIndex: isSelected ? 20 : 10,
                        }}
                        onClick={(event) => { event.stopPropagation(); setSelected(player); }}
                        aria-label={`${player.name}, ${ageLabel(t, player.observedAt)}`}
                        aria-pressed={isSelected}
                      >
                        {/* A live player gets the expanding ring; a stale or
                            offline one holds still so the difference reads at
                            a glance without needing the legend. */}
                        {player.state === 'live' && (
                          <span aria-hidden className={`absolute inset-1 rounded-full opacity-70 motion-reduce:hidden ${tone} animate-pulse-ring`} />
                        )}
                        <span aria-hidden className={`absolute inset-1 rounded-full opacity-40 blur-[4px] ${tone}`} />
                        <span aria-hidden className={`absolute left-1/2 top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow-[var(--shadow-sm)] ${tone}`} />
                        {isSelected && <span aria-hidden className="absolute inset-0 rounded-full border-2 border-foreground" />}
                        <span className={`pointer-events-none absolute left-1/2 top-full max-w-[9rem] -translate-x-1/2 truncate whitespace-nowrap border border-border bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold leading-tight transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}>
                          {player.name}
                        </span>
                      </button>
                    );
                  })}
                  </div>
                </div>
              </div>
            </>
          )}
          {(error || (data && data.restHealth?.state !== 'healthy')) && (
            <div className="absolute bottom-3 left-3 right-3 z-20 border border-status-warn/40 bg-background/95 px-3 py-2 text-xs text-status-warn">
              {error || t('palworld.map.interrupted')}
            </div>
          )}
        </Card>
        <Card className="flex max-h-[32rem] min-h-0 flex-col overflow-hidden border-2 lg:max-h-none">
          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-3 top-3.5 h-4 w-4 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('palworld.map.search')} className="pl-9" />
            </div>
            <Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={() => setHidden(hidden.size ? new Set() : new Set(players.map((player) => player.userId)))}>
              {hidden.size ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
              {hidden.size ? t('palworld.map.showAll') : t('palworld.map.hideAll')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.map((player) => (
              <button key={player.userId} className={`flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left hover:bg-secondary/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring ${selected?.userId === player.userId ? 'bg-secondary' : ''}`} onClick={() => setSelected(player)}>
                <span onClick={(event) => { event.stopPropagation(); toggle(player.userId); }} className="text-muted-foreground">{hidden.has(player.userId) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{player.name}</span>
                  <span className="block text-xs text-muted-foreground">{ageLabel(t, player.observedAt)}</span>
                </span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="border-t-2 border-border bg-secondary/25 p-3">
              <p className="font-display text-sm font-extrabold uppercase">{selected.name}</p>
              {/* The grid the game shows its own players comes first: it is the
                  pair an admin can read out and have the player recognise. The
                  raw Unreal coordinates stay underneath for anyone matching a
                  save file or a REST response, rounded because the fractional
                  part is centimetres of a 918000-unit world. */}
              {selected.mapGrid && (
                <p className="mt-1 font-mono text-sm">{t('palworld.map.gridCoords', { x: selected.mapGrid.x, y: selected.mapGrid.y })}</p>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('palworld.map.worldCoords', {
                  x: Math.round(selected.location.x),
                  y: Math.round(selected.location.y),
                  z: selected.location.z == null ? '—' : Math.round(selected.location.z),
                })}
              </p>
              {!selected.mapPosition.inBounds && <p className="mt-2 text-xs text-status-warn">{t('palworld.map.outOfBounds')}</p>}
              {canManagePlayers && selected.state === 'live' && (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPlayerAction({ type: 'kick', player: selected })}>{t('palworld.kick')}</Button>
                  <Button size="sm" variant="destructive" onClick={() => setPlayerAction({ type: 'ban', player: selected })}>{t('palworld.ban')}</Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
      {canManage && data && <CalibrationDialog open={calibrationOpen} onOpenChange={setCalibrationOpen} data={data} players={players} onSaved={(result) => setData((current) => ({ ...current, ...result }))} />}
      <ConfirmDialog
        open={!!playerAction}
        onOpenChange={(open) => !open && setPlayerAction(null)}
        title={playerAction ? t(`palworld.confirm${playerAction.type === 'kick' ? 'Kick' : 'Ban'}Title`) : ''}
        description={playerAction ? t('palworld.confirmPlayerAction', { action: t(`palworld.${playerAction.type}`), player: playerAction.player.name, server: activeServer?.name || '' }) : ''}
        confirmLabel={playerAction ? t(`palworld.${playerAction.type}`) : ''}
        destructive={playerAction?.type === 'ban'}
        onConfirm={applyPlayerAction}
      />
    </div>
  );
}
