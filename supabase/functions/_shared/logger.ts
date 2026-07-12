// Structured backend logging foundation for Edge Functions.
//
// Supabase already aggregates anything written to stdout/stderr into its
// per-function log viewer once a project is linked and functions are
// deployed — there is no separate log shipping to wire up. What was
// actually missing (confirmed by grep: only one bare `console.error` existed
// across all 5 functions, and 4 of the 5 error paths logged nothing at all)
// was a *consistent, greppable shape* for those log lines, so failures can
// be filtered/searched by function name or severity once real traffic
// exists. This is intentionally simple — no external log service, no extra
// dependency — matching the size of the actual gap.
export type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  functionName: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    function: functionName,
    message,
    ...(context ? { context } : {}),
  });

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// Convenience wrapper for the extremely common "caught an unhandled error at
// the top of a request handler" case, matching the shape every Edge
// Function's outer catch block already needs to build its 500 response.
export function logError(functionName: string, err: unknown, context?: Record<string, unknown>): void {
  log("error", functionName, err instanceof Error ? err.message : String(err), {
    ...(context ?? {}),
    stack: err instanceof Error ? err.stack : undefined,
  });
}
