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

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[80] bg-black/45 backdrop-blur-[1px] data-[state=open]:animate-fade-in" />
        <RDialog.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[18%] z-[80] w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel shadow-pop outline-none data-[state=open]:animate-scale-in"
        >
          <Command shouldFilter={false} label="Command palette" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted">
            <div className="flex items-center gap-2 border-b border-line px-3.5">
              <Icon.Search width={17} height={17} className="text-muted" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search content, jump to a view, change theme…"
                className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-muted"
              />
              <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
            </div>
            <Command.List className="max-h-[340px] overflow-auto p-1.5">
              <Command.Empty className="px-3 py-8 text-center text-sm text-muted">
                {searching && search.isLoading ? "Searching…" : "No results."}
              </Command.Empty>

              {gotos.length > 0 && (
                <Command.Group heading="Go to">
                  {gotos.map((c) => (
                    <Item key={c.to} value={`go ${c.label}`} onSelect={() => run(() => navigate(c.to))} icon={c.icon}>
                      {c.label}
                    </Item>
                  ))}
                </Command.Group>
              )}

              {themes.length > 0 && (
                <Command.Group heading="Appearance">
                  {themes.map((c) => (
                    <Item key={c.choice} value={`theme ${c.label}`} onSelect={() => run(() => setChoice(c.choice))} icon={c.icon}>
                      {c.label}
                    </Item>
                  ))}
                </Command.Group>
              )}

              {contentItems.length > 0 && (
                <Command.Group heading={searching ? "Content" : "Recent content"}>
                  {contentItems.map((n) => (
                    <Item
                      key={n.documentId}
                      value={`content ${n.documentId}`}
                      onSelect={() => run(() => navigate(`/edit/${n.documentId}`))}
                      icon={n.kind === "block" ? <Icon.Block width={15} height={15} /> : <Icon.File width={15} height={15} />}
                    >
                      <span className="truncate">{n.name}</span>
                      <span className="ml-auto font-mono text-[11px] text-muted">{n.type}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
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
      className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius)] px-3 py-2 text-sm text-fg outline-none data-[selected=true]:bg-accent/10 data-[selected=true]:text-accent-700"
    >
      <span className="text-muted">{icon}</span>
      {children}
    </Command.Item>
  );
}
