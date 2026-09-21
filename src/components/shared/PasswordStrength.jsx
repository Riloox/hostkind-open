import { useT } from '@/context/I18nContext';
import { cn } from '@/lib/utils';

// Cheap, dependency-free strength estimate that mirrors the server's policy
// (length + character-class variety). Returns 0..4.
export function scorePassword(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  let classes = 0;
  if (/[a-z]/.test(pw)) classes++;
  if (/[A-Z]/.test(pw)) classes++;
  if (/[0-9]/.test(pw)) classes++;
  if (/[^A-Za-z0-9]/.test(pw)) classes++;
  if (classes >= 2) score++;
  if (classes >= 3) score++;
  return Math.min(4, score);
}

// Verdict comes from the signal colours, granularity from the number of filled
// bars - which is why "good" and "strong" share a hue. Inventing a fourth
// colour to sit between yellow and green would put a swatch on screen that
// means nothing anywhere else in the app.
const TIERS = [
  { labelKey: 'password.weak', color: 'bg-status-error', text: 'text-status-error' },
  { labelKey: 'password.weak', color: 'bg-status-error', text: 'text-status-error' },
  { labelKey: 'password.fair', color: 'bg-status-warn', text: 'text-status-warn' },
  { labelKey: 'password.good', color: 'bg-status-online', text: 'text-status-online' },
  { labelKey: 'password.strong', color: 'bg-status-online', text: 'text-status-online' },
];

export function PasswordStrength({ password }) {
  const t = useT();
  if (!password) return null;
  const score = scorePassword(password);
  const tier = TIERS[score];
  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((level) => (
          <div
            key={`strength-${level}`}
            className={cn('h-1 flex-1 rounded-full transition-colors', level <= score ? tier.color : 'bg-border')}
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-label">
        <span className="text-muted-foreground">{t('password.strength')}</span>
        <span className={cn('font-medium', tier.text)}>{t(tier.labelKey)}</span>
      </div>
    </div>
  );
}
