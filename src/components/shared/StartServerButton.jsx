import { useState } from 'react';
import { toast } from 'sonner';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';

/**
 * Start for the open server, for pages whose empty state is "the server is
 * not running": the button that makes the content appear sits next to the
 * sentence saying it is missing. Same request as the header's Start.
 */
export function StartServerButton({ label, size = 'sm' }) {
  const t = useT();
  const api = useApi();
  const [starting, setStarting] = useState(false);

  async function start() {
    setStarting(true);
    try {
      await api('/api/server/start', { method: 'POST' });
      toast(t('firstStart.startingToast'));
    } catch (e) {
      toast.error(e.message);
    } finally {
      setStarting(false);
    }
  }

  return (
    <Button variant="success" size={size} onClick={start} disabled={starting}>
      <Play className="h-3.5 w-3.5 fill-current" /> {label || t('header.start')}
    </Button>
  );
}
