/**
 * Page title bar: one row with the title (and an optional one-line description)
 * on the left and the page's actions on the right (primary action last). On
 * narrow screens the actions wrap under the title instead of squeezing it.
 */
export default function PageHeader({ title, subtitle, actions, children }) {
  return (
    <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-2.5 sm:px-6">
      <div className="min-w-0 flex-1 basis-56">
        <h1 className="truncate text-lg font-semibold leading-6 text-fg">{title}</h1>
        {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
      {children}
    </header>
  );
}
