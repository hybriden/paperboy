/** Domain error carrying an HTTP status + stable code, mapped by the API layer. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
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
  validation: (msg: string) => new AppError(422, "validation_error", msg),
};
