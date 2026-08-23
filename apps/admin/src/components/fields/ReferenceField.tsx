import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../../lib/api.js";

/**
 * Picker for a `reference` field. Stores { documentId, type } — the delivery
 * chokepoint resolves it (shallow {documentId,type} or the full content when
 * populated).
 *
 * It offers whatever the field's `allowedTypes` permit, from BOTH pages (tree
 * order, indented by depth) and shared blocks. Two reasons it must:
 *
 *  - a reference to a block type — a contact section pointing at a shared Form,
 *    the built-in case — had an EMPTY dropdown labelled "choose a page", so the
 *    value could only be set through the API;
 *  - `allowedTypes` is write-enforced (assertAllowedTypes rejects a reference to
 *    a type the field disallows), so listing everything only moved the failure
 *    to save time. Same rule as the block palette: don't offer what can't land.
 */
export function ReferenceField({
  id,
  value,
  allowedTypes = [],
  disabled = false,
  onChange,
}: {
  id: string;
  value: unknown;
  /** Content types this field accepts. Empty = any. */
  allowedTypes?: string[];
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  // Same query keys as the rest of the admin, so these are already cached.
  const pages = useQuery({ queryKey: ["pages"], queryFn: ({ signal }) => api.pages(signal) });
  const blocks = useQuery({ queryKey: ["blocks"], queryFn: ({ signal }) => api.blocks(signal) });
  const types = useQuery({ queryKey: ["content-types"], queryFn: ({ signal }) => api.contentTypes(signal) });
  const v = (value as { documentId?: string } | null) ?? null;

  const accepts = useMemo(() => {
    const allow = new Set(allowedTypes);
    return (type: string) => allow.size === 0 || allow.has(type);
  }, [allowedTypes]);

  const pageRows = useMemo(() => {
    const list = pages.data ?? [];
    const children = new Map<string | null, typeof list>();
    for (const p of list) {
      const k = p.parentId ?? null;
      children.set(k, [...(children.get(k) ?? []), p]);
    }
    const out: Array<{ documentId: string; type: string; label: string }> = [];
    const seen = new Set<string>(); // cycle guard
    // Walk the whole tree regardless of what is accepted — a rejected ANCESTOR
    // must not hide an acceptable descendant.
    const walk = (parent: string | null, depth: number) => {
      if (depth > 20) return;
      for (const p of children.get(parent) ?? []) {
        if (seen.has(p.documentId)) continue;
        seen.add(p.documentId);
        if (accepts(p.type)) {
          out.push({ documentId: p.documentId, type: p.type, label: `${"  ".repeat(depth)}${p.name}` });
        }
        walk(p.documentId, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [pages.data, accepts]);

  const blockRows = useMemo(
    () =>
      (blocks.data ?? [])
        .filter((b) => accepts(b.type))
        .map((b) => ({ documentId: b.documentId, type: b.type, label: b.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [blocks.data, accepts],
  );

  const rows = useMemo(() => [...pageRows, ...blockRows], [pageRows, blockRows]);

  // Name what is being chosen. "choose a page" was wrong whenever the field
  // pointed at anything else.
  const placeholder = useMemo(() => {
    if (allowedTypes.length !== 1) return "— choose —";
    const only = allowedTypes[0]!;
    const display = (types.data ?? []).find((t) => t.name === only)?.displayName ?? only;
    return `— choose a ${display} —`;
  }, [allowedTypes, types.data]);

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
      <option value="">{placeholder}</option>
      {/* Grouped only when there is something in both — a single group would
          otherwise gain a pointless header. */}
      {pageRows.length > 0 && blockRows.length > 0 ? (
        <>
          <optgroup label="Pages">
            {pageRows.map((r) => <option key={r.documentId} value={r.documentId}>{r.label}</option>)}
          </optgroup>
          <optgroup label="Blocks">
            {blockRows.map((r) => <option key={r.documentId} value={r.documentId}>{r.label}</option>)}
          </optgroup>
        </>
      ) : (
        rows.map((r) => <option key={r.documentId} value={r.documentId}>{r.label}</option>)
      )}
    </select>
  );
}
