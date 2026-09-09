import type { ContentTypeDef } from "@paperboy/shared";
import { useState } from "react";
import { Icon } from "../lib/icons.js";
import { TypeIcon } from "../lib/typeIcons.js";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./ui/menu.js";

/**
 * Choose a content type, showing each type's OWN icon.
 *
 * A native `<option>` cannot render one, so the create dialogs disagreed with
 * everything around them: the page tree, the block library and the block palette
 * all mark a type with its icon, while the dialogs that create into them listed
 * bare text. Same shape as the block palette (ContentArea) for the same reason
 * its comment gives — a list of names is read word by word, a list of marks is
 * scanned — and built from the same Menu primitives so there is one way to pick
 * a type, not two.
 */
export function TypePicker({
  id,
  label,
  types,
  value,
  onChange,
  secondary,
  secondaryLabel,
}: {
  /** Ties the visible <label htmlFor> to the trigger. */
  id?: string;
  /** Accessible name — keep it equal to the visible label. */
  label: string;
  types: ContentTypeDef[];
  value: string;
  onChange: (typeName: string) => void;
  /** Types listed last under their own heading (e.g. a form's parts). */
  secondary?: ContentTypeDef[];
  secondaryLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = [...types, ...(secondary ?? [])].find((t) => t.name === value);

  const option = (t: ContentTypeDef) => (
    <MenuItem key={t.name} onSelect={() => onChange(t.name)}>
      <TypeIcon name={t.icon} fallback={fallbackFor(t.kind)} width={15} height={15} className="shrink-0 text-muted" />
      {/* Machine name for tests; the readable name stays the accessible one. */}
      <span data-type={t.name} className="truncate">
        {t.displayName}
      </span>
    </MenuItem>
  );

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <button id={id} type="button" className="field-input mb-3 flex w-full items-center gap-2 text-left" aria-label={label}>
          <TypeIcon
            name={selected?.icon}
            fallback={fallbackFor(selected?.kind)}
            width={15}
            height={15}
            className="shrink-0 text-muted"
          />
          <span className="truncate">{selected?.displayName ?? "Choose a type"}</span>
          <Icon.ChevronDown width={14} height={14} className="ml-auto shrink-0 text-muted" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" label={label} className="max-h-64 overflow-y-auto">
        {types.map(option)}
        {secondary && secondary.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>{secondaryLabel}</MenuLabel>
            {secondary.map(option)}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

const fallbackFor = (kind: ContentTypeDef["kind"] | undefined): string =>
  kind === "block" ? "blocks" : kind === "global" ? "settings" : "file";
