import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  type AccessContext,
  type Database,
  createContent,
  getContent,
  getContentType,
  getTree,
  listContentTypes,
  listLocales,
  listPages,
  moveContent,
  updateContent,
} from "@paperboy/db";
import { aiTranslateBatch, scalarToString } from "@paperboy/shared";

/**
 * The in-product content agent ("Build from brief"). A server-side tool-use
 * loop that runs AS the signed-in user: every tool wraps the same data-layer
 * functions the REST API and the MCP server use, so RBAC, Zod validation and
 * the audit log all apply per call.
 *
 * Safety is structural, not prompt-deep: the tool registry below contains NO
 * publish/unpublish/trash/delete tools — the agent can only produce drafts.
 * A human reviews in the preview pane and publishes.
 */

export interface AgentEvent {
  type: "status" | "tool" | "tool_done" | "done" | "error";
  /** Narration / tool label / error message. */
  text?: string;
  /** Tool name for tool / tool_done events. */
  name?: string;
  ok?: boolean;
  /** Drafts created so far (done event). */
  created?: Array<{ documentId: string; name: string; type: string }>;
}

interface AgentDeps {
  db: Database;
  ctx: AccessContext;
  cfg: { apiKey?: string; model: string };
  emit: (ev: AgentEvent) => void;
}

/* ------------------------------ tool registry ----------------------------- */

interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run: (args: Record<string, unknown>, deps: AgentDeps) => Promise<unknown>;
}

const loc = z.string().optional().describe("Locale code (default 'en')");

const TOOLS: AgentTool[] = [
  {
    name: "list_content_types",
    description: "List all content types (name, kind, fields). ALWAYS call this first to learn the model.",
    schema: z.object({}),
    run: (_a, d) => listContentTypes(d.db),
  },
  {
    name: "get_content_type",
    description: "Get one content type definition by name (full field shapes).",
    schema: z.object({ name: z.string() }),
    run: (a, d) => getContentType(d.db, a.name as string),
  },
  {
    name: "tree",
    description: "List the page tree under a parent (omit parentId for top level).",
    schema: z.object({ parentId: z.string().optional() }),
    run: (a, d) => getTree(d.db, d.ctx, (a.parentId as string | undefined) ?? null),
  },
  {
    name: "list_pages",
    description: "Flat list of all pages in scope (documentId, name, parentId).",
    schema: z.object({}),
    run: (_a, d) => listPages(d.db, d.ctx),
  },
  {
    name: "list_locales",
    description: "List the enabled locales.",
    schema: z.object({}),
    run: (_a, d) => listLocales(d.db),
  },
  {
    name: "get_content",
    description: "Read a content item's working version (draft else published) for a locale.",
    schema: z.object({ documentId: z.string(), locale: loc }),
    run: (a, d) => getContent(d.db, d.ctx, a.documentId as string, (a.locale as string | undefined) ?? "en"),
  },
  {
    name: "create_content",
    description: "Create a new page/block as a DRAFT. Returns the new documentId. Fill fields afterwards with update_content.",
    schema: z.object({
      type: z.string().describe("A content type name from list_content_types"),
      parentId: z.string().nullable().optional().describe("Parent page documentId (null = top level)"),
      locale: loc,
      name: z.string().describe("Editorial display name"),
    }),
    run: async (a, d) => {
      const created = await createContent(d.db, d.ctx, {
        type: a.type as string,
        parentId: (a.parentId as string | null | undefined) ?? null,
        locale: (a.locale as string | undefined) ?? "en",
        name: a.name as string,
      });
      return created;
    },
  },
  {
    name: "update_content",
    description: "Save the working DRAFT of a content item: name, slug (kebab-case) and the field data map.",
    schema: z.object({
      documentId: z.string(),
      locale: loc,
      name: z.string().optional(),
      slug: z.string().nullable().optional(),
      displayInNav: z.boolean().optional(),
      data: z.record(z.unknown()).describe("Field values keyed by field name; see the field-format rules"),
    }),
    run: (a, d) =>
      updateContent(d.db, d.ctx, a.documentId as string, (a.locale as string | undefined) ?? "en", {
        name: a.name as string | undefined,
        slug: a.slug as string | null | undefined,
        displayInNav: a.displayInNav as boolean | undefined,
        data: a.data as Record<string, unknown>,
      }),
  },
  {
    name: "move_content",
    description: "Re-parent (parentId) or reorder (beforeId/afterId) a page.",
    schema: z.object({
      documentId: z.string(),
      parentId: z.string().nullable().optional(),
      beforeId: z.string().nullable().optional(),
      afterId: z.string().nullable().optional(),
    }),
    run: async (a, d) => {
      await moveContent(d.db, d.ctx, a.documentId as string, {
        parentId: a.parentId as string | null | undefined,
        beforeId: a.beforeId as string | null | undefined,
        afterId: a.afterId as string | null | undefined,
      });
      return { ok: true };
    },
  },
  {
    name: "translate_texts",
    description: "Translate an array of strings into a target locale (one batched call). Returns translations in order.",
    schema: z.object({ texts: z.array(z.string()).max(100), targetLocale: z.string() }),
    run: async (a, d) => aiTranslateBatch(a.texts as string[], a.targetLocale as string, d.cfg),
  },
];

/* ------------------------------- the loop -------------------------------- */

const SYSTEM = `You are a content editor working inside Paperboy, a headless CMS, acting on behalf of the signed-in user.

You create and edit DRAFTS only. You cannot publish, delete or move anything to trash — those tools do not exist for you. The human editor reviews your drafts in the live preview and publishes.

Workflow:
1. Call list_content_types first to learn the available types and their fields. Use tree/list_pages to understand the site structure.
2. Create pages with create_content, then fill them with update_content (set a kebab-case slug!).
3. Choose types by their semantics: LandingPage = block-composed canvas; ArticlePage = long-form content; ListPage = lists its CHILDREN of the type in its "listedType" field (a blog/news index); BlogPost = a dated item (set publishDate, summary).
4. PLACEMENT IS PART OF CORRECTNESS: a list-item type (any type named in some ListPage's "listedType", e.g. BlogPost) MUST be created as a CHILD of that ListPage — find it with list_pages/tree. This rule OVERRIDES any suggested parent from the editor: a blog post created under the wrong parent renders with the wrong template at the wrong URL (this exact mistake has shipped broken pages twice).

Field value formats (by field type in the content type definition):
- text / markdown: plain string (markdown fields take Markdown). NEVER start a markdown body with an H1 repeating the page title — the frontend renders the title separately (start at ## or plain prose).
- richtext: TipTap JSON, e.g. {"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello"}]}]}.
- boolean / number: JSON primitives. datetime: ISO-8601 string. select: one option *value* string.
- contentArea: array of block instances: {"key":"b1","blockType":"HeroBlock","display":"full","ref":null,"inline":{...block fields...}} (inline) — "display" is "full" or "narrow".
- image / reference: leave unset unless told otherwise.

Rules:
- Do exactly what the brief asks — no extra pages, no renaming existing content.
- Only write fields that exist on the type. Required fields must be filled.
- For translations, use translate_texts and save the result with update_content in the target locale.
- When finished, summarise what you created in one short paragraph.`;

const MAX_TURNS = 16;
const CALL_TIMEOUT_MS = 90_000;
const DEADLINE_MS = 4 * 60_000;

interface MsgBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

function toolSpecs(): Array<{ name: string; description: string; input_schema: unknown }> {
  return TOOLS.map((t) => {
    const schema = zodToJsonSchema(t.schema, { $refStrategy: "none" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema };
  });
}

async function callAnthropic(
  cfg: { apiKey?: string; model: string },
  messages: Array<{ role: string; content: unknown }>,
): Promise<{ content: MsgBlock[]; stop_reason: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": cfg.apiKey!, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 8192, system: SYSTEM, tools: toolSpecs(), messages }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    return (await res.json()) as { content: MsgBlock[]; stop_reason: string };
  } finally {
    clearTimeout(timer);
  }
}

/** One-line human label for a tool call, shown in the activity stream. */
function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "create_content":
      return `Creating ${scalarToString(input.type) || "content"} “${scalarToString(input.name)}”`;
    case "update_content":
      return `Filling in fields${input.slug ? ` (slug: ${scalarToString(input.slug)})` : ""}`;
    case "translate_texts":
      return `Translating ${Array.isArray(input.texts) ? input.texts.length : "?"} texts to ${scalarToString(input.targetLocale)}`;
    case "move_content":
      return "Arranging pages";
    case "list_content_types":
      return "Reading the content model";
    case "get_content_type":
      return `Inspecting type ${scalarToString(input.name)}`;
    case "tree":
    case "list_pages":
      return "Looking at the page tree";
    case "list_locales":
      return "Checking languages";
    case "get_content":
      return "Reading existing content";
    default:
      return name;
  }
}

export async function runContentAgent(
  deps: AgentDeps,
  brief: string,
  opts: { parentId?: string | null; locale: string },
): Promise<void> {
  const { emit } = deps;
  const created: Array<{ documentId: string; name: string; type: string }> = [];
  const deadline = Date.now() + DEADLINE_MS;

  const intro =
    `Brief from the editor:\n\n${brief}\n\n` +
    `Target locale: ${opts.locale}. ` +
    (opts.parentId
      ? `The editor launched this from the page with documentId ${opts.parentId} — use it as the DEFAULT parent for new pages, EXCEPT where placement rule 4 applies (a list-item type always goes under its ListPage instead).`
      : "Create new pages at the top level (parentId null) unless the brief says otherwise — EXCEPT where placement rule 4 applies (a list-item type always goes under its ListPage).");

  const messages: Array<{ role: string; content: unknown }> = [{ role: "user", content: intro }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() > deadline) {
      emit({ type: "error", text: "Time budget exceeded — review the drafts created so far." });
      return;
    }
    const resp = await callAnthropic(deps.cfg, messages);

    for (const block of resp.content) {
      if (block.type === "text" && block.text?.trim()) emit({ type: "status", text: block.text.trim() });
    }
    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
      emit({ type: "done", created, text: "Drafts ready for review." });
      return;
    }

    messages.push({ role: "assistant", content: resp.content });
    const results: MsgBlock[] = [];
    for (const tu of toolUses) {
      const tool = TOOLS.find((t) => t.name === tu.name);
      const input = (tu.input ?? {}) as Record<string, unknown>;
      emit({ type: "tool", name: tu.name, text: toolLabel(tu.name ?? "", input) });
      try {
        if (!tool) throw new Error(`Unknown tool: ${tu.name}`);
        const args = tool.schema.parse(input);
        const result = await tool.run(args, deps);
        if (tu.name === "create_content" && result && typeof result === "object" && "documentId" in result) {
          const r = result as { documentId: string; name?: string; type?: string };
          created.push({ documentId: r.documentId, name: r.name ?? scalarToString(input.name), type: r.type ?? scalarToString(input.type) });
        }
        emit({ type: "tool_done", name: tu.name, ok: true });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result ?? { ok: true }).slice(0, 16_000) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_done", name: tu.name, ok: false, text: msg });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `Error: ${msg}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  emit({ type: "error", text: "Step limit reached — review the drafts created so far.", created } as AgentEvent);
}
