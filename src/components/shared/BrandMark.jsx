import { cn } from '@/lib/utils';
import { useT } from '@/context/I18nContext';
import { useBranding } from '@/context/AuthContext';

/**
 * The panel's brand mark: an abstract stacked-deck glyph paired with the
 * wordmark. Used in the sidebar header (also doubles as a "back to all games"
 * shortcut).
 *
 * Both halves are overridable from config.json so a hosting provider can ship
 * the panel under their own name without editing a translation file. The
 * built-in Hostkind mark is what renders when they have not.
 *
 * @param {boolean}  collapsed  When true, only the icon is rendered.
 * @param {function} onClick    Optional click handler (e.g. go to all games).
 */
export function BrandMark({ collapsed = false, onClick, className }) {
  const t = useT();
  const branding = useBranding();
  // Falls back while the bootstrap call is still in flight, so the mark never
  // renders blank for a frame.
  const name = branding.name || t('brand.name');

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex w-full items-center rounded-sm border border-transparent select-none transition-colors duration-75',
        onClick && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        collapsed ? 'justify-center px-0 py-1' : 'gap-2.5 px-2 py-1.5',
        className,
      )}
      aria-label={t('brand.goToGames', { name })}
      title={name}
      tabIndex={onClick ? 0 : -1}
    >
      <BrandIcon logoUrl={branding.logoUrl} />
      {!collapsed && (
        <span className="brand-wordmark">{name}</span>
      )}
    </button>
  );
}

/**
 * The glyph on its own. A configured logo becomes an <img> rather than a CSS
 * background so it can keep its aspect ratio - a provider's mark is rarely the
 * square the built-in glyph is.
 */
export function BrandIcon({ logoUrl, className }) {
  if (!logoUrl) return <span className={cn('brand-icon', className)} aria-hidden="true" />;
  return <img src={logoUrl} alt="" className={cn('brand-icon brand-icon--custom', className)} aria-hidden="true" />;
}
