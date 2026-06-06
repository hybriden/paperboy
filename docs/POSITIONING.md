# Positioning: agent-native first, workflow-light second

**Status:** decided (2026-06-06) · **Owner:** Hans Christian Thjømøe

## The question

Paperboy is feature-competitive with the major headless CMSes for solo
developers and small teams (see the 2026-06 audit). Two growth directions
compete for the roadmap:

- **(A) Classic editorial workflow** — approval chains, field comments,
  custom roles, SSO, bulk operations. The Contentful/Storyblok/Optimizely
  lane: chase enterprise team parity.
- **(B) Agent-native** — double down on being the CMS designed to be
  operated by AI agents and humans side by side.

## Decision: (B), agent-native first

1. **Differentiation.** The workflow lane is crowded and owned: Contentful,
   Storyblok and Optimizely sell approval chains to enterprises; Payload and
   Strapi fight over the self-hosted slice of the same lane. Nobody credibly
   owns "the CMS built for the agent era". Paperboy already has the
   substance, not just the slogan: an MCP server that inherits RBAC and
   audit, a test-pinned coercion chokepoint, self-teaching errors, agent-API
   design rules distilled from real agent failures (CLAUDE.md), and — as of
   the contract-freeze suite — an *executable* parity contract
   (`mcp-parity.test.ts` spawns the real server and locks the tool surface).

2. **The team is already hybrid.** The reference production deploy's blog is
   written by an agent pipeline and curated by a human. That is the shape of
   the next five years of content teams. What such teams need is not a
   five-step approval chain — it's *provenance* (which agent wrote this?),
   *review* (one human gate over agent output), and *rollback* (already
   shipped: versions). Building classic workflow first would optimize for
   the previous era's org chart.

3. **Reversibility.** Agent-native investments (provenance, review flag,
   eval-CI) don't preclude approval chains later; they're the substrate an
   approval feature would sit on anyway. The reverse is not true — a
   workflow engine designed for human sign-off becomes a straitjacket the
   agent surface has to tunnel through.

## What this means we build (in rough order)

1. **Agent provenance in the editor** — the audit log already records every
   MCP write (`ip='mcp'`, token identity). Surface it: "last edited by
   *harmonix (agent)*" on versions and in the tree, so humans always know
   which content is machine-made.
2. **A review flag, not a workflow engine** — one optional state on
   versions created via MCP ("needs human review"), a filtered queue view in
   the admin, and publish-gating per token. This is the agent-era approval
   workflow: one state, zero configuration.
3. **MCP eval suite in CI** — the parity tests lock the *contract*; a small
   scheduled eval (a real model driving "write a post from this brief, with
   a stock image, publish it") locks the *usability* against model drift.
   Failures show exactly which tool description stopped working.
4. **Events → agents** — webhooks already fire on publish; document and
   demo the loop where content events trigger agent jobs (translate on
   publish, social copy on publish).

## What we deliberately do NOT build (until real users pull for it)

- Multi-step approval chains / configurable workflow states
- Field-level comment threads
- SSO/SAML, custom-role builder UI
- A plugin system (the codebase is the extension point — see STACK.md)

Each of these is a "fast follow if pulled" — none is a bet we place first.

## Tagline

> **Paperboy — the headless CMS built for teams of humans *and* agents.**
> Every write path — admin UI, REST, MCP — goes through the same validation,
> the same permissions, the same audit trail. Agents are first-class
> editors, not an integration afterthought.
