import * as RTooltip from "@radix-ui/react-tooltip";

export const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <RTooltip.Provider delayDuration={350} skipDelayDuration={200}>
    {children}
  </RTooltip.Provider>
);

export function Tooltip({
  label,
  children,
  side = "bottom",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md border border-line bg-panel px-2 py-1 text-xs font-medium text-fg shadow-pop data-[state=delayed-open]:animate-fade-in"
        >
          {label}
          <RTooltip.Arrow className="fill-[rgb(var(--c-panel))]" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
