import { useT } from '@/context/I18nContext';
import { FILE_GROUPS, groupFile } from '@/modules/minecraft/configGroups';
import { cn } from '@/lib/utils';

// Vertical list of config files grouped by FILE_GROUPS. Files not matched
// by any group fall into the 'other' bucket at the bottom. The selected
// file is highlighted; click a row to select it.

export function FileNav({ files = [], selected, onSelect, minecraft = false }) {
  const t = useT();
  if (!files.length) return null;

  const groups = minecraft
    ? FILE_GROUPS
    : [{ id: 'other', labelKey: 'configs.groupOther', files: [] }];
  const buckets = groups.map((g) => ({
    id: g.id,
    label: t(g.labelKey),
    alwaysShow: !!g.alwaysShow,
    items: g.id === 'other' ? [] : files.filter((f) => groupFile(f) === g.id),
  }));
  const matched = new Set();
  for (const b of buckets) for (const f of b.items) matched.add(f);
  buckets[buckets.length - 1].items = files.filter((f) => !matched.has(f));

  return (
    <nav className="space-y-3 text-sm" aria-label={t('sections.game')}>
      {buckets.map((b) => {
        if (b.items.length === 0 && !b.alwaysShow) return null;
        return (
          <div key={b.id}>
            <div className="px-2 mb-1 text-label font-semibold uppercase tracking-wider text-muted-foreground">
              {b.label}
            </div>
            {b.items.length === 0 ? (
              <div className="px-2.5 py-1.5 text-sm text-muted-foreground/70 italic">
                {t('configs.groupAdvancedEmpty')}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {b.items.map((f) => {
                  const isSel = f === selected;
                  return (
                    <li key={f}>
                      <button
                        type="button"
                        onClick={() => onSelect(f)}
                        className={cn(
                          'w-full text-left rounded-md px-2.5 py-1.5 text-sm transition-colors',
                          isSel
                            ? 'bg-primary/15 text-primary font-semibold'
                            : 'hover:bg-secondary/60 text-foreground/90'
                        )}
                      >
                        {f}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
