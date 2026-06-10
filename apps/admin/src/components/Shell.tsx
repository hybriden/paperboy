import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon } from "../lib/icons.js";
import { useTheme } from "../lib/theme.js";
import { useIsMobile } from "../lib/useMediaQuery.js";
import { useUser } from "../lib/user.js";
import { CommandPalette } from "./CommandPalette.js";
import { SiteSwitcher } from "./SiteSwitcher.js";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./ui/menu.js";
import { Tooltip } from "./ui/tooltip.js";

export interface ShellOutlet {
  setCrumb: (text: string | null) => void;
}

/** Show the native modifier in the shortcut hint (⌘ on macOS, Ctrl elsewhere). */
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);

const RAIL = [
  { to: "/dashboard", icon: Icon.Dashboard, label: "Dashboard" },
  { to: "/edit", icon: Icon.Edit, label: "Edit" },
  { to: "/settings", icon: Icon.Settings, label: "Settings" },
];

export function Shell() {
  const [crumb, setCrumb] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const isMobile = useIsMobile();

  const section =
    location.pathname.startsWith("/dashboard") ? "Dashboard" : location.pathname.startsWith("/settings") ? "Settings" : "Edit";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TopBar section={section} crumb={crumb} compact={isMobile} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        {!isMobile && <Rail />}
        <div className="min-w-0 flex-1">
          <Outlet context={{ setCrumb } satisfies ShellOutlet} />
        </div>
      </div>
      {isMobile && <BottomNav />}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function TopBar({
  section,
  crumb,
  compact,
  onOpenPalette,
}: {
  section: string;
  crumb: string | null;
  compact: boolean;
  onOpenPalette: () => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b-2 border-brand bg-chrome px-3 text-chrome-fg">
      <div className="flex items-baseline gap-2 pr-2">
        <span className="masthead text-[22px] leading-none text-chrome-fg">Paperboy</span>
        <span className="hidden text-[10px] font-semibold uppercase tracking-[0.2em] text-chrome-fg/75 sm:inline">CMS</span>
      </div>

      {/* On phones the breadcrumb is dropped — the bottom nav shows the section,
          and the editor surfaces the document name itself. */}
      {!compact && (
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-chrome-fg/80">
          <span className="text-chrome-fg/55" aria-hidden>/</span>
          <span className="font-medium text-chrome-fg">{section}</span>
          {crumb && (
            <>
              <span className="text-chrome-fg/55" aria-hidden>/</span>
              <span className="max-w-[280px] truncate text-chrome-fg">{crumb}</span>
            </>
          )}
        </nav>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onOpenPalette}
          className="flex h-9 items-center gap-2 rounded-[var(--radius)] px-2.5 text-sm text-chrome-fg/60 transition-colors hover:bg-chrome-light hover:text-chrome-fg/90"
          aria-label="Open command palette"
        >
          <Icon.Search width={15} height={15} className="shrink-0" />
          <span className="hidden leading-none md:inline">Search…</span>
          <kbd className="hidden rounded border border-chrome-border/80 px-1.5 py-0.5 font-mono text-[10px] leading-none text-chrome-fg/55 md:inline">
            {IS_MAC ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
        <SiteSwitcher />
        <ThemeToggle />
        {!compact && (
          <a
            href="/api/docs"
            target="_blank"
            rel="noreferrer"
            className="grid h-9 w-9 place-items-center rounded-[var(--radius)] text-chrome-fg/70 hover:bg-chrome-light"
            aria-label="API documentation"
            title="API docs"
          >
            <Icon.Api width={17} height={17} />
          </a>
        )}
        <UserMenu />
      </div>
    </header>
  );
}

function ThemeToggle() {
  const { choice, resolved, setChoice } = useTheme();
  const Cur = resolved === "dark" ? Icon.Moon : Icon.Sun;
  return (
    <Menu>
      <Tooltip label="Theme">
        <MenuTrigger className="grid h-9 w-9 place-items-center rounded-[var(--radius)] text-chrome-fg/70 hover:bg-chrome-light" aria-label="Theme">
          <Cur width={17} height={17} />
        </MenuTrigger>
      </Tooltip>
      <MenuContent>
        <MenuLabel>Appearance</MenuLabel>
        {(["light", "dark", "system"] as const).map((c) => {
          const I = c === "light" ? Icon.Sun : c === "dark" ? Icon.Moon : Icon.Monitor;
          return (
            <MenuItem key={c} onSelect={() => setChoice(c)}>
              <I width={15} height={15} className="text-muted" />
              <span className="capitalize">{c}</span>
              {choice === c && <span className="ml-auto text-accent-700">✓</span>}
            </MenuItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

function UserMenu() {
  const { user, logout } = useUser();
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return (
    <Menu>
      <MenuTrigger className="ml-1 flex items-center gap-2 rounded-[var(--radius)] py-1 pl-1 pr-2 hover:bg-chrome-light" aria-label="Account menu">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-accent text-xs font-bold text-accent-fg">{initials}</span>
        <Icon.ChevronDown width={14} height={14} className="text-chrome-fg/60" />
      </MenuTrigger>
      <MenuContent>
        <div className="px-2.5 py-1.5">
          <div className="text-sm font-semibold text-fg">{user.name}</div>
          <div className="text-xs text-muted">{user.email}</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {user.roles.map((r) => (
              <span key={r} className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-700">{r}</span>
            ))}
          </div>
        </div>
        <MenuSeparator />
        <MenuItem onSelect={logout} destructive>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function Rail() {
  const { pathname } = useLocation();
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-chrome-border bg-chrome-rail py-3" aria-label="Main">
      {RAIL.map((it) => {
        const isActive = pathname === it.to || pathname.startsWith(`${it.to}/`);
        return (
          <Tooltip key={it.to} label={it.label} side="right">
            <NavLink
              to={it.to}
              aria-label={it.label}
              className={`grid h-10 w-10 place-items-center rounded-[var(--radius)] transition-colors ${
                isActive ? "bg-accent text-accent-fg" : "text-chrome-fg/80 hover:bg-chrome-light hover:text-chrome-fg"
              }`}
            >
              <it.icon />
            </NavLink>
          </Tooltip>
        );
      })}
    </nav>
  );
}

/** Phone navigation: the side rail laid out as a touch-friendly bottom tab bar. */
function BottomNav() {
  const { pathname } = useLocation();
  return (
    <nav className="flex shrink-0 items-stretch border-t border-chrome-border bg-chrome-rail" aria-label="Main">
      {RAIL.map((it) => {
        const isActive = pathname === it.to || pathname.startsWith(`${it.to}/`);
        return (
          <NavLink
            key={it.to}
            to={it.to}
            aria-label={it.label}
            className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors ${
              isActive ? "text-accent" : "text-chrome-fg/80 hover:text-chrome-fg"
            }`}
          >
            <it.icon />
            {it.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
