/**
 * pino error serializer that never logs bound query parameters.
 *
 * drizzle-orm wraps a failed query as `DrizzleQueryError`, whose `.message` is
 * built as `Failed query: <sql>\nparams: <bound values>` — so the bound values
 * land in `err.message` as free text. The SQL itself uses `$1,$2` placeholders
 * (safe), but the params carry real values: `readSession` runs on EVERY request
 * and binds the opaque session token, and writes touching users/keys bind their
 * material. pino's default `err` serializer emits `err.message` verbatim, so a
 * DB error reaching a `log.error({ err })` would write that token to the log.
 *
 * Path-based `redact` can't reach a substring of `err.msg`; a serializer can.
 * This keeps the query (placeholders only) and everything useful, and replaces
 * only the `params:` tail — on the error and its `cause` — with `[redacted]`.
 */
const PARAMS_TAIL = /\nparams:[\s\S]*/i;

function redactParams(message: unknown): unknown {
  return typeof message === "string" ? message.replace(PARAMS_TAIL, "\nparams: [redacted]") : message;
}

interface SerializedErr {
  type: string;
  message: unknown;
  stack?: string;
  code?: unknown;
  statusCode?: unknown;
  cause?: { type: string; message: unknown };
}

export function safeErrSerializer(err: unknown): SerializedErr {
  const e = (err ?? {}) as {
    name?: string;
    message?: unknown;
    stack?: string;
    code?: unknown;
    statusCode?: unknown;
    cause?: { name?: string; message?: unknown };
  };
  const out: SerializedErr = {
    type: e.name ?? "Error",
    message: redactParams(e.message),
    stack: e.stack,
    code: e.code,
    statusCode: e.statusCode,
  };
  if (e.cause && typeof e.cause === "object") {
    out.cause = { type: e.cause.name ?? "Error", message: redactParams(e.cause.message) };
  }
  return out;
}
