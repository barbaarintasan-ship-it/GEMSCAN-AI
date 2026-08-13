import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useAuth } from "../lib/auth";

type QueueRow = {
  id: string;
  name: string | null;
  collected_at: string;
  status: string;
  ai_confidence: number | null;
  geologist_confidence: number | null;
};

const STATUS_LABELS: Record<string, string> = {
  ai_completed: "Analysis ready", awaiting_review: "Awaiting review",
  needs_more_data: "Needs more data", verified: "Verified", rejected: "Rejected",
};
// Samples still needing a geologist (the active queue) vs. already-decided ones.
// Both are loaded and shown — a verified/rejected sample stays visible under
// "Reviewed" instead of vanishing from the console after a decision.
const QUEUE_STATUSES = ["ai_completed", "awaiting_review", "needs_more_data"];
const REVIEWED_STATUSES = ["verified", "rejected"];
const ALL_STATUSES = [...QUEUE_STATUSES, ...REVIEWED_STATUSES];

export function ReviewQueue() {
  const { signOut, role, isOwner, canVerify } = useAuth();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error } = await supabase.schema("enterprise").from("sample")
      .select("id,name,collected_at,status,ai_confidence,geologist_confidence")
      .in("status", ALL_STATUSES).is("deleted_at", null)
      .order("collected_at", { ascending: false }).limit(300);
    if (error) setError(error.message);
    else setRows((data ?? []) as QueueRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">LuulScan <span>Review Console</span></div>
        <div className="topbar-right">
          <span className="role-pill">{isOwner ? "Owner" : role ?? "reviewer"}{canVerify ? " · can verify" : ""}</span>
          <button className="btn ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="container">
        <div className="section-head">
          <h1>Review queue</h1>
          <button className="btn ghost" onClick={load}>Refresh</button>
        </div>

        {loading ? <p className="muted">Loading…</p>
          : error ? <div className="error">{error}</div>
          : (() => {
            const active = rows.filter((r) => QUEUE_STATUSES.includes(r.status));
            const reviewed = rows.filter((r) => REVIEWED_STATUSES.includes(r.status));
            const table = (list: QueueRow[], action: string) => (
              <table className="queue">
                <thead><tr><th>Sample</th><th>Collected</th><th>Status</th><th>Analysis</th><th>Geologist</th><th></th></tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="strong">{r.name ?? `Sample ${r.id.slice(0, 8)}`}</td>
                      <td className="muted">{new Date(r.collected_at).toLocaleString()}</td>
                      <td><span className={`status s-${r.status}`}>{STATUS_LABELS[r.status] ?? r.status}</span></td>
                      <td>{r.ai_confidence != null ? `${Math.round(r.ai_confidence)}%` : "—"}</td>
                      <td>{r.geologist_confidence != null ? `${Math.round(r.geologist_confidence)}%` : "—"}</td>
                      <td><Link className="btn small primary" to={`/review/${r.id}`}>{action}</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
            return (
              <>
                {active.length === 0 ? <p className="muted">No samples awaiting review.</p> : table(active, "Review →")}
                {reviewed.length > 0 && (
                  <>
                    <h2 className="queue-subhead">Reviewed ({reviewed.length})</h2>
                    {table(reviewed, "View →")}
                  </>
                )}
              </>
            );
          })()}
      </main>
    </div>
  );
}
