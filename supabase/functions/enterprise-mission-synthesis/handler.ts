// enterprise-mission-synthesis — Team Phase 7: cross-contributor cell synthesis.
//   POST /enterprise-mission-synthesis  { missionId, targetH3 }  generate + save + return
//   GET  /enterprise-mission-synthesis?missionId=&targetH3=      return the saved one, if any
//
// When a mission cell has been worked by more than one contributor, Claude
// reads across everyone's samples + structured evidence and narrates where
// they agree, conflict, or leave gaps — the judgment call a human lead would
// otherwise make by opening every sample individually.
//
// AI-safety firewall, same principle as Solo's own mission analysis
// (missionPrompt.ts): Claude only narrates. enterprise.cell_synthesis (0130)
// has no score/confidence column by design, the prompt explicitly forbids
// probability/score language, and any score-like key Claude still emits is
// stripped before it ever reaches the database. The authoritative number
// stays mission_assignment.prospectivity_score (Phase 3/8) — untouched here.
import { corsHeaders } from "../_shared/cors.ts";
import { BadRequestError, errorResponse, ForbiddenError, json, NotFoundError } from "../_shared/enterprise/errors.ts";
import { resolveActor as realResolveActor, type Actor } from "../_shared/enterprise/auth.ts";
import { serviceClient, userClient } from "../_shared/enterprise/clients.ts";
import { requireEnterprise as realRequireEnterprise } from "../_shared/enterprise/authz.ts";

const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";

const AGREEMENT_VALUES = ["consistent", "mixed", "conflicting", "insufficient_data"] as const;
type Agreement = (typeof AGREEMENT_VALUES)[number];

// Keys an LLM might slip in that would read as an authoritative number —
// rejected on sight rather than trusted to have followed the prompt's rules.
const FORBIDDEN_KEY_FRAGMENTS = [
  "score", "prospectivity", "probability", "percent", "confidence", "likelihood", "odds", "rating", "chance",
];

export interface SynthesisContext {
  mission_id: string;
  target_h3: string;
  deterministic_score: number | null;
  score_engine_version: string | null;
  contributor_count: number;
  sample_count: number;
  contributors: Array<Record<string, unknown>>;
}

export interface SynthesisResult {
  headline: string;
  headline_so: string;
  narrative: string;
  narrative_so: string;
  agreement: Agreement;
  discardedKeys: string[];
}

export function buildSynthesisPrompt(ctx: SynthesisContext): string {
  return `You are assisting a mineral-exploration team lead. Below is field evidence collected \
independently by ${ctx.contributor_count} different contributor(s) across ${ctx.sample_count} \
sample(s), all from the SAME map cell (H3 index ${ctx.target_h3}) inside one exploration mission. \
Each contributor did not see the others' submissions.

DATA (ground truth — ids, timestamps and structured fields are not in question):
${JSON.stringify(ctx.contributors, null, 2)}

RULES — read carefully:
1. NEVER state a probability, percentage, score, rating, chance, likelihood or odds of anything —
   not as a field, not inside your prose. This is not your job: a separate, deterministic model
   already computes this cell's prospectivity score from satellite and geological layers,
   independently of this synthesis. Do not mention, guess at, or imply a number for it.
2. Your ONLY job is to compare what the contributors reported: where their observations agree,
   where they conflict, and what a geologist would want to know before deciding whether to send
   someone back to re-check this cell.
3. If there is only one contributor, or too little data to meaningfully compare, say so plainly
   and set "agreement" to "insufficient_data" — do not invent a comparison that isn't there.
4. Write in clear, plain language. Provide BOTH an English version and a Somali translation for
   every text field (the _so twin) — natural Somali, not a literal word-for-word translation.

Respond with ONLY minified JSON, no markdown, matching exactly this shape:
{"headline": string (one sentence, English),
 "headline_so": string (Somali),
 "narrative": string (2-5 sentences comparing the contributors' evidence, English),
 "narrative_so": string (Somali),
 "agreement": "consistent" | "mixed" | "conflicting" | "insufficient_data"}`;
}

export function parseSynthesisResponse(text: string): SynthesisResult {
  const cleaned = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const discardedKeys: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (FORBIDDEN_KEY_FRAGMENTS.some((f) => key.toLowerCase().includes(f))) {
      discardedKeys.push(key);
      delete parsed[key];
    }
  }
  const agreementRaw = String(parsed.agreement ?? "insufficient_data");
  const agreement: Agreement = (AGREEMENT_VALUES as readonly string[]).includes(agreementRaw)
    ? (agreementRaw as Agreement)
    : "insufficient_data";
  return {
    headline: String(parsed.headline ?? "").slice(0, 500),
    headline_so: String(parsed.headline_so ?? "").slice(0, 500),
    narrative: String(parsed.narrative ?? "").slice(0, 4000),
    narrative_so: String(parsed.narrative_so ?? "").slice(0, 4000),
    agreement,
    discardedKeys,
  };
}

export interface Deps {
  resolveActor: (req: Request) => Promise<Actor>;
  requireEnterprise: (actor: Actor) => Promise<void>;
  getContext: (req: Request, missionId: string, targetH3: string) => Promise<SynthesisContext>;
  callClaude: (ctx: SynthesisContext) => Promise<SynthesisResult>;
  saveSynthesis: (req: Request, ctx: SynthesisContext, result: SynthesisResult) => Promise<{ id: string }>;
  getSaved: (req: Request, missionId: string, targetH3: string) => Promise<unknown | null>;
}

async function realGetContext(req: Request, missionId: string, targetH3: string): Promise<SynthesisContext> {
  const { data, error } = await userClient(req).rpc("get_cell_synthesis_context", {
    p_mission: missionId,
    p_target_h3: targetH3,
  });
  if (error) {
    if (/forbidden:/i.test(error.message)) throw new ForbiddenError(error.message.replace(/^.*forbidden:\s*/i, ""));
    throw new Error(`get_cell_synthesis_context: ${error.message}`);
  }
  return data as SynthesisContext;
}

async function realCallClaude(ctx: SynthesisContext): Promise<SynthesisResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 900,
      temperature: 0,
      messages: [{ role: "user", content: buildSynthesisPrompt(ctx) }],
    }),
  });
  const raw = await res.json();
  if (!res.ok) throw new Error(raw?.error?.message ?? `Claude API error (status ${res.status})`);
  const text = raw?.content?.[0]?.text ?? "";
  return parseSynthesisResponse(text);
}

async function realSaveSynthesis(req: Request, ctx: SynthesisContext, result: SynthesisResult): Promise<{ id: string }> {
  const { data, error } = await userClient(req).rpc("save_cell_synthesis", {
    p_mission: ctx.mission_id,
    p_target_h3: ctx.target_h3,
    p_contributor_count: ctx.contributor_count,
    p_sample_count: ctx.sample_count,
    p_agreement: result.agreement,
    p_headline: result.headline,
    p_headline_so: result.headline_so,
    p_narrative: result.narrative,
    p_narrative_so: result.narrative_so,
    p_model: CLAUDE_MODEL,
  });
  if (error) {
    if (/forbidden:/i.test(error.message)) throw new ForbiddenError(error.message.replace(/^.*forbidden:\s*/i, ""));
    if (/validation:/i.test(error.message)) throw new BadRequestError(error.message.replace(/^.*validation:\s*/i, ""));
    throw new Error(`save_cell_synthesis: ${error.message}`);
  }
  return { id: data as string };
}

async function realGetSaved(req: Request, missionId: string, targetH3: string): Promise<unknown | null> {
  const { data } = await userClient(req)
    .from("cell_synthesis")
    .select("id,contributor_count,sample_count,agreement,headline,headline_so,narrative,narrative_so,model,created_at")
    .eq("mission_id", missionId)
    .eq("target_h3", targetH3)
    .maybeSingle();
  return data ?? null;
}

export const defaultDeps: Deps = {
  resolveActor: realResolveActor,
  requireEnterprise: (a) => realRequireEnterprise(a, serviceClient()),
  getContext: realGetContext,
  callClaude: realCallClaude,
  saveSynthesis: realSaveSynthesis,
  getSaved: realGetSaved,
};

export async function handleMissionSynthesis(req: Request, deps: Deps = defaultDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const actor = await deps.resolveActor(req);
    await deps.requireEnterprise(actor);

    if (req.method === "GET") {
      const url = new URL(req.url);
      const missionId = url.searchParams.get("missionId");
      const targetH3 = url.searchParams.get("targetH3");
      if (!missionId || !targetH3) throw new BadRequestError("missionId and targetH3 query params are required");
      const saved = await deps.getSaved(req, missionId, targetH3);
      if (!saved) throw new NotFoundError("no synthesis has been generated for this cell yet");
      return json(saved);
    }

    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const missionId = typeof body.missionId === "string" ? body.missionId : null;
      const targetH3 = typeof body.targetH3 === "string" ? body.targetH3 : null;
      if (!missionId || !targetH3) throw new BadRequestError("missionId and targetH3 are required");

      const ctx = await deps.getContext(req, missionId, targetH3);
      if (ctx.sample_count === 0) throw new BadRequestError("no samples exist in this cell yet");

      const result = await deps.callClaude(ctx);
      const saved = await deps.saveSynthesis(req, ctx, result);
      return json({
        id: saved.id,
        contributor_count: ctx.contributor_count,
        sample_count: ctx.sample_count,
        agreement: result.agreement,
        headline: result.headline,
        headline_so: result.headline_so,
        narrative: result.narrative,
        narrative_so: result.narrative_so,
      }, 201);
    }

    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    return errorResponse(err);
  }
}
