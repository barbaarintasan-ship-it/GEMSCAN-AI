# Geological Intelligence Engine (GIE) — Architecture v1

Sprint 4.3. The GIE turns a submitted sample into an **evidence-based geological
assessment** written the way an exploration geologist would reason — combining every
available dataset, not just the photos. It is a reasoning layer **on top of** the
existing GeoContext Engine; it does not replace it.

> Design status: **for review**. Like the GeoContext architecture (v1.0 → v1.1), this
> is meant to be approved / refined before implementation. Nothing here is built yet.

---

## 1. Principles (non-negotiable)

1. **Evidence over pixels.** The photos are one evidence stream among ~24. A conclusion
   is only as strong as the evidence graph behind it.
2. **Every conclusion is traceable.** No conclusion may exist without ≥1 edge to a
   concrete evidence node. This is enforced structurally (see §5), not by convention.
3. **Observations ≠ interpretations; facts ≠ hypotheses.** Each statement is tagged.
4. **Confidence is computed, never invented.** The AI proposes conclusions and links
   them to evidence; the **engine** computes the number deterministically from that
   evidence (§6). The model is never asked for a confidence score.
5. **Graceful degradation.** Missing datasets are skipped, not faked. Fewer sources →
   lower confidence, automatically.
6. **Conservative by default.** Recommendations stay at outcrop/sample scale (1–10 m)
   unless multiple independent datasets justify a larger target (§8).

---

## 2. Where it sits in the sample lifecycle

```
Submitted
   ↓  (analyze-sample fires automatically after submit_sample)
ai_processing → AI Geological Assessment (evidence graph + report + computed confidence)
   ↓
ai_completed → awaiting_review
   ↓  (geologist accepts / corrects in the future Desktop app)
verified  |  needs_more_data  |  rejected
   ↓  (verified assessments feed back)
GeoContext Knowledge Base  ──►  becomes evidence for future nearby assessments
```

Status values already exist (migration 0061). `ai_confidence` / `geologist_confidence`
columns already exist (0060) and are kept strictly separate — review never overwrites AI.

---

## 3. Runtime shape

A new Edge Function **`analyze-sample`** (user-JWT, enterprise-gated) orchestrates five
stages. It is idempotent per sample+input-hash so re-runs don't duplicate assessments.

```
analyze-sample(sample_id)
  1. GATHER    → assemble the Evidence Set from every available source (§4)
  2. VISION    → Gemini vision on the sample photos → visual evidence items
  3. REASON    → Gemini structured reasoning → conclusions linked to evidence ids (§7)
  4. SCORE     → engine computes per-conclusion + overall confidence (§6)
  5. PERSIST   → write geological_assessment + evidence graph; set ai_confidence;
                 status → ai_completed → awaiting_review; audit
```

Trigger: `submit_sample` enqueues analysis (status `ai_processing`); `analyze-sample`
runs it. (Mechanism — direct call vs. pg_net/queue — decided at build time; the contract
is "auto-starts after upload".)

---

## 4. The Evidence Set — 24 sources → gatherers

Each gatherer returns zero or more **evidence items** (`{id, source, type, statement,
tier, quality, provenance, temporal}`) and is allowed to return nothing. Grouped:

| Group | Sources | Gatherer |
|---|---|---|
| **Field (the sample)** | photos, GPS, elevation, host rock, alteration, structural readings, field observations, minerals observed | read from `enterprise.sample*` |
| **AI visual** | AI visual observations | Gemini vision (§ stage 2) — tagged tier `ai_visual` (low base weight) |
| **Spatial (GeoContext)** | geological maps, lithology, faults, shear zones, quartz veins, structural geology | `geo.geology_at` via GeoContext spatial provider |
| **Occurrences** | mineral occurrences, MRDS, historical mining records, geological surveys | `geo.occurrences_near` |
| **Knowledge base** | GeoContext Knowledge Base, regional geological history | `geo.knowledge_near` |
| **Associations** | mineral associations | `geo.associations_for_host_rocks` |
| **Prior samples** | previous verified samples, enterprise verified, community verified | `geo.community_near` + `enterprise.sample` (verified, nearby) |
| **Remote sensing** | remote sensing where available | optional provider; skipped until data loaded |

The GATHER stage simply calls `GeoContextEngine.run({lat,lng,hostRocks})` (which already
runs these providers in parallel, isolates failures, and returns `ProviderEvidence` with
datasets + tiers + confidence) and flattens its `EvidenceItem[]` into the Evidence Set,
then appends the field + visual items. **Unavailable providers contribute nothing and
lower overall confidence — no code change needed to "ignore" them.**

---

## 5. The Evidence Graph (the differentiator)

A directed, weighted, fully-traceable graph persisted with every assessment.

- **Evidence nodes** `E`: every gathered item. `{id, source, dataset_ref, type
  (field|visual|spatial|occurrence|knowledge|association|prior_sample), statement,
  is_observation (bool), tier, quality (0..1), provenance, temporal}`.
- **Conclusion nodes** `C`: each interpretation the engine emits — probable rock type,
  probable mineralization, ore minerals, gangue minerals, geological environment,
  deposit model, exploration significance. `{id, kind, statement, is_interpretation}`.
- **Edges** `C → E`: `{conclusion_id, evidence_id, polarity (supporting|contradicting),
  contribution (0..1)}`. Contribution is the AI's asserted *relevance*; the *weight* used
  for confidence is `contribution × tier_weight × quality` (engine-computed).

**Invariant:** persistence rejects any conclusion with zero supporting edges. This is
Principle #2 made structural — "no conclusion without traceable evidence."

The graph is returned to the app and stored, so the UI (and later the Desktop reviewer)
can show, for any conclusion, exactly which datasets drove it and how strongly.

---

## 6. Confidence — deterministic, from evidence

Per conclusion `c`, over its supporting evidence `S` and contradicting evidence `K`:

```
w(e)      = contribution(e) × tier_weight(e.tier) × e.quality        # effective weight
support   = 1 − Π(1 − w(e))   for e ∈ S     # noisy-OR: independent agreeing evidence adds
contradict= 1 − Π(1 − w(e))   for e ∈ K
base      = support × (1 − 0.5·contradict)
```

Then apply global modifiers (Principle #4 factors), each a bounded multiplier:

- **Agreement** across independent dataset groups (spatial vs occurrence vs knowledge
  vs prior-sample) → corroboration bonus; single-group evidence is capped.
- **Verification** — supporting evidence from *verified* prior samples / lab results
  gets a tier bonus (already reflected in tier weights).
- **Image quality** — mean `image_quality_score` scales visual-derived contributions.
- **Consistency** — if the AI flags internal contradiction, `base` is penalised.

`tier_weight` and the noisy-OR are **reused from `_shared/geocontext/confidence.ts`**
(`itemWeight`, `computeConfidence`) so the GIE and GeoContext agree on how evidence
becomes confidence. Overall `ai_confidence` = evidence-weighted mean of conclusion
confidences, in 0..100. Weak/sparse evidence ⇒ low number, automatically.

---

## 7. Reasoning contract (Gemini)

One structured call (model `GEMINI_MODEL`, reusing the consumer Gemini integration).
The prompt casts the model as an exploration geologist and **forbids** confidence
numbers. Input: the full Evidence Set (each item with a stable `id`) + sample field data.
Output: strict JSON validated against a schema:

```jsonc
{
  "conclusions": [
    { "id":"c1", "kind":"rock_type", "statement":"...", "is_interpretation":true,
      "supporting":[{"evidence_id":"e3","contribution":0.7}, ...],
      "contradicting":[{"evidence_id":"e9","contribution":0.4}] }
  ],
  "uncertainties": ["strike/dip not measured", "no lab assay"],
  "missing_information": ["fresh-surface photo", "vein width"],
  "recommendations": [
    { "action":"collect another sample ~2 m along the vein", "scale_m":2,
      "evidence_ids":["e3","e5"] }
  ]
}
```

The engine then: validates every `evidence_id` exists, drops any conclusion with no
valid supporting evidence, computes confidence (§6), and assembles the report (§ below).
Recommendations with `scale_m > 10` are **down-weighted/flagged** unless backed by ≥2
independent dataset groups (§8). The model proposes; the engine adjudicates.

---

## 8. Report & recommendations

**Report** (assembled, evidence-linked): probable rock type · probable mineralization ·
possible ore minerals · possible gangue minerals · likely geological environment ·
possible deposit model · exploration significance — each with its supporting AND
contradicting evidence and a computed confidence — plus remaining uncertainties and
missing information.

**Recommendations policy:** default conservative (document outcrop, collect nearby 1–10 m,
expose fresh surface, measure vein orientation, record structure, inspect alteration,
photograph angles). Larger targets (20/50/100 m+) are surfaced only when supported by
multiple independent datasets (mapped structures + verified occurrences + agreeing KB).

---

## 9. Data model (new — `geo` schema)

Small, single-purpose migrations (per house rule):

1. `geo.geological_assessment` — one row per assessment: `id, sample_id, engine_version,
   input_hash, status, overall_confidence, report jsonb, created_at`. (Report kept as
   structured JSONB; the graph is normalised below for queryability + the invariant.)
2. `geo.assessment_conclusion` — `id, assessment_id, kind, statement, is_interpretation,
   confidence`. 
3. `geo.assessment_evidence` — `id, assessment_id, source, ev_type, statement,
   is_observation, tier, quality, dataset_id, provenance jsonb`.
4. `geo.assessment_edge` — `assessment_id, conclusion_id, evidence_id, polarity,
   contribution, effective_weight`. Enforces the no-orphan-conclusion invariant.
5. Recommendations + uncertainties: on the assessment row (jsonb) — display-only.

RLS: readable by whoever can read the parent sample (`can_read_sample`); writes are
service-role only (the function). Verified feedback (§10) writes to `geo.knowledge_source`
/ `geo.geological_knowledge` through a dedicated service path.

---

## 10. Learning loop

When a geologist **verifies/corrects** an assessment (future Desktop app), the corrected
conclusions + the sample become a new **knowledge source**: the verified sample is written
into `geo.mineral_occurrence` / a `geo.geological_knowledge` note with a high verification
tier, so `occurrences_near` / `knowledge_near` surface it as strong evidence for the next
nearby sample. This closes "verified geologist decisions continuously improve future AI."
The write is gated and audited; nothing enters the KB without a human verification.

---

## 11. Build slices (proposed)

- **S1 — Assessment schema** (§9 tables + RLS + invariant). No behaviour yet.
- **S2 — Evidence gathering** (`analyze-sample` GATHER: GeoContext + field items → Evidence Set; no AI yet; deterministic, testable).
- **S3 — Vision** (Gemini visual evidence items).
- **S4 — Reasoning + scoring** (Gemini reasoning contract §7 + confidence §6 + graph assembly + invariant enforcement).
- **S5 — Persist + lifecycle** (write assessment, set `ai_confidence`, status flow, audit; auto-trigger after submit).
- **S6 — App surface** (Detail screen: AI Analysis + Evidence Graph + GeoContext sections — §14 of Sprint 4.2.1).
- **S7 — Learning loop** (verified → KB feedback) — after the Desktop reviewer exists.

Each slice: schema/logic + tests + shadow verification, committed independently; no AI
key calls in unit tests (mocked), one integration test behind the real key.

---

## 12. Open decisions for you

1. **Trigger mechanism** — call `analyze-sample` right after submit (simple, synchronous-ish)
   vs. enqueue via `pg_net`/a queue (robust, retryable). Recommendation: enqueue.
2. **Assessment surface now?** Build S6 app view in this sprint, or after the reasoning
   core (S1–S5) is proven?
3. **Cost guard** — Gemini vision+reasoning per sample. OK to run automatically on every
   submit (owner beta = low volume), or gate behind a manual "Analyze" for now?
```
