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

export const Errors = {
  notFound: (what = "Resource") => new AppError(404, "not_found", `${what} not found`),
  forbidden: (msg = "Forbidden") => new AppError(403, "forbidden", msg),
  unauthorized: (msg = "Unauthorized") => new AppError(401, "unauthorized", msg),
  badRequest: (msg = "Bad request") => new AppError(400, "bad_request", msg),
  conflict: (msg = "Conflict") => new AppError(409, "conflict", msg),
  validation: (msg: string, fields?: string[]) => new AppError(422, "validation_error", msg, fields),
};
