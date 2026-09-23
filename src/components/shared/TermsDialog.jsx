import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Scale } from 'lucide-react';
import { useI18n, useT } from '@/context/I18nContext';
import { useAuth } from '@/context/AuthContext';
import { useApi } from '@/hooks/useApi';
import { TERMS_VERSION, termsFor } from '@/lib/terms';

function TermsText() {
  const { lang } = useI18n();
  return (
    <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
      {termsFor(lang).map((section) => (
        <section key={section.heading}>
          <h3 className="mb-1.5 text-sm font-semibold text-foreground">{section.heading}</h3>
          {section.body.map((p, i) => <p key={i} className="mb-2 last:mb-0">{p}</p>)}
        </section>
      ))}
    </div>
  );
}

// mode="accept" blocks the panel until the signed-in user accepts the current
// TERMS_VERSION; it cannot be dismissed, only accepted or signed out of.
// mode="view" is the read-only copy reachable from Settings.
export function TermsDialog({ open, onOpenChange, mode = 'view' }) {
  const t = useT();
  const api = useApi();
  const { user, setUser, logout, authDisabled } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const accepting = mode === 'accept';

  async function accept() {
    setSaving(true);
    try {
      const { user: updated } = await api('/api/me/terms', { method: 'PUT', serverScoped: false, body: { version: TERMS_VERSION } });
      setUser({ ...user, ...updated });
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  const block = accepting ? (e) => e.preventDefault() : undefined;

  return (
    <Dialog open={open} onOpenChange={accepting ? undefined : onOpenChange}>
      <DialogContent
        className="max-w-2xl p-0"
        hideClose={accepting}
        onEscapeKeyDown={block}
        onPointerDownOutside={block}
        onInteractOutside={block}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Scale className="h-4 w-4" />
            </span>
            {t('terms.title')}
          </DialogTitle>
          <DialogDescription className="text-xs">{t('terms.lastUpdated', { date: TERMS_VERSION })}</DialogDescription>
        </DialogHeader>

        <DialogBody className="max-h-[55vh] space-y-4">
          {accepting && <p className="text-sm text-foreground">{t('terms.intro')}</p>}
          <TermsText />
        </DialogBody>

        <DialogFooter className="flex-wrap justify-between">
          {accepting ? (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
                {t('terms.agree')}
              </label>
              <div className="flex gap-2">
                {!authDisabled && (
                  <Button variant="glass" size="sm" onClick={logout} disabled={saving}>{t('terms.decline')}</Button>
                )}
                <Button size="sm" onClick={accept} disabled={!agreed || saving}>
                  {saving ? t('terms.accepting') : t('terms.accept')}
                </Button>
              </div>
            </>
          ) : (
            <Button size="sm" className="ml-auto" onClick={() => onOpenChange?.(false)}>{t('terms.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
