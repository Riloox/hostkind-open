import { useEffect, useState } from 'react';

// Below Tailwind's `md`: a phone, or a very narrow window. The shell swaps the
// fixed sidebar for a drawer there (Sidebar.jsx, Header.jsx).
const QUERY = '(max-width: 767px)';

function matches() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(QUERY).matches;
}

export function useNarrowScreen() {
  const [narrow, setNarrow] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(QUERY);
    const onChange = () => setNarrow(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
