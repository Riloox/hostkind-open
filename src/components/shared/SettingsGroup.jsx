// One settings group: what it is on the left, its fields on the right. Plain
// sections rather than cards - a settings page is a form, not a dashboard.
export function SettingsGroup({ title, hint, children, ...props }) {
  return (
    <section {...props} className="grid gap-4 border-b border-border py-6 first:pt-0 last:border-0 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:gap-10">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 max-w-xl space-y-4">{children}</div>
    </section>
  );
}
