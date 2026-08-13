// Review Console — the Enterprise AI Report.
//
// TWO viewing modes:
//   SIMPLE MODE (default) — a 12-year-old can understand it. Seven visual sections:
//     what I think this is · confidence meter (+why) · why it matters · valuable
//     minerals (cards) · what I'd look for next · exploration potential (stars) ·
//     final advice. Reads like a senior field geologist teaching a friend.
//   EXPERT MODE — everything technical, nothing removed: conclusions, evidence graph
//     with epistemic status, confidence computation, deposit model, satellite map,
//     field context, and the per-conclusion review controls.
// The geologist's decision panel (verify / needs more / reject / draft) is always
// available. Reviews submit through the deployed `review-sample` Edge Function, which
// records the review WITHOUT overwriting the AI's output.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { cellToLatLng } from "h3-js";
import { supabase, callFunction } from "../lib/supabase";
import { useAuth } from "../lib/auth";

// ── Types ────────────────────────────────────────────────────────────────────
type Media = { id: string; role: string; storage_path: string };
type Area = { name: string | null; region: string | null; district: string | null };
type SampleDetail = {
  id: string; name: string | null; collected_at: string; status: string; collector_id: string | null;
  ai_confidence: number | null; geologist_confidence: number | null; field_observations: string | null;
  area_id: string | null;
  sample_location: { altitude_m: number | null; gps_accuracy_m: number | null; h3_cell: string; provenance: string }[];
  sample_media: Media[];
  rock_observation: { rock_class: string | null; texture: string | null; notes: string | null }[];
  mineral_observation: { mineral: string; confidence: number | null }[];
};
type Conclusion = {
  id: string; kind: string; statement: string; statement_so: string | null;
  is_interpretation: boolean; confidence: number | null;
  review_state: string | null; corrected_statement: string | null; review_note: string | null;
};
type Evidence = { id: string; source: string; ev_type: string; statement: string; is_observation: boolean; tier: string | null; quality: number | null };
type Edge = { conclusion_id: string; evidence_id: string; polarity: string };
type Bi = { en: string; so: string };
type Assessment = {
  id: string; overall_confidence: number | null; status: string; created_at: string;
  report: {
    headline?: Bi; simpleSummary?: Bi; opportunity?: "high" | "moderate" | "low" | "none";
    interpretation?: { whatItIs?: Bi; commonlyHosts?: Bi; lookForNext?: Bi; whyItMatters?: Bi; environment?: Bi };
    uncertainties?: Bi[]; missingInformation?: Bi[]; recommendations?: { action: string; scaleM?: number; flagged?: boolean }[];
  } | null;
  assessment_conclusion: Conclusion[];
  assessment_evidence: Evidence[];
  assessment_edge: Edge[];
};
type DraftReview = { id: string; geologist_confidence: number | null; corrected_interpretation: string | null; review_notes: string | null; recommendation: string | null };
type ConclState = { state: "pending" | "confirmed" | "corrected" | "rejected"; corrected: string; note: string };
type Decision = "verify" | "needs_more_data" | "reject" | "draft";
type MineralCard = { name: string; importance: string; kind: "commodity" | "indicator"; critical?: boolean };

// ── Small visual helpers ─────────────────────────────────────────────────────
function band(pct: number): { label: string; color: string } {
  if (pct >= 70) return { label: "High", color: "#2e7d32" };
  if (pct >= 40) return { label: "Moderate", color: "#c9a227" };
  if (pct >= 20) return { label: "Low", color: "#d98324" };
  return { label: "Very low", color: "#e4685d" };
}
function Stars({ n }: { n: number }) {
  return <span className="stars">{[1, 2, 3, 4, 5].map((i) => <span key={i} className={i <= n ? "star on" : "star"}>★</span>)}</span>;
}
const confStars = (pct: number) => Math.max(1, Math.min(5, Math.round(pct / 20)));
const OPP_STARS: Record<string, { stars: number; label: string; color: string }> = {
  high: { stars: 5, label: "Very High", color: "#2e7d32" },
  moderate: { stars: 3, label: "Moderate", color: "#c9a227" },
  low: { stars: 2, label: "Low", color: "#d98324" },
  none: { stars: 1, label: "Unclear", color: "#8a8a8e" },
};
// Confidence bar used in Expert mode (per-conclusion + overall).
function ConfidenceBar({ pct, big }: { pct: number | null; big?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(pct ?? 0)));
  const b = band(v);
  return (
    <div className={`confbar ${big ? "confbar-big" : ""}`}>
      <div className="confbar-scale"><span>Low</span><span>High</span></div>
      <div className="confbar-track"><div className="confbar-fill" style={{ width: `${v}%`, background: b.color }} /></div>
      <div className="confbar-foot"><span className="confbar-band" style={{ color: b.color }}>{b.label}</span><span className="confbar-pct">{v}%</span></div>
    </div>
  );
}
function epiOf(e: { tier: string | null; is_observation: boolean }): "observed" | "inferred" | "possible" {
  if (e.tier === "knowledge_kb") return "possible";
  if (e.is_observation) return "observed";
  return "inferred";
}
function titleCase(s: string): string { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }
// Bilingual block — every result shows English AND simple Somali.
function BiText({ v, className, lead }: { v?: Bi; className?: string; lead?: boolean }) {
  if (!v?.en && !v?.so) return null;
  return (
    <>
      {v?.en && <p className={className}>{v.en}</p>}
      {v?.so && v.so !== v.en && <p className={`so-line${lead ? " so-lead" : ""}`}>{v.so}</p>}
    </>
  );
}
const KIND_LABELS: Record<string, string> = {
  rock_type: "Rock type", mineralization: "Mineralization", ore_mineral: "Ore minerals",
  gangue_mineral: "Gangue minerals", environment: "Geological environment",
  deposit_model: "Deposit model", exploration_significance: "Exploration significance",
};

export function ReviewSample() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session, canVerify } = useAuth();

  const [sample, setSample] = useState<SampleDetail | null>(null);
  const [area, setArea] = useState<Area | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [mineralCards, setMineralCards] = useState<MineralCard[]>([]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [conclStates, setConclStates] = useState<Record<string, ConclState>>({});
  const [gConf, setGConf] = useState("");
  const [correctedInterp, setCorrectedInterp] = useState("");
  const [notes, setNotes] = useState("");
  const [recommendation, setRecommendation] = useState("");

  const [mode, setMode] = useState<"simple" | "expert">("simple");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; role: string } | null>(null);

  const conclRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const decisionRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true); setError(null); setOkMsg(null);
    try {
      const { data: s, error: sErr } = await supabase.schema("enterprise").from("sample")
        .select("id,name,collected_at,status,collector_id,ai_confidence,geologist_confidence,field_observations,area_id," +
          "sample_location(altitude_m,gps_accuracy_m,h3_cell,provenance),sample_media(id,role,storage_path)," +
          "rock_observation(rock_class,texture,notes),mineral_observation(mineral,confidence)")
        .eq("id", id).is("deleted_at", null).maybeSingle();
      if (sErr) throw new Error(sErr.message);
      if (!s) throw new Error("Sample not found or not visible to your role.");
      const sd = s as unknown as SampleDetail;
      setSample(sd);

      if (sd.area_id) {
        const { data: ar } = await supabase.schema("enterprise").from("exploration_area").select("name,region,district").eq("id", sd.area_id).maybeSingle();
        setArea((ar as unknown as Area) ?? null);
      }

      const { data: a } = await supabase.schema("geo").from("geological_assessment")
        .select("id,overall_confidence,status,report,created_at," +
          "assessment_conclusion(id,kind,statement,statement_so,is_interpretation,confidence,review_state,corrected_statement,review_note)," +
          "assessment_evidence(id,source,ev_type,statement,is_observation,tier,quality)," +
          "assessment_edge(conclusion_id,evidence_id,polarity)")
        .eq("sample_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
      const asmt = (a as unknown as Assessment) ?? null;
      setAssessment(asmt);

      // Valuable minerals commonly associated (Simple §4) — live from the geology KB
      // for the sample's host rock. No backend change; the RPCs are readable by reviewers.
      const rockClass = sd.rock_observation?.[0]?.rock_class;
      if (rockClass) {
        const { data: rules } = await supabase.schema("geo").rpc("knowledge_rules_for", { p_host_rocks: [rockClass], p_lithology: [], p_deposit_types: [] });
        const rs = (rules ?? []) as { commodity_code: string | null; expected_minerals: string[] | null }[];
        const codes = [...new Set(rs.map((r) => r.commodity_code).filter((c): c is string => !!c))];
        const { data: profs } = codes.length ? await supabase.schema("geo").rpc("commodity_profiles", { p_codes: codes }) : { data: [] };
        const profByCode = new Map(((profs ?? []) as { code: string; name: string; strategic_importance: string | null; is_critical_mineral: boolean }[]).map((p) => [p.code, p]));
        const cards: MineralCard[] = [];
        const seen = new Set<string>();
        for (const code of codes) {
          const p = profByCode.get(code); if (!p) continue;
          cards.push({ name: p.name, importance: p.strategic_importance ?? "", kind: "commodity", critical: p.is_critical_mineral });
          seen.add(p.name.toLowerCase());
        }
        for (const m of [...new Set(rs.flatMap((r) => r.expected_minerals ?? []))]) {
          if (seen.has(m.toLowerCase())) continue;
          seen.add(m.toLowerCase());
          cards.push({ name: titleCase(m), importance: `An indicator mineral geologists look for to trace ${rockClass.toLowerCase()} systems.`, kind: "indicator" });
        }
        setMineralCards(cards);
      }

      const seed: Record<string, ConclState> = {};
      for (const c of (asmt?.assessment_conclusion ?? [])) {
        const st = (c.review_state as ConclState["state"]) ?? "pending";
        seed[c.id] = { state: ["pending", "confirmed", "corrected", "rejected"].includes(st) ? st : "pending", corrected: c.corrected_statement ?? "", note: c.review_note ?? "" };
      }
      setConclStates(seed);

      const { data: d } = await supabase.schema("enterprise").from("sample_review")
        .select("id,geologist_confidence,corrected_interpretation,review_notes,recommendation")
        .eq("sample_id", id).eq("reviewer_id", session?.user.id ?? "").eq("status", "draft")
        .order("round_no", { ascending: false }).limit(1).maybeSingle();
      const draft = d as DraftReview | null;
      if (draft) {
        setGConf(draft.geologist_confidence != null ? String(Math.round(draft.geologist_confidence)) : "");
        setCorrectedInterp(draft.corrected_interpretation ?? "");
        setNotes(draft.review_notes ?? ""); setRecommendation(draft.recommendation ?? "");
      }

      const map: Record<string, string> = {};
      for (const m of (sd.sample_media ?? [])) {
        const { data: signed } = await supabase.storage.from("scan-images").createSignedUrl(m.storage_path, 3600);
        if (signed?.signedUrl) map[m.id] = signed.signedUrl;
      }
      setPhotos(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the sample.");
    } finally {
      setLoading(false);
    }
  }, [id, session?.user.id]);

  useEffect(() => { load(); }, [load]);

  const evByConclusion = useMemo(() => {
    const byId = new Map((assessment?.assessment_evidence ?? []).map((e) => [e.id, e]));
    const group = (cid: string, pol: string) => (assessment?.assessment_edge ?? [])
      .filter((e) => e.conclusion_id === cid && e.polarity === pol)
      .map((e) => byId.get(e.evidence_id)).filter((e): e is Evidence => !!e);
    return { support: (cid: string) => group(cid, "supporting"), contra: (cid: string) => group(cid, "contradicting") };
  }, [assessment]);

  const setConcl = (cid: string, patch: Partial<ConclState>) => setConclStates((cur) => ({ ...cur, [cid]: { ...cur[cid], ...patch } }));
  const confirmAndAdvance = (cid: string) => {
    setConcl(cid, { state: conclStates[cid]?.state === "confirmed" ? "pending" : "confirmed" });
    const list = assessment?.assessment_conclusion ?? [];
    const i = list.findIndex((c) => c.id === cid);
    const nextEl = i >= 0 && i < list.length - 1 ? conclRefs.current[list[i + 1].id] : decisionRef.current;
    setTimeout(() => nextEl?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  };

  const submit = useCallback(async (decision: Decision) => {
    if (!sample) return;
    const binding = decision !== "draft";
    const confNum = gConf.trim() === "" ? undefined : Number(gConf);
    if (binding) {
      if (confNum == null || Number.isNaN(confNum) || confNum < 0 || confNum > 100) {
        setError("Enter your geologist confidence (0–100) before a binding decision.");
        decisionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); return;
      }
      const label = decision === "verify" ? "VERIFY" : decision === "reject" ? "REJECT" : "request MORE DATA for";
      if (!confirm(`Are you sure you want to ${label} this sample? This is recorded and notifies the collector.`)) return;
    }
    setBusy(decision); setError(null); setOkMsg(null);
    try {
      const conclusions = Object.entries(conclStates).map(([conclusion_id, v]) => ({
        conclusion_id, state: v.state, corrected_statement: v.state === "corrected" ? v.corrected.trim() : "", note: v.note.trim(),
      }));
      const res = await callFunction("review-sample", {
        sample_id: sample.id, decision, geologist_confidence: confNum,
        corrected_interpretation: correctedInterp.trim() || undefined, review_notes: notes.trim() || undefined,
        recommendation: recommendation.trim() || undefined, conclusions,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.detail || body?.error || `Submit failed (${res.status})`);
      if (decision === "draft") { setOkMsg("Draft saved."); await load(); } else navigate("/", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed.");
    } finally { setBusy(null); }
  }, [sample, gConf, conclStates, correctedInterp, notes, recommendation, navigate, load]);

  const loc = sample?.sample_location?.[0];
  const rock = sample?.rock_observation?.[0];
  const isOwnSample = sample?.collector_id && sample.collector_id === session?.user.id;
  const locationText = [area?.region, area?.district].filter(Boolean).join(", ") || loc?.h3_cell || "—";

  // Derived Simple-mode content
  const rep = assessment?.report;
  const pct = Math.max(0, Math.min(100, Math.round(assessment?.overall_confidence ?? 0)));
  const cband = band(pct);
  const opp = OPP_STARS[rep?.opportunity ?? "none"];
  const topRock = assessment?.assessment_conclusion.find((c) => c.kind === "rock_type");
  const whatIsIt = rep?.headline?.en || topRock?.statement || "Analysis in progress.";
  const supports = (assessment?.assessment_evidence ?? []).filter((e) => e.is_observation).slice(0, 4).map((e) => e.statement);
  const limits = [...(rep?.uncertainties ?? []).map((u) => u.en), ...(rep?.missingInformation ?? []).map((m) => m.en)].filter(Boolean).slice(0, 3);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">LuulScan <span>Review Console</span></div>
        <Link className="btn ghost" to="/">← Queue</Link>
      </header>

      <main className="container review">
        {loading ? <p className="muted">Loading…</p> : !sample ? <div className="error">{error ?? "Not found."}</div> : (
          <>
            <div className="section-head">
              <h1 className="review-title">{sample.name ?? `Sample ${sample.id.slice(0, 8)}`}</h1>
              <span className={`status s-${sample.status}`}>{sample.status.replace(/_/g, " ")}</span>
            </div>
            <p className="reviewer-line">
              Submitted by <strong>{isOwnSample ? (session?.user?.email ?? "you") : `collector ${(sample.collector_id ?? "").slice(0, 8)}`}</strong>
              {" · "}{locationText}{area?.name ? ` · ${area.name}` : ""}{" · "}{new Date(sample.collected_at).toLocaleDateString()}
            </p>

            {/* Photos (both modes) */}
            {sample.sample_media.length > 0 && (
              <div className="photo-strip">
                {sample.sample_media.map((m) => (
                  <button key={m.id} className="photo-lg" onClick={() => photos[m.id] && setLightbox({ url: photos[m.id], role: m.role })}>
                    {photos[m.id] ? <img src={photos[m.id]} alt={m.role} /> : <div className="photo-ph">…</div>}
                    <span className="photo-role">{m.role.replace(/_/g, " ")}</span>
                  </button>
                ))}
              </div>
            )}

            {error && <div className="error">{error}</div>}
            {okMsg && <div className="ok">{okMsg}</div>}

            {/* Mode toggle */}
            <div className="mode-tabs">
              <button className={`mode-tab ${mode === "simple" ? "on" : ""}`} onClick={() => setMode("simple")}>📖 Simple report</button>
              <button className={`mode-tab ${mode === "expert" ? "on" : ""}`} onClick={() => setMode("expert")}>🔬 Expert analysis</button>
            </div>

            {!assessment ? (
              <div className="card"><p className="muted">No analysis yet. Re-analyze the sample to generate the report.</p></div>
            ) : mode === "simple" ? (
              /* ══════════════ SIMPLE MODE ══════════════ */
              <div className="simple-report">
                <section className="rep-sec">
                  <div className="rep-h"><span className="rep-ic">🔎</span> What I think this is</div>
                  {rep?.headline?.en || rep?.headline?.so ? <BiText v={rep.headline} className="rep-lead" lead /> : <p className="rep-lead">{whatIsIt}</p>}
                </section>

                <section className="rep-sec">
                  <div className="rep-h"><span className="rep-ic">🎯</span> How confident I am (identification)</div>
                  <div className="meter">
                    <div className="meter-bar"><div className="meter-fill" style={{ width: `${pct}%`, background: cband.color }} /></div>
                    <div className="meter-side"><Stars n={confStars(pct)} /><span className="meter-pct" style={{ color: cband.color }}>{pct}%</span></div>
                  </div>
                  {supports.length > 0 && (
                    <div className="why why-up"><div className="why-h">Higher because</div>{supports.map((s, i) => <div key={i} className="why-item">✓ {s}</div>)}</div>
                  )}
                  {limits.length > 0 && (
                    <div className="why why-down"><div className="why-h">Lower because</div>{limits.map((s, i) => <div key={i} className="why-item">• {s}</div>)}</div>
                  )}
                </section>

                {(rep?.interpretation?.whyItMatters?.en || rep?.interpretation?.whyItMatters?.so) && (
                  <section className="rep-sec"><div className="rep-h"><span className="rep-ic">💡</span> Why this matters</div><BiText v={rep!.interpretation!.whyItMatters} /></section>
                )}

                {mineralCards.length > 0 && (
                  <section className="rep-sec">
                    <div className="rep-h"><span className="rep-ic">💎</span> Valuable minerals commonly associated</div>
                    <div className="min-grid">
                      {mineralCards.map((c) => (
                        <div key={c.name} className={`min-card min-${c.kind}`}>
                          <div className="min-name">{c.name}{c.critical && <span className="crit">critical</span>}</div>
                          <div className="min-imp">{c.importance}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className="rep-sec">
                  <div className="rep-h"><span className="rep-ic">🧭</span> What I'd look for next</div>
                  <BiText v={rep?.interpretation?.lookForNext} />
                  {(rep?.recommendations?.length ?? 0) > 0 && (
                    <ul className="rep-list">{rep!.recommendations!.map((r, i) => <li key={i}>{r.action}{r.scaleM ? ` (within ${r.scaleM} m)` : ""}</li>)}</ul>
                  )}
                </section>

                <section className="rep-sec">
                  <div className="rep-h"><span className="rep-ic">⛏️</span> Exploration potential</div>
                  <div className="pot-line"><Stars n={opp.stars} /><span className="pot-label" style={{ color: opp.color }}>{opp.label}</span></div>
                  <p className="rep-note">This is separate from how sure we are what the rock is — it describes how valuable the setting could be.</p>
                  <BiText v={rep?.interpretation?.environment} />
                </section>

                {(rep?.simpleSummary?.en || rep?.simpleSummary?.so) && (
                  <section className="rep-sec rep-advice"><div className="rep-h"><span className="rep-ic">🗒️</span> Final advice</div><BiText v={rep!.simpleSummary} /></section>
                )}
              </div>
            ) : (
              /* ══════════════ EXPERT MODE ══════════════ */
              <div className="expert-report">
                {loc?.h3_cell && <SatelliteMap h3={loc.h3_cell} geology={(assessment.assessment_evidence ?? []).filter((e) => e.ev_type === "spatial")} />}

                <div className="card">
                  <h2>Geological analysis</h2>
                  {(rep?.headline?.en || rep?.headline?.so) && <div className="headline"><div className="headline-text">{rep!.headline!.en}</div>{rep!.headline!.so && rep!.headline!.so !== rep!.headline!.en && <div className="headline-so">{rep!.headline!.so}</div>}</div>}
                  <div className="metric-row">
                    <div className="metric"><span className="conf-caption">Identification confidence</span><ConfidenceBar pct={assessment.overall_confidence} big /></div>
                    <div className="metric"><span className="conf-caption">Exploration potential</span>
                      <div className="pot" style={{ color: opp.color, borderColor: opp.color }}>{opp.label}</div>
                    </div>
                  </div>
                  {rep?.interpretation && (
                    <div className="interp">
                      {([["What it is", rep.interpretation.whatItIs], ["Commonly hosts", rep.interpretation.commonlyHosts], ["What to look for next", rep.interpretation.lookForNext], ["Why it matters", rep.interpretation.whyItMatters], ["Geological environment", rep.interpretation.environment]] as [string, Bi | undefined][])
                        .filter(([, v]) => v?.en || v?.so).map(([label, v]) => <div key={label} className="interp-item"><div className="interp-label">{label}</div><BiText v={v} /></div>)}
                    </div>
                  )}
                  <p className="muted small">Generated {new Date(assessment.created_at).toLocaleString()} · confidence is computed deterministically from the evidence graph below.</p>

                  {assessment.assessment_conclusion.map((c) => {
                    const st = conclStates[c.id] ?? { state: "pending", corrected: "", note: "" };
                    const support = evByConclusion.support(c.id);
                    const contra = evByConclusion.contra(c.id);
                    return (
                      <div key={c.id} ref={(el) => { conclRefs.current[c.id] = el; }} className={`concl concl-${st.state}`}>
                        <div className="concl-head"><span className="concl-kind">{KIND_LABELS[c.kind] ?? c.kind}</span></div>
                        <p className="concl-text">{c.statement}</p>
                        <ConfidenceBar pct={c.confidence} />
                        <span className="tag">{c.is_interpretation ? "interpretation" : "observation"}</span>
                        {support.length > 0 && (
                          <div className="ev-block"><div className="ev-label ev-support">Supporting evidence</div>
                            {support.map((e) => <div key={e.id} className="ev-item"><span className={`epi epi-${epiOf(e)}`}>{epiOf(e)}</span> {e.statement} <span className="ev-src">({e.ev_type})</span></div>)}
                          </div>
                        )}
                        {contra.length > 0 && (
                          <div className="ev-block"><div className="ev-label ev-contra">Contradicting</div>
                            {contra.map((e) => <div key={e.id} className="ev-item">• {e.statement}</div>)}
                          </div>
                        )}
                        <div className="concl-actions">
                          <button type="button" className={`chip ${st.state === "confirmed" ? "chip-on chip-confirmed" : ""}`} onClick={() => confirmAndAdvance(c.id)}>Confirm →</button>
                          <button type="button" className={`chip ${st.state === "corrected" ? "chip-on chip-corrected" : ""}`} onClick={() => setConcl(c.id, { state: st.state === "corrected" ? "pending" : "corrected" })}>Correct</button>
                          <button type="button" className={`chip ${st.state === "rejected" ? "chip-on chip-rejected" : ""}`} onClick={() => setConcl(c.id, { state: st.state === "rejected" ? "pending" : "rejected" })}>Reject</button>
                        </div>
                        {st.state === "corrected" && <input className="input" placeholder="Corrected interpretation for this conclusion" value={st.corrected} onChange={(e) => setConcl(c.id, { corrected: e.target.value })} />}
                        {st.state !== "pending" && <input className="input" placeholder="Note (optional)" value={st.note} onChange={(e) => setConcl(c.id, { note: e.target.value })} />}
                      </div>
                    );
                  })}

                  {(rep?.uncertainties?.length ?? 0) > 0 && (
                    <div className="ai-extra"><div className="ev-label">Uncertainties</div>{rep!.uncertainties!.map((u, i) => <div key={i} className="ev-item">• {u.en}</div>)}</div>
                  )}
                </div>

                <div className="card">
                  <h2>Field context</h2>
                  {loc && (
                    <ul className="kv">
                      <li><span>Location cell</span><b>{loc.h3_cell}</b></li>
                      {loc.gps_accuracy_m != null && <li><span>GPS accuracy</span><b>±{loc.gps_accuracy_m} m</b></li>}
                      {loc.altitude_m != null && <li><span>Altitude</span><b>{loc.altitude_m} m</b></li>}
                    </ul>
                  )}
                  {rock?.rock_class && <p><strong>Host rock:</strong> {rock.rock_class}{rock.notes ? ` — ${rock.notes}` : ""}</p>}
                  {sample.mineral_observation.length > 0 && <p><strong>Minerals:</strong> {sample.mineral_observation.map((m) => m.mineral).join(", ")}</p>}
                  {sample.field_observations && <p><strong>Field notes:</strong> {sample.field_observations}</p>}
                </div>
              </div>
            )}

            {/* Decision panel (always) */}
            <div className="card decision" ref={decisionRef}>
              <h2>Your review</h2>
              <label className="field"><span>Geologist confidence (0–100)</span>
                <input className="input" inputMode="numeric" value={gConf} onChange={(e) => setGConf(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} placeholder="e.g. 80" /></label>
              <label className="field"><span>Corrected overall interpretation (optional)</span>
                <textarea className="input" rows={2} value={correctedInterp} onChange={(e) => setCorrectedInterp(e.target.value)} /></label>
              <label className="field"><span>Review notes (optional)</span>
                <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
              <label className="field"><span>Recommendation (optional)</span>
                <textarea className="input" rows={2} value={recommendation} onChange={(e) => setRecommendation(e.target.value)} /></label>
              <div className="decision-bar">
                <button className="btn primary" disabled={!canVerify || busy != null} onClick={() => submit("verify")} title={canVerify ? "" : "Requires senior/chief geologist"}>{busy === "verify" ? "…" : "Verify"}</button>
                <button className="btn warn" disabled={busy != null} onClick={() => submit("needs_more_data")}>{busy === "needs_more_data" ? "…" : "Needs More Data"}</button>
                <button className="btn danger" disabled={busy != null} onClick={() => submit("reject")}>{busy === "reject" ? "…" : "Reject"}</button>
                <button className="btn ghost" disabled={busy != null} onClick={() => submit("draft")}>{busy === "draft" ? "…" : "Save Draft"}</button>
              </div>
              {!canVerify && <p className="muted small">Verify requires a senior/chief geologist. You can still correct, request more data, reject, or save a draft.</p>}
            </div>
          </>
        )}
      </main>

      {lightbox && <Lightbox url={lightbox.url} role={lightbox.role} onClose={() => setLightbox(null)} />}
    </div>
  );
}

// ── Satellite map (Expert mode) ──────────────────────────────────────────────
function SatelliteMap({ h3, geology }: { h3: string; geology: Evidence[] }) {
  let center: [number, number] | null = null;
  try { center = cellToLatLng(h3); } catch { center = null; }
  if (!center) return null;
  const [lat, lng] = center;
  const latD = 0.004, lngD = 0.004 / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const bbox = `${lng - lngD},${lat - latD},${lng + lngD},${lat + latD}`;
  const img = `https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=680,420&format=jpg&f=image`;
  const maps = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  return (
    <div className="card">
      <h2>Location — satellite</h2>
      <div className="satwrap"><img className="satimg" src={img} alt="Satellite view of the sample location" loading="lazy" /><div className="satpin" /></div>
      <div className="satfoot"><span className="muted small">{lat.toFixed(5)}, {lng.toFixed(5)}</span><a className="btn small ghost" href={maps} target="_blank" rel="noreferrer">Open in Maps ↗</a></div>
      {geology.length > 0 && <div className="ai-extra"><div className="ev-label">Mapped geology at this location</div>{geology.map((e) => <div key={e.id} className="ev-item">• {e.statement}</div>)}</div>}
    </div>
  );
}

// ── Zoomable photo lightbox ──────────────────────────────────────────────────
function Lightbox({ url, role, onClose }: { url: string; role: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const clampScale = (s: number) => Math.max(1, Math.min(6, s));
  const zoomBy = (f: number) => setScale((s) => { const n = clampScale(s * f); if (n === 1) setPan({ x: 0, y: 0 }); return n; });
  const reset = () => { setScale(1); setPan({ x: 0, y: 0 }); };
  return (
    <div className="lb-backdrop" onClick={onClose}>
      <div className="lb-body" onClick={(e) => e.stopPropagation()}
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
        onMouseDown={(e) => { if (scale > 1) drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }; }}
        onMouseMove={(e) => { if (drag.current) setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }}
        onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
        <img src={url} alt={role} draggable={false} onDoubleClick={reset} onClick={() => scale === 1 && zoomBy(2.2)}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, cursor: scale > 1 ? "grab" : "zoom-in" }} />
      </div>
      <div className="lb-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lb-role">{role.replace(/_/g, " ")}</span>
        <div className="lb-btns">
          <button className="lb-btn" onClick={() => zoomBy(1 / 1.3)}>−</button>
          <span className="lb-scale">{Math.round(scale * 100)}%</span>
          <button className="lb-btn" onClick={() => zoomBy(1.3)}>+</button>
          <button className="lb-btn" onClick={reset}>Reset</button>
          <a className="lb-btn" href={url} target="_blank" rel="noreferrer">Open</a>
          <button className="lb-btn lb-close" onClick={onClose}>✕</button>
        </div>
      </div>
    </div>
  );
}
