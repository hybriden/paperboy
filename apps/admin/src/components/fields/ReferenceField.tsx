import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../lib/api.js";

/**
 * Page picker for `reference` fields. Stores { documentId } — the delivery
 * chokepoint resolves it (shallow {documentId,type} or the full content when
 * populated). Options are ordered like the tree, indented by depth.
 */
export function ReferenceField({
  id,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });
  const v = (value as { documentId?: string } | null) ?? null;

  const rows = useMemo(() => {
    const list = pages.data ?? [];
    const children = new Map<string | null, typeof list>();
    for (const p of list) {
      const k = p.parentId ?? null;
      children.set(k, [...(children.get(k) ?? []), p]);
    }
    const out: Array<{ documentId: string; type: string; label: string }> = [];
    const seen = new Set<string>(); // cycle guard
    const walk = (parent: string | null, depth: number) => {
      if (depth > 20) return;
      for (const p of children.get(parent) ?? []) {
        if (seen.has(p.documentId)) continue;
        seen.add(p.documentId);
        out.push({ documentId: p.documentId, type: p.type, label: `${"  ".repeat(depth)}${p.name}` });
        walk(p.documentId, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [pages.data]);

  return (
    <select
      id={id}
      className="field-input"
      value={v?.documentId ?? ""}
      disabled={disabled}
      onChange={(e) => {
        const picked = rows.find((r) => r.documentId === e.target.value);
        onChange(picked ? { documentId: picked.documentId, type: picked.type } : null);
      }}
    >
      <option value="">— choose a page —</option>
      {rows.map((r) => (
        <option key={r.documentId} value={r.documentId}>{r.label}</option>
      ))}
    </select>
  );
}
