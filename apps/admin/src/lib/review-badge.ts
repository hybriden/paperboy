/** Which agent-provenance badge the editor shows for the working version. */
export type ReviewBadge = "needs-review" | "agent-edited" | null;

/**
 * Decide the agent badge for a working version.
 * - "needs-review": an agent wrote it AND the site requires human review before
 *   agents publish (Settings → MCP) — an ACTIONABLE badge with an Approve button.
 * - "agent-edited": an agent wrote it but review is not required — a passive
 *   provenance label, no action implied.
 * - null: a human wrote it; show nothing.
 *
 * `needsReview` is pure provenance (set on every agent write, cleared by a human
 * edit/approve), so it alone must NOT drive the actionable badge — the gate does.
 */
export function reviewBadge(
  version: { needsReview: boolean; updatedVia: "mcp" | "agent" | "web" | null },
  reviewRequired: boolean,
): ReviewBadge {
  const agentWritten = version.updatedVia === "mcp" || version.updatedVia === "agent";
  if (version.needsReview && reviewRequired) return "needs-review";
  if (agentWritten) return "agent-edited";
  return null;
}
