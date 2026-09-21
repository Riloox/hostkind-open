import { useEffect, useRef } from 'react';

/**
 * Visibility-aware polling: ticks at `activeInterval` while the tab is
 * visible and backs off to `hiddenInterval` while hidden, re-arming on
 * visibility changes. The callback rides in a ref so re-renders never
 * re-subscribe the timer. The caller is responsible for the initial load;
 * this hook only owns the interval.
 *
 * @param {() => void} callback polled function
 * @param {object|number} [options] `{ activeInterval, hiddenInterval, enabled }`
 *   or a bare active interval in ms (hidden defaults to 3x).
 */
export function usePolling(callback, options = {}) {
  const opts = typeof options === 'number' ? { activeInterval: options } : (options ?? {});
  const {
    activeInterval = 10000,
    hiddenInterval = activeInterval * 3,
    enabled = true,
  } = opts;

  const callbackRef = useRef(callback);
  useEffect(() => { callbackRef.current = callback; });

  useEffect(() => {
    if (!enabled) return undefined;
    let timer;
    const schedule = () => {
      clearInterval(timer);
      timer = setInterval(() => { callbackRef.current?.(); }, document.hidden ? hiddenInterval : activeInterval);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [activeInterval, hiddenInterval, enabled]);
}
