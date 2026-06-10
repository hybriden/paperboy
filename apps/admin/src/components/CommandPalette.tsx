import * as RDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { useTheme } from "../lib/theme.js";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const { setChoice } = useTheme();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState("");

  // Reset on open so the palette never shows a stale query.
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);
  // Debounce the server search so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length > 0;
  // Empty query → recent root content; non-empty → real server search across the
  // WHOLE tree (not just roots). cmdk's own filtering is disabled (shouldFilter)
  // so server results are shown verbatim.
  const tree = useQuery({ queryKey: ["tree", "root"], queryFn: ({ signal }) => api.tree(undefined, signal), enabled: open && !searching });
  const search = useQuery({ queryKey: ["search", debounced], queryFn: ({ signal }) => api.search(debounced, signal), enabled: open && searching });
  const contentItems = searching ? (search.data ?? []) : (tree.data ?? []);

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  // We filter the static commands ourselves (shouldFilter is off for the group).
  const q = query.trim().toLowerCase();
  const match = (label: string) => !q || label.toLowerCase().includes(q);
  const gotos = [
    { label: "Edit", to: "/edit", icon: <Icon.Edit width={15} height={15} /> },
    { label: "Dashboard", to: "/dashboard", icon: <Icon.Dashboard width={15} height={15} /> },
    { label: "Settings", to: "/settings", icon: <Icon.Settings width={15} height={15} /> },
  ].filter((c) => match(c.label));
  const themes = [
    { label: "Light theme", choice: "light" as const, icon: <Icon.Sun width={15} height={15} /> },
    { label: "Dark theme", choice: "dark" as const, icon: <Icon.Moon width={15} height={15} /> },
    { label: "System theme", choice: "system" as const, icon: <Icon.Monitor width={15} height={15} /> },
  ].filter((c) => match(c.label));

  const hitCount = gotos.length + themes.length + contentItems.length;

  // cmdk doesn't re-select when async results replace the list (shouldFilter is
  // off), which leaves Enter dead after typing — keep the first hit armed.
  const firstGoto = gotos[0];
  const firstTheme = themes[0];
  const firstContent = contentItems[0];
  const firstValue = firstGoto
    ? `go ${firstGoto.label}`
    : firstTheme
      ? `theme ${firstTheme.label}`
      : firstContent
        ? `content ${firstContent.documentId}`
        : "";
  useEffect(() => {
    setSelected(firstValue);
  }, [firstValue, debounced]);

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <RDialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[15%] z-[80] w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel shadow-pop outline-none data-[state=open]:animate-scale-in"
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <Command shouldFilter={false} label="Command palette" value={selected} onValueChange={setSelected}>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Icon.Search width={18} height={18} className="shrink-0 text-muted" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search the newsroom…"
                className="h-14 w-full bg-transparent text-[15px] text-fg caret-accent outline-none focus-visible:!outline-none placeholder:text-muted/80"
              />
              <Kbd>esc</Kbd>
            </div>
            <Command.List className="max-h-[400px] overflow-auto px-2 pb-2">
              <Command.Empty className="px-3 py-10 text-center">
                {searching && search.isLoading ? (
                  <span className="text-sm text-muted">Searching…</span>
                ) : (
                  <>
                    <p className="text-sm font-medium text-fg">No matches for “{query.trim()}”.</p>
                    <p className="mt-1 text-xs text-muted">Try a different search.</p>
                  </>
                )}
              </Command.Empty>

              {gotos.length > 0 && (
                <Command.Group heading={<GroupHeading>Go to</GroupHeading>}>
                  {gotos.map((c) => (
                    <Item key={c.to} value={`go ${c.label}`} onSelect={() => run(() => navigate(c.to))} icon={c.icon}>
                      <span className="truncate">{highlight(c.label, q)}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              {themes.length > 0 && (
                <Command.Group heading={<GroupHeading>Appearance</GroupHeading>}>
                  {themes.map((c) => (
                    <Item key={c.choice} value={`theme ${c.label}`} onSelect={() => run(() => setChoice(c.choice))} icon={c.icon}>
                      <span className="truncate">{highlight(c.label, q)}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              {contentItems.length > 0 && (
                <Command.Group heading={<GroupHeading>{searching ? "Content" : "Recent content"}</GroupHeading>}>
                  {contentItems.map((n) => {
                    const urlPath = "urlPath" in n ? n.urlPath : null;
                    const statuses = "locales" in n ? Object.values(n.locales) : [];
                    const published = statuses.some((s) => s.status === "published");
                    return (
                      <Item
                        key={n.documentId}
                        value={`content ${n.documentId}`}
                        onSelect={() => run(() => navigate(`/edit/${n.documentId}`))}
                        icon={n.kind === "block" ? <Icon.Block width={15} height={15} /> : <Icon.File width={15} height={15} />}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="truncate text-sm">{highlight(n.name, q)}</span>
                            {statuses.length > 0 && (
                              <span
                                aria-hidden
                                className={`h-[6px] w-[6px] shrink-0 rounded-full ${published ? "bg-published" : "bg-draft"}`}
                                title={published ? "Published" : "Draft"}
                              />
                            )}
                          </span>
                          {urlPath && <span className="block truncate font-mono text-[11px] leading-4 text-muted">{urlPath}</span>}
                        </span>
                        {"locale" in n && <Tag>{n.locale}</Tag>}
                        <Tag>{n.type}</Tag>
                      </Item>
                    );
                  })}
                </Command.Group>
              )}
            </Command.List>

            {/* Footer — desk hints, like a wire terminal status bar. */}
            <div className="flex items-center justify-between border-t border-line bg-canvas/60 px-4 py-2">
              <div className="flex items-center gap-3 text-[11px] text-muted">
                <span className="flex items-center gap-1">
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> navigate
                </span>
                <span className="flex items-center gap-1">
                  <Kbd>↵</Kbd> open
                </span>
              </div>
              <span className="tnum font-mono text-[11px] text-muted">
                {searching ? (search.isLoading ? "searching…" : `${hitCount} ${hitCount === 1 ? "hit" : "hits"}`) : "Paperboy index"}
              </span>
            </div>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Newspaper section slug: small caps with a hairline rule running to the edge. */
function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2.5 px-2 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">
      <span className="shrink-0">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted">{children}</kbd>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-[4px] border border-line bg-canvas px-1.5 py-px font-mono text-[10px] text-muted">{children}</span>
  );
}

/** Mark the matched substring like a proofreader's highlight. */
function highlight(text: string, q: string): React.ReactNode {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[2px] bg-accent/15 text-inherit">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Item({
  children,
  icon,
  onSelect,
  value,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onSelect: () => void;
  value?: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="group relative flex cursor-pointer items-center gap-3 rounded-[var(--radius)] px-2.5 py-2 text-sm text-fg outline-none transition-colors duration-100 before:absolute before:bottom-[7px] before:left-0 before:top-[7px] before:w-[2.5px] before:rounded-full before:bg-accent before:opacity-0 before:transition-opacity data-[selected=true]:bg-accent/[0.08] data-[selected=true]:before:opacity-100"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-line/80 bg-canvas text-muted transition-colors group-data-[selected=true]:border-accent/30 group-data-[selected=true]:bg-accent-50 group-data-[selected=true]:text-accent-700">
        {icon}
      </span>
      {children}
    </Command.Item>
  );
}
