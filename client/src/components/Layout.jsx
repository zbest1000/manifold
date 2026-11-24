import { useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Share2, Radio, Cpu, Radar, Settings as SettingsIcon, Activity, Factory, Boxes, Waypoints, Network, Workflow, Tags as TagsIcon, LineChart, Lock, Gauge, HardDrive, PanelLeftClose, PanelLeftOpen, Menu, X } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { StatusDot, Tooltip, IconButton, Modal } from './ui';
import ErrorLog from './ErrorLog';

// The nav outgrew a flat list — group by the job the user is doing:
// OBSERVE the estate, BUILD on the stream, CONNECT sources, run the SYSTEM.
const NAV_GROUPS = [
  {
    label: null, // top-level, no caption
    items: [{ to: '/', label: 'Overview', icon: Activity, end: true }]
  },
  {
    label: 'Observe',
    items: [
      { to: '/topics', label: 'Topics', icon: Share2 },
      { to: '/uns', label: 'UNS', icon: Network },
      { to: '/flows', label: 'Flows', icon: Waypoints },
      { to: '/trends', label: 'Trends', icon: LineChart }
    ]
  },
  {
    label: 'Build',
    items: [
      { to: '/pipelines', label: 'Pipelines', icon: Workflow },
      { to: '/tags', label: 'Tags', icon: TagsIcon }
    ]
  },
  {
    label: 'Connect',
    items: [
      { to: '/brokers', label: 'MQTT Brokers', icon: Radio },
      { to: '/devices', label: 'Devices', icon: HardDrive },
      { to: '/opcua', label: 'OPC UA', icon: Cpu },
      { to: '/cesmii', label: 'CESMII SMIP', icon: Factory },
      { to: '/i3x', label: 'i3X', icon: Boxes },
      { to: '/discovery', label: 'Discovery', icon: Radar }
    ]
  },
  {
    label: 'System',
    items: [
      { to: '/system', label: 'Health', icon: Gauge },
      { to: '/settings', label: 'Settings', icon: SettingsIcon }
    ]
  }
];

const DESKTOP_QUERY = '(min-width: 768px)'; // Tailwind `md`

/** Subscribe to a CSS media query (used to switch between sidebar and drawer). */
function useMediaQuery(query) {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => true
  );
}

function Brand({ compact }) {
  return (
    <div className={clsx('flex shrink-0 items-center', compact ? 'justify-center px-2' : 'gap-2.5 px-4')}>
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent-400 to-accent-600 shadow-lg shadow-accent-500/30">
        <Share2 size={18} className="text-white" aria-hidden="true" />
      </div>
      {!compact && (
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">Manifold</p>
          <p className="mono truncate text-2xs text-subtle">UNS · MQTT · OPC UA</p>
        </div>
      )}
    </div>
  );
}

/**
 * The navigation column. Rendered twice: as the persistent desktop sidebar
 * (can collapse to icons) and inside the mobile drawer (always expanded).
 */
function SidebarBody({ collapsed, onNavigate, drawer = false, onCloseDrawer }) {
  const connected = useStore((s) => s.connected);
  const brokers = useStore((s) => s.brokers);
  const opcua = useStore((s) => s.opcua);
  const viewerReadOnly = useStore((s) => s.authRole === 'viewer');
  const toggleNav = useStore((s) => s.toggleNav);

  return (
    <>
      <div className="flex h-16 shrink-0 items-center">
        <Brand compact={collapsed} />
        {drawer && (
          <button
            type="button"
            onClick={onCloseDrawer}
            aria-label="Close navigation menu"
            className="mr-3 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-white/5 hover:text-slate-200"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {viewerReadOnly &&
        (collapsed ? (
          <Tooltip label="Read-only session — changes are rejected" side="right" className="mx-auto mb-1">
            <span className="grid h-8 w-8 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300" role="img" aria-label="Read-only session">
              <Lock size={14} />
            </span>
          </Tooltip>
        ) : (
          <div className="mx-3 mb-1 flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-300">
            <Lock size={12} aria-hidden="true" /> Read-only session
          </div>
        ))}

      <nav aria-label="Primary" className={clsx('flex-1 space-y-4 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label || gi} role="group" aria-label={group.label || undefined}>
            {group.label &&
              (collapsed ? (
                gi > 0 && <div className="mx-auto mb-2 h-px w-6 bg-white/10" aria-hidden="true" />
              ) : (
                <p className="label-xs px-3 pb-1.5 !text-subtle" aria-hidden="true">
                  {group.label}
                </p>
              ))}
            <div className="space-y-1">
              {group.items.map((item) => (
                <Tooltip key={item.to} label={collapsed ? item.label : ''} side="right" block>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    aria-label={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center rounded-xl text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
                        collapsed ? 'h-11 w-full justify-center' : 'gap-3 px-3 py-2.5 md:py-2',
                        isActive ? 'bg-accent-500/15 text-accent-300 ring-1 ring-inset ring-accent-500/25' : 'text-muted hover:bg-white/5 hover:text-slate-200'
                      )
                    }
                  >
                    <item.icon size={18} className="shrink-0" aria-hidden="true" />
                    {!collapsed && item.label}
                  </NavLink>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer: live status, logs, collapse toggle */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2 border-t border-white/5 py-3">
          <Tooltip label={connected ? 'Live — socket connected' : 'Offline — reconnecting'} side="right">
            <span className="grid h-8 w-8 place-items-center" role="img" aria-label={connected ? 'Live: socket connected' : 'Offline: reconnecting'}>
              <StatusDot status={connected ? 'connected' : 'disconnected'} />
            </span>
          </Tooltip>
          <ErrorLog collapsed />
          <IconButton icon={PanelLeftOpen} label="Expand sidebar  [" side="right" onClick={toggleNav} aria-expanded="false" aria-controls="app-sidebar" />
        </div>
      ) : (
        <div className="space-y-2 border-t border-white/5 px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-muted">
              <StatusDot status={connected ? 'connected' : 'disconnected'} />
              {connected ? 'Live' : 'Offline'}
            </span>
            <span className="mono text-xs text-subtle">
              {brokers.length} brokers · {opcua.length} OPC UA
            </span>
          </div>
          <ErrorLog />
          {!drawer && (
            <button
              type="button"
              onClick={toggleNav}
              aria-expanded="true"
              aria-controls="app-sidebar"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-subtle transition hover:bg-white/5 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
            >
              <PanelLeftClose size={14} aria-hidden="true" /> Collapse sidebar
              <kbd className="mono ml-auto rounded border border-white/10 px-1 text-2xs text-subtle">[</kbd>
            </button>
          )}
        </div>
      )}
    </>
  );
}

export default function Layout() {
  const connected = useStore((s) => s.connected);
  const collapsed = useStore((s) => s.navCollapsed);
  const toggleNav = useStore((s) => s.toggleNav);
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  // The drawer remembers which route it was opened on, so it is closed
  // automatically after navigating and when the viewport grows to desktop,
  // without effects that set state.
  const location = useLocation();
  const [drawerPath, setDrawerPath] = useState(null);
  const drawerOpen = drawerPath === location.pathname && !isDesktop;
  const setDrawerOpen = (open) => setDrawerPath(open ? location.pathname : null);

  // Keyboard shortcut: `[` toggles the sidebar (ignored while typing).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (window.matchMedia(DESKTOP_QUERY).matches) toggleNav();
      else setDrawerPath((p) => (p === location.pathname ? null : location.pathname));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleNav, location.pathname]);

  const focusMain = (e) => {
    e.preventDefault();
    const main = document.getElementById('main-content');
    main?.focus();
    main?.scrollIntoView?.();
  };

  return (
    <div className="flex h-dvh flex-col bg-surface-950 text-slate-100 md:flex-row">
      <a href="#main-content" onClick={focusMain} className="skip-link">
        Skip to content
      </a>

      {/* Compact top bar (below md): hamburger opens the off-canvas drawer. */}
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-white/5 bg-surface-900/60 px-3 md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={drawerOpen}
          aria-controls="mobile-nav"
          className="grid h-10 w-10 place-items-center rounded-xl text-slate-200 transition hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <Brand />
        <span className="ml-auto flex items-center gap-2 pr-1 text-xs text-muted">
          <StatusDot status={connected ? 'connected' : 'disconnected'} />
          {connected ? 'Live' : 'Offline'}
        </span>
      </header>

      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        className={clsx('hidden shrink-0 flex-col border-r border-white/5 bg-surface-900/50 transition-[width] duration-200 md:flex', collapsed ? 'w-16' : 'w-60')}
      >
        <SidebarBody collapsed={collapsed} />
      </aside>

      {drawerOpen && (
        <Modal id="mobile-nav" title="Navigation menu" placement="left" onClose={() => setDrawerOpen(false)} className="flex w-72 max-w-[85vw] flex-col">
          <SidebarBody collapsed={false} drawer onNavigate={() => setDrawerOpen(false)} onCloseDrawer={() => setDrawerOpen(false)} />
        </Modal>
      )}

      <main id="main-content" tabIndex={-1} aria-label="Page content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none">
        {!connected && (
          // In-flow disconnect banner — pushes the page down instead of covering
          // its title bar (the old absolute overlay hid the header + actions).
          <div role="alert" className="flex shrink-0 items-center justify-center gap-2 bg-rose-700 px-4 py-1.5 text-xs font-medium text-white">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden="true" />
            Connection to the Manifold server lost — live data is stale. Reconnecting…
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
