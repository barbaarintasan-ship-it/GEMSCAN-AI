# 02 — Product Requirements Document (PRD)

## Product name
**GemScan AI**

## Vision
The most trustworthy AI-powered identification tool for naturally occurring gemstones, minerals, rocks, crystals, meteorites, and precious metals — plus jewelry, coins, and hallmarks — built on honest confidence scoring, real scientific reference data, and a genuine consumer-to-professional tier ladder that no competitor currently spans.

## Primary emphasis (per updated scope)
The core differentiator is **natural/field specimens**: rough, uncut, raw material as found by miners, hobbyists, and geologists — not just polished jewelry photography. This is the segment every competitor (which skews toward cut/finished stones and jewelry) under-serves, and it's where scientific reference-data integration (§03) provides the most defensible accuracy advantage over pure-LLM competitors.

## Target users (ranked by product priority)
1. **Rockhounds / hobbyist collectors / miners** — field identification of rough finds; the underserved core.
2. **Geology & gemology students** — need rigorous structured data (crystal system, hardness, RI), not zodiac content.
3. **Jewelers & gemstone dealers** — professional tier: inventory, PDF reports, batch scanning.
4. **Gold traders / pawn shops** — precious metal + hallmark + jewelry ID with appraisal-adjacent (never appraisal-certified) output.
5. **General consumers** — inherited jewelry, estate finds, "what is this rock my kid found."

## Scope of identification
Natural specimens (priority): rough gemstones, uncut gems, mineral crystals, rock/ore samples, natural gold/silver specimens, meteorites, fossilized materials, general geological samples.
Secondary (jewelry/trade): cut & cabochon stones, finished jewelry, jewelry settings, hallmarks, pearls, coins, gold/silver/platinum/palladium items.

## Explicit non-goals (set expectations correctly — see §03 for why)
- **Not a certified appraisal tool.** No output is a substitute for a GIA/AGS/Gübelin report or an insurance appraisal.
- **Not a natural-vs-synthetic determination tool.** This requires spectroscopy/UV fluorescence/inclusion analysis unavailable to a phone camera — the app states this plainly rather than guessing with false confidence.
- **Not a treatment-detection tool** (heat, dye, irradiation, fracture-filling, HPHT) for the same physical reason.
- **Not a replacement for XRF gold testing** — precious-metal purity output is a visual/contextual estimate, not an assay result.

## Core features

### Camera & capture
- Live camera scanning with real-time on-device pre-filter (object detection, framing guidance, lighting quality hint)
- Photo capture + gallery upload
- Flashlight, macro mode, pinch-to-zoom, tap-to-focus
- Multi-object detection (e.g., a tray of rough stones, a jewelry lot)
- Automatic image enhancement (white balance, exposure correction) before AI submission
- **Multi-photo capture per scan** (2–4 guided angles/lighting conditions, e.g. "now tilt to show luster," "capture in shade") — a single photo under-constrains luster/transparency judgment; this is a cheap accuracy lever no competitor in §01 offers, since they're all single-photo.

### Identification & results
Every result screen shows, where scientifically knowable and applicable to the specimen type:
Common name, scientific name, trade name, chemical formula, crystal system, Mohs hardness, specific gravity, refractive index, luster, transparency, color, likely treatments (flagged as "cannot be confirmed by photo — recommend lab test" where relevant), natural/synthetic/imitation probability **framed as a qualitative caveat, not a percentage claim** (see §03), origin/likely mining regions, estimated value **range** (explicitly labeled as non-appraisal), care instructions, interesting facts, a qualitative confidence band (Low/Medium/High agreement across models — not a fake precise percentage), and a professional disclaimer.
Top-3 candidate results shown when confidence is not High, not a single forced answer — this directly fixes the "3 different apps gave 3 different answers" trust failure identified in competitor research.
Candidate ranking is **locality-aware**: if the user has opted in to sharing location for a scan, candidates are re-weighted using USGS/Macrostrat locality data (a mineral known only from certain regions is deprioritized if the scan location rules it out) — a differentiator only possible because of the licensed geological database, not something a pure-vision competitor can replicate as well.
**Hallmarks are identified via a dedicated OCR + symbol-database sub-pipeline** (assay office marks, maker's marks, date letters matched against a licensed reference table), not the general gemstone vision pipeline — this is a fundamentally different (text/symbol-matching) problem and needed its own path for reliable results.

### AI Gemologist chat
Conversational assistant, grounded in the app's own reference knowledge base (§03), for follow-up questions about a scan result or general gemology/geology questions. Cites sources (e.g., "per USGS," "per RRUFF spectral reference") where the knowledge base directly informed the answer.

### Encyclopedia
Offline-capable reference library, 300+ gemstones/minerals/metals, built from the licensed data sources in §03 (not scraped/unlicensed content).

### Collection & history
Personal specimen log (photo, ID, date, location if permitted, notes), exportable.

### Ask a Real Gemologist (premium add-on)
On-demand paid escalation to a human gemologist for a second opinion on a Low/Medium-confidence scan — directly addresses the fundamental photo-only accuracy ceiling documented in §03 (even trained human experts only reach 42–67% on photo-only ID in the cited MDPI study, so a *combined* AI + on-demand-human product is more honest and more capable than any pure-AI competitor). Monetized per-consult (see §05).

### Professional tier additions
Inventory management (SKU-style records per specimen/piece), batch scanning, branded PDF report generation directly from a scan (the single feature no competitor's inventory SaaS offers — see §01), multi-user accounts for a shop.

### Published accuracy transparency
A regularly-updated, public per-category accuracy/agreement-rate report (sourced from the metrics below), so users calibrate trust with evidence instead of marketing claims — no competitor in §01 publishes real accuracy data.

## Localization
English and Somali, full parity on every screen, string, and generated PDF report. No hardcoded text — all copy goes through a localization layer from day one (see §06 for i18n architecture notes). Given zero competitors in this category support any language beyond English, this is a genuine differentiator, not just accessibility box-checking.

## Success metrics (recommend tracking from day one)
- Free→paid conversion rate, tracked separately from "trial abandonment due to billing confusion" (the #1 complaint industry-wide — a low complaint rate here is itself a KPI)
- Result agreement rate (how often the ensemble reaches High confidence) as a proxy for real-world accuracy, segmented by specimen category
- 1-star review theme tracking against the known industry failure modes (billing, accuracy, ads) so regressions are caught early
- Professional-tier activation and PDF-report-generation volume (a proxy for jeweler retention)
