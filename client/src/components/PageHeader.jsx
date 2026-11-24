/** Page title bar. Subtitle and actions wrap on narrow screens instead of squeezing the content. */
export default function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-white/5 px-4 py-4 sm:px-6">
      <div className="min-w-0 flex-1 basis-56">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
