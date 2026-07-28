import { Link, useParams } from "react-router-dom";

// Placeholder — the full review screen (photos │ AI evidence graph │ map │ decision)
// lands in S4. S3 delivers the queue + navigation.
export function ReviewSample() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">LuulScan <span>Review Console</span></div>
        <Link className="btn ghost" to="/">← Queue</Link>
      </header>
      <main className="container">
        <h1>Sample review</h1>
        <p className="muted">Sample <code>{id}</code></p>
        <div className="card">
          <p>The full review screen (photos, AI evidence graph, map, per-conclusion
            confirm/correct, geologist confidence, and Verify / Needs&nbsp;More&nbsp;Data /
            Reject / Save&nbsp;Draft) is built in S4 on top of the deployed
            <code> review-sample</code> endpoint.</p>
        </div>
      </main>
    </div>
  );
}
