import { z } from "zod";
import {
  type AccessContext,
  type Database,
  createContent,
  getContent,
  resolveDefaultLocale,
  resolveRequestedLocale,
  getContentType,
  getTree,
  listContentTypes,
  listLocales,
  listPages,
  moveContent,
  updateContent,
} from "@paperboy/db";
import {
  type AiConfig,
  aiTranslateBatch,
  openAiMessageText,
  postAnthropicMessages,
  postOpenAiChat,
  scalarToString,
} from "@paperboy/shared";

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
  cfg: AiConfig;
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

export const TOOLS: AgentTool[] = [
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
    run: async (a, d) =>
      // resolveRequestedLocale, not `?? "en"`: the document's own site decides the
      // default, and a locale-less call on a document with no variant there fails
      // loudly instead of silently reading an empty branch.
      getContent(d.db, d.ctx, a.documentId as string, await resolveRequestedLocale(d.db, a.documentId as string, a.locale as string | undefined)),
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
        // A NEW document has no variants yet, so this resolves to the site default.
        locale: (a.locale as string | undefined) ?? (await resolveDefaultLocale(d.db, d.ctx.siteId)),
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
      data: z.record(z.string(), z.unknown()).describe("Field values keyed by field name; see the field-format rules"),
    }),
    run: async (a, d) =>
      updateContent(d.db, d.ctx, a.documentId as string, await resolveRequestedLocale(d.db, a.documentId as string, a.locale as string | undefined), {
        name: a.name as string | undefined,
        slug: a.slug as string | null | undefined,
        displayInNav: a.displayInNav as boolean | undefined,
        data: a.data as Record<string, unknown>,
        // Merge by default (agent-API rule #5): a full replace silently drops
        // fields set by prior calls and bricks the next publish. Mirrors the MCP
        // update_content default.
        merge: true,
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

/* ------------------------- provider-neutral loop I/O ----------------------- */
// The loop thinks in a NEUTRAL transcript; each model call converts it to the
// configured provider's dialect (Anthropic tool_use blocks vs OpenAI
// tool_calls). One loop, two wire formats — adding a dialect never touches the
// tool registry or the loop logic.

interface NeutralToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Set when the provider sent unparseable arguments — surfaced as a tool error. */
  inputError?: string;
}
type NeutralTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; toolCalls: NeutralToolCall[] }
  | { kind: "toolResults"; results: Array<{ id: string; content: string; isError: boolean }> };

interface ModelTurn {
  text: string;
  toolCalls: NeutralToolCall[];
}

function toolJsonSchema(t: AgentTool): Record<string, unknown> {
  const schema = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

async function callAnthropicModel(cfg: AiConfig, transcript: NeutralTurn[]): Promise<ModelTurn> {
  type Block = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> };
  const messages = transcript.map((t) => {
    if (t.kind === "user") return { role: "user", content: t.text };
    if (t.kind === "assistant") {
      const blocks: unknown[] = [];
      if (t.text) blocks.push({ type: "text", text: t.text });
      for (const c of t.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      return { role: "assistant", content: blocks };
    }
    return {
      role: "user",
      content: t.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
    };
  });
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: toolJsonSchema(t) }));
  const data = await postAnthropicMessages(cfg, { model: cfg.model, max_tokens: 8192, system: SYSTEM, tools, messages }, CALL_TIMEOUT_MS);
  const content = (data.content ?? []) as Block[];
  return {
    text: content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim(),
    toolCalls: content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: (b.input ?? {}) as Record<string, unknown> })),
  };
}

async function callOpenAiModel(cfg: AiConfig, transcript: NeutralTurn[]): Promise<ModelTurn> {
  const messages: unknown[] = [{ role: "system", content: SYSTEM }];
  for (const t of transcript) {
    if (t.kind === "user") {
      messages.push({ role: "user", content: t.text });
    } else if (t.kind === "assistant") {
      messages.push({
        role: "assistant",
        content: t.text || null,
        ...(t.toolCalls.length
          ? { tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
    } else {
      // OpenAI has no error flag on tool messages — the "Error: …" content string carries it.
      for (const r of t.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: toolJsonSchema(t) } }));
  const data = await postOpenAiChat(cfg, { model: cfg.model, max_tokens: 8192, messages, tools }, CALL_TIMEOUT_MS);
  const message = (data.choices as Array<{ message?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]?.message;
  const toolCalls: NeutralToolCall[] = (message?.tool_calls ?? []).map((c, i) => {
    const raw = c.function?.arguments ?? "{}";
    try {
      const input = raw.trim() === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      return { id: c.id ?? `call_${i}`, name: c.function?.name ?? "", input };
    } catch {
      return {
        id: c.id ?? `call_${i}`,
        name: c.function?.name ?? "",
        input: {},
        inputError: `The tool arguments were not valid JSON. Send a single JSON object matching the tool's schema. Received: ${raw.slice(0, 300)}`,
      };
    }
  });
  return { text: openAiMessageText(data), toolCalls };
}

const callModel = (cfg: AiConfig, transcript: NeutralTurn[]): Promise<ModelTurn> =>
  (cfg.provider ?? "anthropic") === "openai" ? callOpenAiModel(cfg, transcript) : callAnthropicModel(cfg, transcript);

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

  const transcript: NeutralTurn[] = [{ kind: "user", text: intro }];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (Date.now() > deadline) {
      emit({ type: "error", text: "Time budget exceeded — review the drafts created so far." });
      return;
    }
    const resp = await callModel(deps.cfg, transcript);

    if (resp.text) emit({ type: "status", text: resp.text });
    if (resp.toolCalls.length === 0) {
      emit({ type: "done", created, text: "Drafts ready for review." });
      return;
    }

    transcript.push({ kind: "assistant", text: resp.text, toolCalls: resp.toolCalls });
    const results: Array<{ id: string; content: string; isError: boolean }> = [];
    for (const tu of resp.toolCalls) {
      const tool = TOOLS.find((t) => t.name === tu.name);
      emit({ type: "tool", name: tu.name, text: toolLabel(tu.name, tu.input) });
      try {
        if (tu.inputError) throw new Error(tu.inputError);
        if (!tool) throw new Error(`Unknown tool: ${tu.name}`);
        const args = tool.schema.parse(tu.input);
        const result = await tool.run(args, deps);
        if (tu.name === "create_content" && result && typeof result === "object" && "documentId" in result) {
          const r = result as { documentId: string; name?: string; type?: string };
          created.push({ documentId: r.documentId, name: r.name ?? scalarToString(tu.input.name), type: r.type ?? scalarToString(tu.input.type) });
        }
        emit({ type: "tool_done", name: tu.name, ok: true });
        results.push({ id: tu.id, content: JSON.stringify(result ?? { ok: true }).slice(0, 16_000), isError: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "tool_done", name: tu.name, ok: false, text: msg });
        results.push({ id: tu.id, content: `Error: ${msg}`, isError: true });
      }
    }
    transcript.push({ kind: "toolResults", results });
  }
  emit({ type: "error", text: "Step limit reached — review the drafts created so far.", created } as AgentEvent);
}
