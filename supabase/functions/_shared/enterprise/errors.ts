// Enterprise middleware — TYPED ERRORS + JSON responses.
//
// Handlers throw these; the outer request wrapper calls errorResponse() to turn
// any thrown value into a safe JSON Response. Known EnterpriseErrors keep their
// status + machine code; anything unexpected becomes an opaque 500 so internal
// details are never leaked to the caller.
import { corsHeaders } from "../cors.ts";

export class EnterpriseError extends Error {
  constructor(readonly status: number, message: string, readonly code: string) {
    super(message);
    this.name = "EnterpriseError";
  }
}

export class UnauthorizedError extends EnterpriseError {
  constructor(message = "unauthorized") { super(401, message, "unauthorized"); }
}
export class ForbiddenError extends EnterpriseError {
  constructor(message = "forbidden") { super(403, message, "forbidden"); }
}
export class BadRequestError extends EnterpriseError {
  constructor(message = "bad request") { super(400, message, "bad_request"); }
}
export class NotFoundError extends EnterpriseError {
  constructor(message = "not found") { super(404, message, "not_found"); }
}
export class ConflictError extends EnterpriseError {
  constructor(message = "conflict") { super(409, message, "conflict"); }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof EnterpriseError) {
    return json({ error: err.message, code: err.code }, err.status);
  }
  // Unknown/unexpected: log server-side, and (owner beta) surface the message as
  // `detail` so the field tester can report the real cause instead of "internal error".
  const detail = (err as Error)?.message ?? String(err);
  console.error(JSON.stringify({ level: "error", scope: "enterprise", message: detail }));
  return json({ error: "internal error", code: "internal", detail }, 500);
}
