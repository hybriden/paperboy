import { describe, expect, it } from "vitest";
import { reviewBadge } from "./review-badge.js";

// Settings → MCP → "Require human review before agents publish" gates whether an
// agent may publish its own draft. The editor's "🤖 Needs review / Approve" badge
// is the visible side of that gate — so with the gate OFF it must NOT appear, even
// though the draft still carries the provenance `needsReview` flag. (Reported bug:
// the badge showed regardless of the setting.)
describe("reviewBadge", () => {
  const agentDraft = { needsReview: true, updatedVia: "mcp" as const };

  it("shows the actionable needs-review badge when the site requires review", () => {
    expect(reviewBadge(agentDraft, true)).toBe("needs-review");
  });

  it("does NOT demand review when the agent-review gate is off (the reported bug)", () => {
    expect(reviewBadge(agentDraft, false)).toBe("agent-edited");
  });

  it("labels a reviewed agent edit as agent-edited regardless of the gate", () => {
    expect(reviewBadge({ needsReview: false, updatedVia: "mcp" }, true)).toBe("agent-edited");
    expect(reviewBadge({ needsReview: false, updatedVia: "agent" }, false)).toBe("agent-edited");
  });

  it("shows nothing for a human-written version", () => {
    expect(reviewBadge({ needsReview: false, updatedVia: "web" }, true)).toBeNull();
    expect(reviewBadge({ needsReview: false, updatedVia: null }, false)).toBeNull();
  });
});
