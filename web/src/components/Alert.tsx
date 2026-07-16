// Tiny presentational helper for query-string-driven error/success messages.
export function Alert({
  kind,
  children,
}: {
  kind: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`}>{children}</div>;
}
