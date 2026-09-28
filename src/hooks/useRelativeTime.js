import { useMemo } from 'react';
import { useI18n } from '@/context/I18nContext';

/**
 * "3 minutes ago", "yesterday" (`ago`) and "today 04:00", "tomorrow 04:00",
 * "Tue 04:00" (`when`), in the user's language.
 */
export function useRelativeTime() {
  const { lang, t } = useI18n();
  return useMemo(() => {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    const ago = (at) => {
      const sec = Math.round((Date.now() - at) / 1000);
      if (sec < 60) return t('notifications.justNow');
      if (sec < 3600) return rtf.format(-Math.round(sec / 60), 'minute');
      if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
      return rtf.format(-Math.round(sec / 86400), 'day');
    };
    const when = (at) => {
      const date = new Date(at);
      const time = date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
      const dayDiff = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
      if (dayDiff === 0) return t('overview.today', { time });
      if (dayDiff === 1) return t('overview.tomorrow', { time });
      return date.toLocaleString(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    };
    return { ago, when };
  }, [lang, t]);
}
