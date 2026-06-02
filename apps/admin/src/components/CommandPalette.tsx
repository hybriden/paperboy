import * as RDialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { Icon } from "../lib/icons.js";
import { useTheme } from "../lib/theme.js";

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const { setChoice } = useTheme();
  // Loaded lazily — only fetch the index when the palette is opened.
  const tree = useQuery({ queryKey: ["tree", "root"], queryFn: ({ signal }) => api.tree(undefined, signal), enabled: open });
  const nodes = tree.data ?? [];

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[80] bg-black/45 backdrop-blur-[1px] data-[state=open]:animate-fade-in" />
        <RDialog.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[18%] z-[80] w-[min(620px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel shadow-pop outline-none data-[state=open]:animate-scale-in"
        >
          <Command label="Command palette" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-muted">
            <div className="flex items-center gap-2 border-b border-line px-3.5">
              <Icon.Search width={17} height={17} className="text-muted" />
              <Command.Input
                autoFocus
                placeholder="Search content, jump to a view, change theme…"
                className="h-12 w-full bg-transparent text-sm text-fg outline-none placeholder:text-muted"
              />
              <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
            </div>
            <Command.List className="max-h-[340px] overflow-auto p-1.5">
              <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No results.</Command.Empty>

              <Command.Group heading="Go to">
                <Item onSelect={() => run(() => navigate("/edit"))} icon={<Icon.Edit width={15} height={15} />}>Edit</Item>
                <Item onSelect={() => run(() => navigate("/dashboard"))} icon={<Icon.Dashboard width={15} height={15} />}>Dashboard</Item>
                <Item onSelect={() => run(() => navigate("/settings"))} icon={<Icon.Settings width={15} height={15} />}>Settings</Item>
              </Command.Group>

              <Command.Group heading="Appearance">
                <Item onSelect={() => run(() => setChoice("light"))} icon={<Icon.Sun width={15} height={15} />}>Light theme</Item>
                <Item onSelect={() => run(() => setChoice("dark"))} icon={<Icon.Moon width={15} height={15} />}>Dark theme</Item>
                <Item onSelect={() => run(() => setChoice("system"))} icon={<Icon.Monitor width={15} height={15} />}>System theme</Item>
              </Command.Group>

              {nodes.length > 0 && (
                <Command.Group heading="Content">
                  {nodes.map((n) => (
                    <Item
                      key={n.documentId}
                      value={`${n.name} ${n.type} ${n.documentId}`}
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
