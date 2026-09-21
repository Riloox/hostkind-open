import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'recovery_required'];

/**
 * Follow a server-side operation by polling until it reaches a terminal
 * state: toast the outcome, clear the banner after `clearDelay`, and call
 * `onDone` (usually the view's reload). Unifies the timeout+tick pattern
 * previously triplicated across WorldsView / TerrariaWorldsView /
 * ValheimWorldsView.
 *
 * @param {Function} api `useApi()` client
 * @param {Function} t translate function
 * @param {Function} onDone called once the operation settles
 * @param {object} [opts] `{ successKey, cancelledKey, failedKey, clearDelay, pollInterval }`
 */
export function useWorldOperation(api, t, onDone, {
  successKey,
  cancelledKey,
  failedKey,
  clearDelay = 3000,
  pollInterval = 1000,
} = {}) {
  const [op, setOp] = useState(null);
  const [events, setEvents] = useState([]);
  const timer = useRef(null);
  const clearTimer = useRef(null);
  const mountedRef = useRef(true);

  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; });

  const stop = useCallback(() => { clearTimeout(timer.current); timer.current = null; }, []);

  const follow = useCallback((operationId) => {
    clearTimeout(timer.current);
    clearTimeout(clearTimer.current);
    const tick = async () => {
      try {
        const r = await api(`/api/operations/${operationId}`);
        if (!mountedRef.current) return;
        setOp(r.operation);
        setEvents(r.events || []);
        if (TERMINAL.includes(r.operation.state)) {
          if (r.operation.state === 'succeeded' && successKey) toast.success(t(successKey));
          else if (r.operation.state === 'cancelled' && cancelledKey) toast.info(t(cancelledKey));
          else if (failedKey) toast.error(r.operation.error?.text || t(failedKey));
          clearTimer.current = setTimeout(() => { if (mountedRef.current) setOp(null); }, clearDelay);
          onDoneRef.current?.();
          return;
        }
        timer.current = setTimeout(tick, pollInterval);
      } catch (e) {
        if (!mountedRef.current) return;
        toast.error(e.message);
        setOp(null);
      }
    };
    tick();
  }, [api, t, successKey, cancelledKey, failedKey, clearDelay, pollInterval]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timer.current);
      clearTimeout(clearTimer.current);
    };
  }, []);

  useEffect(() => stop, [stop]);

  return { op, events, follow };
}
