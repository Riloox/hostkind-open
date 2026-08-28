import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/context/I18nContext';
import { X, ArrowRight, ArrowLeft, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GameLogo } from '@/components/shared/GameArtwork';

// Each game teaches its own useful stations. Targets that need a registered
// server may not exist yet; those steps are skipped dynamically (idea 3).
const GAME_STATIONS = {
  minecraft: { configure: 'nav-configs', content: 'nav-modrinth' },
  terraria: { configure: 'nav-worlds', content: 'nav-addons' },
  valheim: { configure: 'nav-worlds', content: 'nav-updates' },
  palworld: { configure: 'nav-configs', content: 'nav-map' },
  custom: { configure: 'nav-console', content: 'nav-files' },
};

function allStepsFor(gameId) {
  const game = GAME_STATIONS[gameId] ? gameId : 'custom';
  const stations = GAME_STATIONS[game];
  return [
    { target: null, titleKey: 'tour.welcome.title', bodyKey: 'tour.gameWelcome.body' },
    { target: 'sidebar', titleKey: 'tour.sidebar.title', bodyKey: 'tour.sidebar.body' },
    { target: 'nav-servers', titleKey: 'tour.createServer.title', bodyKey: `tour.games.${game}.create` },
    { target: stations.configure, titleKey: 'tour.gameConfigure.title', bodyKey: `tour.games.${game}.configure` },
    { target: stations.content, titleKey: 'tour.gameTools.title', bodyKey: `tour.games.${game}.tools` },
    { target: 'header', titleKey: 'tour.header.title', bodyKey: 'tour.header.body' },
    { target: 'controlbar', titleKey: 'tour.controlbar.title', bodyKey: 'tour.controlbar.body' },
    { target: null, titleKey: 'tour.done.title', bodyKey: `tour.games.${game}.done` },
  ];
}

const CARD_WIDTH = 425;
const VIEWPORT_GUTTER = 12;
const TARGET_PADDING = 8;
const TARGET_GAP = 12;
const FALLBACK_CARD_HEIGHT = 220;
const SIDEBAR_COLLAPSED_THRESHOLD = 80;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// Idea 14: detect a collapsed sidebar — if the element's rendered width is
// below threshold, treat the target as absent so the card falls back to a
// centred layout. No changes to Sidebar.jsx required.
function rectFor(target) {
  if (!target) return null;
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  // Idea 14: collapsed sidebar detection
  if (target === 'sidebar' && el.offsetWidth < SIDEBAR_COLLAPSED_THRESHOLD) return null;
  return el.getBoundingClientRect();
}

// Idea 2: scroll the target element into view before measuring, so off-screen
// targets slide into the spotlight rather than rendering the hole off-viewport.
function scrollIntoViewIfNeeded(target) {
  if (!target) return;
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Idea 15: respects the OS motion preference — disables the spotlight
// transition and the card entrance animation when reduced motion is requested.
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Idea 11: lightweight tour analytics events dispatched to the window so
// App.jsx (or any listener) can record them without coupling the tour to
// the audit system directly. Wrapped in try/catch so a listener error
// never breaks the tour.
function dispatchTourEvent(type, { step, total, game, variant }) {
  try {
    window.dispatchEvent(new CustomEvent('fleetdeck:tour', {
      detail: { type, step, total, game, variant },
    }));
  } catch { /* listener errors must not break the tour */ }
}

export function OnboardingTour({ open, onClose, gameId }) {
  const t = useT();
  const game = GAME_STATIONS[gameId] ? gameId : 'custom';
  const gameName = t(`games.${game}`);
  const variant = 'full';

  // Idea 3: compute effective steps once per open. Skip steps whose
  // data-tour target is absent from the DOM — except the first (welcome)
  // and last (done) which always render as centred cards.
  const allSteps = useMemo(() => allStepsFor(game), [game]);

  const steps = useMemo(() => {
    return allSteps.filter((step, i) => {
      // First and last steps (welcome / done) always stay
      if (i === 0 || i === allSteps.length - 1) return true;
      // Spotlight steps: keep only if the target element exists and is wide enough
      if (!step.target) return false;
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (!el) return false;
      // Idea 14: skip sidebar steps when collapsed
      if (step.target === 'sidebar' && el.offsetWidth < SIDEBAR_COLLAPSED_THRESHOLD) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, allSteps]);

  // Idea 16: on open, restore step from sessionStorage; on Finish, clear it.
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState(null);
  const [cardHeight, setCardHeight] = useState(FALLBACK_CARD_HEIGHT);
  const cardRef = useRef(null);
  const rafRef = useRef(0);

  // Idea 16: sessionStorage key for resume
  const resumeKey = `fleetdeck_tour_step:${gameId || 'default'}`;

  // Idea 1: focus management refs
  const savedFocusRef = useRef(null);

  const total = steps.length;
  // Safety: clamp step if skip-hidden-steps reduced the list since last render
  const clampedStep = Math.min(step, Math.max(total - 1, 0));
  const currentStep = steps[clampedStep];

  // Idea 16: persist step to sessionStorage on every step change
  useEffect(() => {
    if (!open || total === 0) return;
    try { sessionStorage.setItem(resumeKey, String(step)); } catch {}
  }, [step, open, resumeKey, total]);

  // Idea 11: dispatch 'step' event on every step change (including first)
  useEffect(() => {
    if (!open || total === 0) return;
    dispatchTourEvent('step', { step, total, game: gameId, variant });
  }, [step, open, total, gameId, variant]);

  // Idea 2 + 6: scroll into view then measure, re-measure when language changes
  const measure = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      // Idea 2: scroll target into view before measuring
      scrollIntoViewIfNeeded(currentStep?.target);
      // Measure after a frame so scrollIntoView has taken effect
      rafRef.current = requestAnimationFrame(() => {
        setRect(rectFor(currentStep?.target));
      });
    });
  // Idea 6: include `t` so a language change re-measures (different text lengths
  // can shift targets via ResizeObserver, but `measure` itself must know about t)
  }, [currentStep?.target, gameId, t]);

  // Re-measure when the step changes and on viewport changes.
  useEffect(() => {
    if (!open) return;
    measure();
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
      cancelAnimationFrame(rafRef.current);
    };
  }, [open, step, measure]);

  // Idea 16 + 11: on open, restore step from sessionStorage or dispatch 'start'
  useEffect(() => {
    if (!open) return;
    // Dispatch 'start' event
    dispatchTourEvent('start', { step: 0, total, game: gameId, variant });
    // Idea 16: try to restore step from sessionStorage
    let restored = false;
    try {
      const stored = sessionStorage.getItem(resumeKey);
      const idx = parseInt(stored, 10);
      if (!isNaN(idx) && idx > 0 && idx < total) {
        setStep(idx);
        restored = true;
      }
    } catch {}
    if (!restored) setStep(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Idea 1: focus trap — save previously-focused element on open, trap Tab
  useEffect(() => {
    if (!open) return;
    savedFocusRef.current = document.activeElement;
    // Move focus into the card after a frame so it's rendered
    requestAnimationFrame(() => {
      if (cardRef.current) cardRef.current.focus();
    });
    return () => {
      // Idea 1: restore focus on close
      if (savedFocusRef.current && typeof savedFocusRef.current.focus === 'function') {
        savedFocusRef.current.focus();
      }
    };
  }, [open]);

  // Idea 1 (hardening): the card remounts on every step change (key={step}),
  // which drops focus back to <body>. Pull it into the card again so the Tab
  // trap below keeps working after keyboard or mouse navigation.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      if (cardRef.current && !cardRef.current.contains(document.activeElement)) {
        cardRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  useEffect(() => {
    if (!open || !cardRef.current) return;
    const updateCardHeight = () => {
      if (cardRef.current) setCardHeight(cardRef.current.offsetHeight || FALLBACK_CARD_HEIGHT);
    };
    updateCardHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateCardHeight);
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [open, step]);

  // Idea 1: focus trap — intercept Tab/Shift+Tab within the card.
  // ArrowLeft/Right for step navigation are also handled here.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); dispatchTourEvent('dismiss', { step: clampedStep, total, game: gameId, variant }); onClose(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      // Idea 1: Tab / Shift+Tab focus trap
      else if (e.key === 'Tab' && cardRef.current) {
        const focusable = cardRef.current.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        // If focus has drifted outside the card (e.g. a remount), pull it
        // back instead of letting Tab wander into the app underneath.
        if (!cardRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, total]);

  if (!open || total === 0) return null;

  const isFirst = clampedStep === 0;
  const isLast = clampedStep === total - 1;

  function next() {
    if (clampedStep < total - 1) setStep((s) => s + 1);
  }
  function prev() { setStep((s) => Math.max(s - 1, 0)); }

  // Spotlight dimming: a full-screen dark layer with a transparent hole
  // punched around the target's bounding box (drawn with a big box-shadow
  // so it scales with any rect without recomposing four panels).
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const top = rect ? clamp(rect.top - TARGET_PADDING, 0, viewportHeight) : 0;
  const left = rect ? clamp(rect.left - TARGET_PADDING, 0, viewportWidth) : 0;
  const right = rect ? clamp(rect.right + TARGET_PADDING, 0, viewportWidth) : 0;
  const bottom = rect ? clamp(rect.bottom + TARGET_PADDING, 0, viewportHeight) : 0;
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const hasTarget = !!rect;

  // Position the tooltip card near the spotlight. Default to placing it
  // below the hole; flip above if there isn't room, then clamp it inside
  // the viewport so small screens and edge targets remain usable.
  // Idea 5: use the card's rendered width instead of fixed CARD_WIDTH.
  const renderedCardWidth = cardRef.current?.offsetWidth || CARD_WIDTH;
  const maxCardLeft = Math.max(VIEWPORT_GUTTER, viewportWidth - renderedCardWidth - VIEWPORT_GUTTER);
  const maxCardTop = Math.max(VIEWPORT_GUTTER, viewportHeight - cardHeight - VIEWPORT_GUTTER);
  const cardLeft = clamp(left, VIEWPORT_GUTTER, maxCardLeft);

  // Idea 18: when neither side fits cleanly, a naive clamp parks the card on
  // top of its own target — the bottom dock (server controls) ended up fully
  // hidden behind the card on short viewports. Instead, evaluate BOTH sides
  // clamped on-screen and pick the one that overlaps the spotlight least.
  const belowTop = bottom + TARGET_GAP;
  const aboveTop = top - cardHeight - TARGET_GAP;
  const overlapWithSpotlight = (cardTop) => {
    const cardBottom = cardTop + cardHeight;
    return Math.max(0, Math.min(cardBottom, bottom) - Math.max(cardTop, top));
  };
  const candidates = [
    { side: 'below', top: clamp(belowTop, 0, maxCardTop) },
    { side: 'above', top: clamp(aboveTop, 0, maxCardTop) },
  ];
  candidates.forEach((candidate) => { candidate.overlap = overlapWithSpotlight(candidate.top); });
  // Least overlap wins; a tie keeps the default below placement.
  candidates.sort((a, b) => a.overlap - b.overlap || (a.side === 'below' ? -1 : 1));
  const preferredTop = candidates[0].top;

  const cardStyle = hasTarget
    ? { top: preferredTop, left: cardLeft }
    : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };

  // Idea 15: reduced motion — override spotlight transition
  const spotlightTransition = prefersReducedMotion ? 'none' : 'all 220ms ease';
  // Idea 15: reduced motion — drop card animation classes
  const cardAnimationClasses = prefersReducedMotion
    ? ''
    : 'animate-in fade-in slide-in-from-bottom-2 duration-200';

  // Idea 7: backdrop click advances one step when the current step is a
  // spotlight step (it targets an element). Gate on the step definition, not
  // the measured rect: the rect is set on a double-rAF after a step change,
  // so gating on it would swallow clicks in that window. NEVER closes.
  const handleBackdropClick = () => {
    if (currentStep?.target) next();
  };

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={t('tour.welcome.title')}>
      {/* Dim overlay with a punched hole when there is a target. */}
      {hasTarget ? (
        <div
          className="absolute pointer-events-auto"
          style={{
            top, left, width, height,
            borderRadius: 12,
            boxShadow: '0 0 0 9999px oklch(var(--coal-1) / 0.78)',
            border: '1px solid oklch(var(--ember-6) / 0.28)',
            transition: spotlightTransition,
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[oklch(var(--coal-1)/0.78)]" />
      )}

      {/* Idea 7: Click-catcher — advances one step on spotlight steps,
          swallows clicks on centred-card steps. Does NOT dismiss the tour. */}
      <div
        className="absolute inset-0 cursor-default"
        onClick={handleBackdropClick}
        aria-hidden="true"
      />

      {/* Idea 8: key={step} re-triggers the entrance animation per step.
          Idea 15: animation classes are dropped when reduced motion is active. */}
      <div
        key={step}
        ref={cardRef}
        tabIndex={-1}
        className={cn(
          'absolute z-10 max-h-[calc(100vh-24px)] w-[425px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-2xl outline-none',
          cardAnimationClasses,
        )}
        style={cardStyle}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {/* Idea 17: game icon accent in the card header */}
            {gameId && (
              <GameLogo
                gameId={gameId}
                className="h-4 w-auto max-w-5 shrink-0"
                fallbackClassName="text-muted-foreground"
              />
            )}
            <span className="text-sm font-semibold uppercase tracking-widest text-primary">
              {t('tour.badge', { n: clampedStep + 1, total })}
            </span>
          </div>
          <button
            type="button"
            onClick={() => { dispatchTourEvent('dismiss', { step: clampedStep, total, game: gameId, variant }); onClose(); }}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <h2 className="text-xl font-semibold text-foreground">{t(currentStep.titleKey, { game: gameName })}</h2>
        <p className="mt-2 text-title leading-relaxed text-muted-foreground">
          {t(currentStep.bodyKey, { game: gameName })}
        </p>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          {/* Idea 4: clickable progress dots — buttons that jump to any step <= current */}
          <div className="flex shrink-0 gap-2" role="tablist" aria-label={t('tour.badge', { n: clampedStep + 1, total })}>
            {steps.map((_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === clampedStep}
                aria-label={t('tour.badge', { n: i + 1, total })}
                disabled={i > clampedStep}
                onClick={() => { if (i <= clampedStep) setStep(i); }}
                className={cn(
                  'rounded-full transition-[background-color] disabled:cursor-default',
                  i === clampedStep ? 'h-2 w-6 bg-primary' : i < clampedStep ? 'h-2 w-2 bg-primary/60' : 'h-2 w-2 bg-border',
                )}
              />
            ))}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
            {!isFirst && (
              <Button variant="ghost" size="sm" className="h-10 min-w-0 px-3 text-title" onClick={prev}>
                <ArrowLeft className="h-4 w-4" /> {t('common.back')}
              </Button>
            )}
            {isLast ? (
              <Button size="sm" className="h-10 min-w-0 px-3 text-title" onClick={() => {
                // Idea 16: clear sessionStorage on Finish so next open starts fresh
                try { sessionStorage.removeItem(resumeKey); } catch {}
                dispatchTourEvent('complete', { step: clampedStep, total, game: gameId, variant });
                onClose();
              }}>
                <Check className="h-4 w-4" /> {t('tour.finish')}
              </Button>
            ) : (
              <Button size="sm" className="h-10 min-w-0 px-3 text-title" onClick={next}>
                {t('tour.next')} <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
