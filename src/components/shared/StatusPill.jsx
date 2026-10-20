import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useT } from '@/context/I18nContext';

const STATUS_VARIANTS = {
  online:   'bg-status-online/15 text-status-online border border-status-online/20',
  offline:  'bg-muted/50 text-muted-foreground border border-border',
  starting: 'bg-status-warn/15 text-status-warn border border-status-warn/20',
  stopping: 'bg-status-warn/15 text-status-warn border border-status-warn/20',
};

export function StatusPill({ status = 'offline', className }) {
  const t = useT();

  // No server selected is not the same as a server that is offline: there is
  // nothing to have a status, so the pill says as much instead of defaulting
  // to a status dot and an "OFFLINE" label that reads as a real server down.
  if (status === null) {
    return (
      <span className={cn(
        'status-pill inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-label font-semibold uppercase tracking-wide',
        'text-muted-foreground',
        className
      )}>
        {t('header.noServer')}
      </span>
    );
  }

  return (
    <span className={cn(
      'status-pill inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-label font-semibold uppercase tracking-wide',
      STATUS_VARIANTS[status] || STATUS_VARIANTS.offline,
      className
    )}>
      {/* The pill states the status in words, so the dot beside it is
          decorative - labelling it too would announce the status twice. */}
      <StatusDot status={status} decorative />
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  );
}

// Ignition is an event, not a state: it has to fire on the *edge* into online
// and never again. Mounting already-online (switching servers, reloading the
// page, or any parent re-render) must stay quiet, otherwise the moment stops
// meaning "this just came up" and becomes noise.
const IGNITE_MS = 520;

// Used bare (the server selector) the dot is the *only* thing reporting state,
// so it has to carry a name - otherwise the status is conveyed by colour alone,
// which this system does not allow and which a screen reader cannot see at all.
export function StatusDot({ status = 'offline', className, decorative = false }) {
  const t = useT();
  const prevStatus = useRef(status);
  const [igniting, setIgniting] = useState(false);

  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    // Leaving online always clears the flag. Without this, a server that drops
    // again inside the ignition window would have its timer cancelled by this
    // effect's own cleanup and stay stuck mid-ignition - and because the flag
    // never returned to false, it would never ignite on any later start.
    if (status !== 'online') {
      setIgniting(false);
      return;
    }
    if (was === 'online') return;
    setIgniting(true);
    const timer = setTimeout(() => setIgniting(false), IGNITE_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const isOnline = status === 'online';
  const isWorking = status === 'starting' || status === 'stopping';

  // `currentColor` drives the core, the halo and the ignition ring together, so
  // the whole dot crossfades as one object when the state changes.
  const tone =
    isOnline ? 'text-status-online' :
    isWorking ? 'text-status-warn' :
    'text-status-offline';

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? 'true' : undefined}
      aria-label={decorative ? undefined : t(`status.${status}`, { defaultValue: status })}
      className={cn(
        'status-dot',
        tone,
        isOnline && 'status-dot--online',
        isWorking && 'status-dot--working',
        igniting && 'status-dot--ignite',
        className,
      )}
    >
      <span className="status-dot__halo" aria-hidden="true" />
      {igniting && <span className="status-dot__ignition" aria-hidden="true" />}
      <span className="status-dot__core" />
    </span>
  );
}
