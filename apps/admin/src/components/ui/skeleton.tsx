/**
 * Skeleton — a shimmer placeholder for first-load states, replacing bare
 * spinners and "Loading…" text. `animate-pulse` is automatically calmed by the
 * global prefers-reduced-motion rule in index.css.
 *
 * - Skeleton: one block; size it via className (e.g. `h-7 w-32`).
 * - SkeletonRows: a stack of list-row placeholders for tables/lists.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-line/50 ${className}`} />;
}

export function SkeletonRows({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden className={`h-12 animate-pulse border-b border-line bg-line/30 last:border-0 ${className}`} />
      ))}
    </>
  );
}
