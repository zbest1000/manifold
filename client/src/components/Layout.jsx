import { useEffect, useState, useSyncExternalStore } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Share2,
  Radio,
  Cpu,
  Radar,
  Settings as SettingsIcon,
  LayoutDashboard,
  Factory,
  Boxes,
  Waypoints,
  Network,
  Workflow,
  Tags as TagsIcon,
  LineChart,
  Lock,
  Gauge,
  HardDrive,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
  Monitor,
  Sun,
  Moon
} from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '@/store/store';
import { useTheme } from '@/lib/theme';
import { StatusDot, Tooltip, IconButton, Modal, Kbd } from './ui';
import ErrorLog from './ErrorLog';

// Grouped by the job the user is doing: OBSERVE the estate, BUILD on the
// stream, CONNECT sources, run the SYSTEM.
const NAV_GROUPS = [
  {
    label: null, // top-level, no caption
    items: [{ to: '/', label: 'Overview', icon: LayoutDashboard, end: true }]
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

/** The Manifold mark: three lines converging into one (many sources, one namespace). */
function Mark({ className }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className={clsx('shrink-0', className)}>
      <rect x="0.5" y="0.5" width="19" height="19" rx="4.5" className="fill-fg" />
      <path d="M5 5.5h3.2L12 10M5 10h7M5 14.5h3.2L12 10M12 10h3" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="stroke-app" />
    </svg>
  );
}

function Brand({ compact }) {
  return (
    <div className={clsx('flex min-w-0 items-center', compact ? 'justify-center' : 'gap-2 px-1')}>
      <Mark />
      {!compact && <span className="truncate text-sm font-semibold tracking-tight text-fg">Manifold</span>}
    </div>
  );
}

const THEME_OPTIONS = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon }
];

/** System / light / dark switch. Compact = one button that cycles. */
function ThemeSwitch({ compact }) {
  const [{ preference }, setPreference] = useTheme();
  if (compact) {
    const i = THEME_OPTIONS.findIndex((o) => o.value === preference);
    const cur = THEME_OPTIONS[i] || THEME_OPTIONS[0];
    const next = THEME_OPTIONS[(i + 1) % THEME_OPTIONS.length];
    return <IconButton icon={cur.icon} label={`${cur.label} (switch to ${next.label.toLowerCase()})`} side="right" onClick={() => setPreference(next.value)} />;
  }
  return (
    <div role="group" aria-label="Colour theme" className="inline-flex rounded-md border border-line p-0.5">
      {THEME_OPTIONS.map((o, i) => {
        const on = preference === o.value;
        return (
          // The first button sits at the window edge: its tip goes right so it stays on screen.
          <Tooltip key={o.value} label={o.label} side={i === 0 ? 'right' : 'top'}>
            <button
              type="button"
              aria-pressed={on}
              aria-label={o.label}
              onClick={() => setPreference(o.value)}
              className={clsx('grid h-6 w-7 place-items-center rounded-[4px] transition-colors', on ? 'bg-raised text-fg' : 'text-subtle hover:text-fg')}
            >
              <o.icon size={13} aria-hidden="true" />
            </button>
          </Tooltip>
        );
      })}
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
  const brokersUp = brokers.filter((b) => b.status === 'connected').length;

  return (
    <>
      <div className={clsx('flex h-12 shrink-0 items-center', collapsed ? 'justify-center' : 'justify-between pl-4 pr-2')}>
        <Brand compact={collapsed} />
        {drawer && (
          <button
            type="button"
            onClick={onCloseDrawer}
            aria-label="Close navigation menu"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg"
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      {viewerReadOnly &&
        (collapsed ? (
          <Tooltip label="Read-only session: changes are rejected" side="right" className="mx-auto mb-1">
            <span className="grid h-8 w-8 place-items-center rounded-md text-warn" role="img" aria-label="Read-only session">
              <Lock size={14} />
            </span>
          </Tooltip>
        ) : (
          <div className="mx-3 mb-1 flex items-center gap-1.5 rounded-md border border-line border-l-2 border-l-warn px-2.5 py-1.5 text-xs text-fg">
            <Lock size={12} aria-hidden="true" className="text-warn" /> Read-only session
          </div>
        ))}

      <nav aria-label="Primary" className={clsx('flex-1 space-y-4 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-2.5')}>
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.label || gi} role="group" aria-label={group.label || undefined}>
            {group.label &&
              (collapsed ? (
                gi > 0 && <div className="mx-auto mb-2 h-px w-5 bg-line" aria-hidden="true" />
              ) : (
                <p className="px-2.5 pb-1 text-xs font-medium text-subtle" aria-hidden="true">
                  {group.label}
                </p>
              ))}
            <div className="space-y-px">
              {group.items.map((item) => (
                <Tooltip key={item.to} label={collapsed ? item.label : ''} side="right" block>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    aria-label={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      clsx(
                        'group relative flex items-center rounded-md text-sm transition-colors duration-100',
                        collapsed ? 'h-9 w-full justify-center' : 'h-9 gap-2.5 px-2.5 md:h-8',
                        isActive ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg'
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />}
                        <item.icon size={16} className={clsx('shrink-0', isActive ? 'text-fg' : 'text-subtle group-hover:text-muted')} aria-hidden="true" />
                        {!collapsed && item.label}
                      </>
                    )}
                  </NavLink>
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer: live status, logs, theme, collapse toggle */}
      {collapsed ? (
        <div className="flex flex-col items-center gap-1 border-t border-line py-2.5">
          <Tooltip label={connected ? 'Live: socket connected' : 'Offline: reconnecting'} side="right">
            <span className="grid h-8 w-8 place-items-center" role="img" aria-label={connected ? 'Live: socket connected' : 'Offline: reconnecting'}>
              <StatusDot tone={connected ? 'good' : 'bad'} />
            </span>
          </Tooltip>
          <ErrorLog collapsed />
          <ThemeSwitch compact />
          <IconButton icon={PanelLeftOpen} label="Expand sidebar  [" side="right" onClick={toggleNav} aria-expanded="false" aria-controls="app-sidebar" />
        </div>
      ) : (
        <div className="space-y-1 border-t border-line px-2.5 py-2.5 text-sm">
          <div className="flex items-center justify-between gap-2 px-2.5 py-1">
            <span className="flex items-center gap-2 text-muted">
              <StatusDot tone={connected ? 'good' : 'bad'} />
              {connected ? 'Live' : 'Offline'}
            </span>
            <span className="text-xs tabular-nums text-subtle">
              {brokersUp}/{brokers.length} brokers{opcua.length > 0 ? ` · ${opcua.length} OPC UA` : ''}
            </span>
          </div>
          <ErrorLog />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            <ThemeSwitch />
            {!drawer && (
              <Tooltip label="Collapse sidebar" side="top">
                <button
                  type="button"
                  onClick={toggleNav}
                  aria-expanded="true"
                  aria-controls="app-sidebar"
                  aria-label="Collapse sidebar"
                  className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-subtle transition-colors hover:bg-raised hover:text-fg"
                >
                  <PanelLeftClose size={14} aria-hidden="true" />
                  <Kbd>[</Kbd>
                </button>
              </Tooltip>
            )}
          </div>
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
    <div className="flex h-dvh flex-col bg-app text-fg md:flex-row">
      <a href="#main-content" onClick={focusMain} className="skip-link">
        Skip to content
      </a>

      {/* Compact top bar (below md): hamburger opens the off-canvas drawer. */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-app px-2 md:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={drawerOpen}
          aria-controls="mobile-nav"
          className="grid h-10 w-10 place-items-center rounded-md text-fg transition-colors hover:bg-raised"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <Brand />
        <span className="ml-auto flex items-center gap-2 pr-2 text-xs text-muted">
          <StatusDot tone={connected ? 'good' : 'bad'} />
          {connected ? 'Live' : 'Offline'}
        </span>
      </header>

      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        className={clsx('hidden shrink-0 flex-col border-r border-line bg-app transition-[width] duration-150 md:flex', collapsed ? 'w-14' : 'w-56')}
      >
        <SidebarBody collapsed={collapsed} />
      </aside>

      {drawerOpen && (
        <Modal id="mobile-nav" title="Navigation menu" placement="left" onClose={() => setDrawerOpen(false)} className="flex w-72 max-w-[85vw] flex-col !bg-app">
          <SidebarBody collapsed={false} drawer onNavigate={() => setDrawerOpen(false)} onCloseDrawer={() => setDrawerOpen(false)} />
        </Modal>
      )}

      <main id="main-content" tabIndex={-1} aria-label="Page content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-hidden">
        {!connected && (
          // In-flow disconnect banner: pushes the page down instead of covering its header.
          <div role="alert" className="flex shrink-0 items-center justify-center gap-2 border-b border-bad/40 bg-bad/10 px-4 py-1.5 text-xs font-medium text-fg">
            <StatusDot tone="bad" />
            Connection to the Manifold server lost. Live data is stale; reconnecting…
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
