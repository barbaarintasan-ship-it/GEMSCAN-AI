import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Login } from "./pages/Login";
import { ReviewQueue } from "./pages/ReviewQueue";
import { ReviewSample } from "./pages/ReviewSample";

export function App() {
  const { session, loading, canReview, signOut } = useAuth();

  if (loading) return <div className="center-screen"><p className="muted">Loading…</p></div>;
  if (!session) return <Login />;

  // Signed in but not a reviewer → this console is staff-only.
  if (!canReview) {
    return (
      <div className="center-screen">
        <div className="card auth-card">
          <div className="brand">LuulScan <span>Review Console</span></div>
          <div className="error">This account does not have a reviewer role. Contact an administrator.</div>
          <button className="btn ghost" onClick={signOut}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ReviewQueue />} />
        <Route path="/review/:id" element={<ReviewSample />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
