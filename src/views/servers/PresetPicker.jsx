import { Label } from '@/components/ui/label';
import { useT } from '@/context/I18nContext';
import { matchingPreset, presetsFor } from '@/lib/serverPresets';
import { cn } from '@/lib/utils';

/**
 * The game's presets, as the first thing in its install wizard. Choosing one
 * fills the form; the highlighted one is whichever the form still matches, so
 * editing a field it set simply clears the highlight.
 */
export function PresetPicker({ game, form, onChoose, disabled }) {
  const t = useT();
  const presets = presetsFor(game);
  if (!presets.length) return null;
  const current = matchingPreset(game, form);
  return (
    <div className="space-y-1.5">
      <Label>{t('serverPresets.label')}</Label>
      <div className="grid gap-2 sm:grid-cols-2">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-server-preset={preset.id}
            disabled={disabled}
            aria-pressed={current?.id === preset.id}
            onClick={() => onChoose(preset)}
            className={cn(
              'rounded-md border border-input bg-background/60 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              current?.id === preset.id && 'border-primary ring-1 ring-primary',
            )}
          >
            <span className="block text-sm font-medium">{t(`serverPresets.${game}.${preset.id}.title`)}</span>
            <span className="block text-label leading-tight text-muted-foreground">{t(`serverPresets.${game}.${preset.id}.hint`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The settings most servers never change, folded away under the ones people
 * pick. Folded, the wizard still installs with every default filled in.
 */
export function MoreOptions({ children }) {
  const t = useT();
  return (
    <details className="group rounded-md border border-border/60 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm text-muted-foreground group-open:mb-3">{t('serverRules.moreOptions')}</summary>
      <div className="space-y-4">{children}</div>
    </details>
  );
}

/**
 * The name a preset suggests, e.g. "Terraria Expert". It only replaces a name
 * that is empty or was itself suggested, never one the user typed.
 */
export function presetName(t, game, preset) {
  return t('serverPresets.name', { game: t(`games.${game}`), preset: t(`serverPresets.${game}.${preset.id}.title`) });
}
