/**
 * Page header that stacks and wraps at narrow widths (the shared PageHeader
 * keeps title and actions on one row, which overflows at 390px). Same look.
 */
export default function ResponsiveHeader({ title, subtitle, actions }) {
  return (
    <div className="flex flex-col gap-3 border-b border-white/5 px-4 py-4 sm:px-6 md:flex-row md:items-start md:justify-between md:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
