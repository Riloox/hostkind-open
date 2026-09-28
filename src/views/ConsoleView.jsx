import { useState, useRef, useEffect, useCallback } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { Send, ArrowDown, Search, X, Globe2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StartServerButton } from '@/components/shared/StartServerButton';

function detectLevel(text) {
  if (!text) return '';
  const e = String(text).toUpperCase();
  if (e.includes('ERROR') || e.includes('SEVERE') || e.includes('STDERR') ||
      e.includes('EXCEPTION') || e.includes('CAUSED BY')) return 'error';
  if (e.includes('WARN')) return 'warn';
  if (e.includes('JOINED THE GAME') || e.includes('LEFT THE GAME')) return 'chat';
  if (e.includes('INFO')) return 'info';
  return '';
}

const LEVEL_BAR = {
  info:  'bg-log-info',
  warn:  'bg-log-warn',
  error: 'bg-log-error',
  cmd:   'bg-log-cmd',
  chat:  'bg-log-chat',
};

const MAX_LINES = 1200;
const HISTORY_KEY = 'fleetdeck.console.history';
const HISTORY_LIMIT = 50;

// Example commands in the input match the game; the default is Minecraft's.
const COMMAND_PLACEHOLDERS = {
  terraria: 'console.commandPlaceholderTerraria',
  palworld: 'console.commandPlaceholderPalworld',
};

// Strip the many Minecraft log header shapes that come in front of real text
// so our custom timestamp column is the only one shown. This covers, in order:
//
//   [HH:MM:SS INFO]:                      Spigot/CraftBukkit
//   [HH:MM:SS] [Server thread/INFO]:      Vanilla / Paper
//   [HH:MM:SS] [thread/INFO] [mod/LEVEL]:  Forge / Fabric / mod loaders
//   [HH:MM:SS.mmm] [main/INFO]:           Minecraft 1.21+ seconds precision
//   [2024-12-31T12:34:56.789Z] [m/INFO]:  ISO full-date (some plugins/log4j)
//
// The leading bracket (date ISO, abbreviated date, or time)+optional space+ategor +
// zero+ following bracket groups (thread/level and trailing [mod/LEVEL]) + colon +
// spaces is removed.  Then an optional plugin-supplied nested timestamp like
// `[HH:MM:SS]` or `[HH:MM:SS.mmm]` left right at the start of the remaining text
// is also removed — an in-line duplicate timestamp that some plugins (Essentials,
// LogBlock, ...) prepend inside their own messages.  This second stripping is only
// applied at the start of the cleaned message so we never over-strip real content.
const MC_TS_RE = new RegExp(
  '^' +
  '(?:' +                                       // leading timestamp bracket
    '\\[\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?\\]' +       // ISO date+time
    '|' +
    '\\[\\d{1,2}\\s[A-Za-z]{3}\\s\\d{4}\\s\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?\\]' + // 31Dec2024 12:34:56
    '|' +
    '\\[\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:\\s+[A-Za-z]+)?\\]' +                // time [+ category]
  ')' +
  '(?:\\s*\\[[^\\]]*\\])*' +                  // 0..N [thread/level] / [mod/level] groups
  '\\s*:\\s*',                                // colon + spaces separator
);
// A leftover plugin-style timestamp that some plugins prepend inside their own
// messages *after* the MC header has already been stripped.
const PLUGIN_TS_RE = /^\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]\s+/;
function stripMcTs(text) {
  if (!text) return text;
  let out = text.replace(MC_TS_RE, '');
  out = out.replace(PLUGIN_TS_RE, '');
  return out;
}

function fmtTs(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':') +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/*
 * The Terraria strip above the console (docs/terraria/02-lifecycle-console.md
 * step 8).
 *
 * Three things a Terraria operator cannot get from the raw stream:
 *
 *   - the server is blocked on its world menu and will never finish starting.
 *     Without this it looks exactly like a hang, and the watchdog eventually
 *     kills a server that was only asking a question;
 *   - a long start (mod loading, world generation) is progressing. Both print
 *     hundreds of lines a second, so they belong on one status line rather than
 *     in the scrollback;
 *   - which variant and version is actually running.
 */
function TerrariaStatus({ status, onNavigate, worldsReachable }) {
  const t = useT();
  if (!status || !status.terrariaVariant) return null;

  const worldgen = status.terrariaWorldgen;
  const progress = worldgen
    ? (worldgen.stage
      ? t('terraria.console.generatingWorld', { stage: worldgen.stage, percent: Math.round(worldgen.percent) })
      : t('terraria.console.generatingWorldPlain', { percent: Math.round(worldgen.percent) }))
    : (status.terrariaModLoading ? t('terraria.console.loadingMods', { mod: status.terrariaModLoading }) : null);

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="default" title={t('terraria.console.variantLabel')}>
          {t(`terraria.variant.${status.terrariaVariant}`)}
        </Badge>
        {status.terrariaVersion?.game && (
          <Badge variant="default" title={t('terraria.console.versionLabel')}>
            {status.terrariaVersion.game}
            {status.terrariaVersion.variant ? ` / ${status.terrariaVersion.variant}` : ''}
          </Badge>
        )}
        {progress && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress}
          </span>
        )}
      </div>

      {status.awaitingWorldSelection && (
        <Alert variant="warn" className="flex-col items-start gap-1.5">
          <span className="font-semibold">{t('terraria.console.awaitingWorldTitle')}</span>
          <span className="text-muted-foreground">{t('terraria.console.awaitingWorldBody')}</span>
          {/*
            * The call to action appears once there is somewhere for it to go.
            * The worlds view is gated on the `worlds` capability, which
            * Terraria does not declare until phase 3; a button that lands on a
            * view the sidebar will not show is worse than no button. The
            * explanation above it is the part that matters today.
            */}
          {onNavigate && worldsReachable && (
            <Button type="button" variant="outline" size="xs" onClick={() => onNavigate('worlds')}>
              <Globe2 className="h-3 w-3" />
              {t('terraria.console.openWorlds')}
            </Button>
          )}
        </Alert>
      )}
    </div>
  );
}

function ValheimStatus({ status }) {
  const t = useT();
  const valheim = status?.valheim;
  if (!valheim) return null;
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={valheim.readyEvidence ? 'softSuccess' : 'default'}>
          {valheim.readyEvidence ? t('valheim.console.ready') : t('valheim.console.starting')}
        </Badge>
        {valheim.save?.inProgress && <Badge variant="softWarn">{t('valheim.console.saving')}</Badge>}
        {valheim.save?.lastObservedAt && (
          <span className="text-muted-foreground">{t('valheim.console.lastSave', { time: new Date(valheim.save.lastObservedAt).toLocaleString() })}</span>
        )}
      </div>
      {valheim.readinessTimedOut && <Alert variant="warn">{t('valheim.console.timeout')}</Alert>}
      {valheim.integrityWarning && <Alert variant="warn">{t('valheim.console.integrityWarning')}</Alert>}
      {status.pid && !valheim.readyEvidence && status.status === 'online' && (
        <Alert variant="warn">{t('valheim.console.detached')}</Alert>
      )}
      {!!valheim.observedConnections?.length && (
        <div className="text-xs text-muted-foreground">
          {t('valheim.console.recentlyObserved')}: {valheim.observedConnections.map((item) => item.identity).join(', ')}
        </div>
      )}
    </div>
  );
}

export function ConsoleView({ lines, onCommand, onNavigate }) {
  const t = useT();
  const { activeServerId, activeServer, getServerStatus, supports } = useServer();
  const status = activeServerId ? getServerStatus(activeServerId) : null;
  const serverState = status?.status || 'offline';
  const [cmd, setCmd] = useState('');
  const [filter, setFilter] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  useEffect(() => { if (lines.length > 0) setHistoryLoaded(true); }, [lines]);
  useEffect(() => { const t = setTimeout(() => setHistoryLoaded(true), 3000); return () => clearTimeout(t); }, []);
  const [history, setHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(Boolean).slice(-HISTORY_LIMIT) : [];
    } catch {
      return [];
    }
  });
  const [histIdx, setHistIdx] = useState(-1);
  const [showJump, setShowJump] = useState(false);
  const consoleRef = useRef(null);
  const prevLenRef = useRef(0);
  // Whether the user is currently pinned to the bottom. Tracked from real
  // scroll events so the decision to auto-scroll doesn't depend on measuring
  // the viewport *after* new lines have already grown it (the old bug: a batch
  // of lines or one long wrapped line pushed the distance past the threshold,
  // and auto-scroll silently stopped).
  const atBottomRef = useRef(true);

  // Which lines arrived in the most recent batch, by `seq` (see App.jsx). The
  // buffer is capped at 1200, so positions shift under a busy server and only a
  // monotonic id can distinguish a new line from one that merely moved up.
  // Only these announce themselves - replaying the whole scrollback's worth of
  // errors on mount, or on every re-render, would make the emphasis noise.
  const seenSeqRef = useRef(-1);
  const freshFromSeqRef = useRef(Infinity);
  const linesIdentityRef = useRef(null);
  if (linesIdentityRef.current !== lines) {
    linesIdentityRef.current = lines;
    const tailSeq = lines.length ? (lines[lines.length - 1].seq ?? -1) : -1;
    const headSeq = lines.length ? (lines[0].seq ?? -1) : -1;
    // A wholesale buffer replacement - first load, or switching servers - shows
    // up as every line being newer than anything seen so far. That is history
    // being read in, not lines arriving, so nothing reports. (Seqs are global
    // and keep climbing across servers, so comparing the tail is not enough:
    // the *head* is what reveals that nothing from the old buffer survived.)
    if (seenSeqRef.current < 0 || headSeq > seenSeqRef.current) {
      freshFromSeqRef.current = Infinity;
    } else if (tailSeq > seenSeqRef.current) {
      freshFromSeqRef.current = seenSeqRef.current;
    }
    seenSeqRef.current = tailSeq;
  }

  const jumpToLive = useCallback(() => {
    const el = consoleRef.current;
    if (!el) return;
    // A deliberate move across a distance the user chose to create, so it is
    // travelled rather than teleported - it shows them how far back they were.
    // (The live tail itself still hard-jumps; see the autoscroll effect.)
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (smooth && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  const handleScroll = useCallback(() => {
    const el = consoleRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = el.clientHeight > 0 && dist < 120;
    atBottomRef.current = nearBottom;
    setShowJump(!nearBottom);
  }, []);

  // Stick to the live tail as new lines arrive, unless the user scrolled up.
  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const prevLen = prevLenRef.current;
    prevLenRef.current = lines.length;

    // Force-scroll when history loads (initial mount or server switch):
    // lines jumped from 0 → many.
    const historyLoaded = prevLen === 0 && lines.length > 0;
    if (historyLoaded || (autoscroll && atBottomRef.current)) {
      // Deliberately not smooth. A live tail can emit hundreds of lines a
      // second; an eased scroll would be retargeted before it ever landed,
      // never reach the bottom, and trip the "you have scrolled away" state
      // while the user is sitting still. Terminals snap, and they should.
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setShowJump(false);
    }
  }, [lines, autoscroll]);

  // Re-enabling autoscroll snaps back to the bottom immediately.
  useEffect(() => {
    if (!autoscroll) return;
    const el = consoleRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, [autoscroll]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = cmd.trim();
    if (!trimmed) return;
    onCommand(trimmed);
    setHistory(prev => {
      if (prev[prev.length - 1] === trimmed) return prev;
      const next = [...prev.filter(item => item !== trimmed), trimmed].slice(-HISTORY_LIMIT);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
    setHistIdx(-1);
    setCmd('');
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (!history.length) return;
    e.preventDefault();
    if (e.key === 'ArrowUp') {
      const idx = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(idx);
      setCmd(history[idx] || '');
    } else {
      if (histIdx === -1) return;
      if (histIdx < history.length - 1) {
        const idx = histIdx + 1;
        setHistIdx(idx);
        setCmd(history[idx] || '');
      } else {
        setHistIdx(-1);
        setCmd('');
      }
    }
  };

  const normalizedFilter = filter.trim().toLowerCase();
  const displayLines = lines
    .slice(-MAX_LINES)
    .filter(line => !normalizedFilter || String(line.text || '').toLowerCase().includes(normalizedFilter));

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-wrap">
        <CardTitle className="shrink-0">{t('console.title')}</CardTitle>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="relative min-w-[180px] max-w-[260px] flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder={t('console.filterPlaceholder')}
              className="h-7 rounded-full bg-secondary/40 pl-8 pr-8 text-xs"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                aria-label={t('console.clearFilter')}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="autoscroll" checked={autoscroll} onCheckedChange={setAutoscroll} />
            <Label htmlFor="autoscroll" className="normal-case text-xs tracking-normal font-normal text-muted-foreground cursor-pointer">
              {t('console.autoscroll')}
            </Label>
          </div>
        </div>
      </CardHeader>

      <TerrariaStatus status={status} onNavigate={onNavigate} worldsReachable={supports('worlds')} />
      <ValheimStatus status={status} />

      <div ref={consoleRef} onScroll={handleScroll} className="console-area relative">
        {displayLines.length === 0 && normalizedFilter ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
            {t('console.filterEmpty')}
          </div>
        ) : displayLines.length === 0 && historyLoaded ? (
          // Nothing to show yet: say why, and when it is because the server
          // is stopped, offer the Start that makes output appear.
          <div data-console-empty className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground/80">
            {serverState === 'offline' ? (
              <>
                <p>{t('console.emptyOffline')}</p>
                <StartServerButton />
              </>
            ) : (
              <p>{t('console.emptyWaiting')}</p>
            )}
          </div>
        ) : displayLines.map((line, i) => {
          const level = line.level || detectLevel(line.text) || '';
          // Only a just-arrived problem announces itself. Everything else -
          // including the info lines that make up most of a busy stream -
          // simply appears, already readable. Keying by `seq` means an existing
          // row keeps its DOM node as the window slides, so only genuinely new
          // lines mount and the animation fires exactly once.
          const seq = line.seq;
          const reports = seq !== undefined
            && seq > freshFromSeqRef.current
            && (level === 'error' || level === 'warn');
          return (
            <div
              key={seq ?? `i${i}`}
              className={cn(
                'grid grid-cols-[6px_80px_1fr] gap-x-5 items-start',
                reports && 'console-line--report',
                reports && level === 'error' && 'console-line--error-report',
              )}
            >
              <span className={cn('console-line__bar h-full w-[3px] self-stretch rounded-full mt-1.5', LEVEL_BAR[level] || 'bg-transparent')} />
              <span className="text-muted-foreground/40 tabular-nums select-none text-[13px]">{fmtTs(line.ts || Date.now())}</span>
              <span className={cn('whitespace-pre-wrap break-words', `l-${level || 'plain'}`)}>{stripMcTs(line.text)}</span>
            </div>
          );
        })}
        {showJump && (
          <button
            type="button"
            onClick={jumpToLive}
            className="console-jump absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
            title={t('console.jumpToLive')}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {status?.valheim?.commandInput === false || status?.commandInput === false ? (
        <div className="border-t border-border bg-console px-4 py-2 text-xs text-muted-foreground">
          {t(status?.valheim?.commandInput === false ? 'valheim.console.noCommands' : 'console.noCommandsRest')}
        </div>
      ) : <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border px-4 py-2 bg-console">
        <span className="font-mono text-status-online shrink-0">&gt;</span>
        <Input
          type="text"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t(COMMAND_PLACEHOLDERS[activeServer?.type] || 'console.commandPlaceholder')}
          autoComplete="off"
          className="flex-1 font-mono border-0 bg-transparent focus-visible:ring-0 h-7"
        />
        <Button type="submit" variant="default" size="xs">
          <Send className="h-3 w-3" />
          {t('console.send')}
        </Button>
      </form>}
    </Card>
  );
}
