import * as RSwitch from "@radix-ui/react-switch";

export function Switch({
  checked,
  onCheckedChange,
  id,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  label?: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-fg">
      <RSwitch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="relative h-5 w-9 shrink-0 rounded-full border border-line bg-line/70 outline-none transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent"
      >
        <RSwitch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-panel shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </RSwitch.Root>
      {label && <span>{label}</span>}
    </label>
  );
}
