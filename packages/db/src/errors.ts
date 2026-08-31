/** Domain error carrying an HTTP status + stable code, mapped by the API layer.
 *  `fields` optionally names the content fields a validation error refers to, so
 *  the admin can surface the message inline on those fields (not just in a toast)
 *  and an agent can see exactly which fields to fix. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: string[],
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * The Postgres SQLSTATE of a driver error, or null. drizzle-orm ≥0.44 wraps the
 * driver error in a DrizzleQueryError with the Postgres error as `cause`, so the
 * cause chain is walked (bounded). Lets a losing concurrent write become a
 * self-teaching 409 instead of an opaque 500.
 */
export function pgErrorCode(err: unknown, depth = 0): string | null {
  if (typeof err !== "object" || err === null || depth > 5) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  return pgErrorCode((err as { cause?: unknown }).cause, depth + 1);
}

export const PG_UNIQUE_VIOLATION = "23505";
export const PG_FOREIGN_KEY_VIOLATION = "23503";
export const PG_INVALID_TEXT_REPRESENTATION = "22P02";

export const Errors = {
  notFound: (what = "Resource") => new AppError(404, "not_found", `${what} not found`),
  forbidden: (msg = "Forbidden") => new AppError(403, "forbidden", msg),
  unauthorized: (msg = "Unauthorized") => new AppError(401, "unauthorized", msg),
  badRequest: (msg = "Bad request") => new AppError(400, "bad_request", msg),
  conflict: (msg = "Conflict") => new AppError(409, "conflict", msg),
  validation: (msg: string, fields?: string[]) => new AppError(422, "validation_error", msg, fields),
};
