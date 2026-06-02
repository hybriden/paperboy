import * as RMenu from "@radix-ui/react-dropdown-menu";

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;

export function MenuContent({
  children,
  align = "end",
  className = "",
}: {
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        sideOffset={6}
        className={`z-50 min-w-[200px] overflow-hidden rounded-[var(--radius-lg)] border border-line bg-panel p-1 shadow-pop data-[state=open]:animate-slide-up ${className}`}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  destructive,
  disabled,
  shortcut,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
}) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={`flex cursor-pointer items-center gap-2 rounded-[var(--radius)] px-2.5 py-1.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 ${
        destructive ? "text-danger data-[highlighted]:bg-danger/10" : "text-fg data-[highlighted]:bg-accent/10 data-[highlighted]:text-accent-700"
      }`}
    >
      {children}
      {shortcut && <span className="ml-auto text-[11px] tracking-wide text-muted">{shortcut}</span>}
    </RMenu.Item>
  );
}

export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <RMenu.Label className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</RMenu.Label>;
}
