# 03 — AI Architecture & Scientific Data Sources

## Core design principle
**A general-purpose vision LLM alone is not sufficient and must not be the sole system.** Independent benchmarking (MDPI *Minerals* 2022 study, 68 gemstone categories) found the best photo-only classical ML model reached **69.4%** accuracy on unseen images — and, tellingly, **three expert human gemmologists scored only 42.6–66.9%** on the same photos, taking 42–175 minutes each. This is the single most important data point in this entire document: **fine-grained natural-specimen identification from a photo alone is a hard problem even for trained humans.** The architecture below is designed around that reality, not around vendor marketing claims of 90%+ accuracy on easier, curated tasks.

Consequently GemScan AI is architected as a **cascade combining on-device detection, cloud multi-model vision ensembles, and a licensed scientific reference knowledge base** — not a thin wrapper around one AI API.

---

## 1. Multi-model cloud AI comparison

| | Best role | Cost per scan (compressed image) | Latency | Structured output | Notes |
|---|---|---|---|---|---|
| **Google Gemini 2.5/3 Flash** | Default first-pass classifier (free + paid tiers) | ~$0.001 | Fastest (~200ms TTFT) | Best — native JSON Schema | Cheapest frontier vision model; best fit for high-volume free-tier scans |
| **OpenAI GPT-4o / GPT-5-mini** | Ensemble member; strong general knowledge, good OCR (e.g. reading a GIA cert number in a photo) | ~$0.001–0.006 | Mid (~300–600ms) | Good via `response_format` | Not fine-tuned for gemology; same fine-grained limitations as all general VLMs |
| **Anthropic Claude Sonnet/Opus** | Ensemble arbiter / "expert re-check" tier only | Sonnet ~$0.005–0.008; Opus ~$0.007–0.03+ | Slowest TTFT (~1.2s) | Good via tool-use | More cautious, less prone to overconfident hallucination — good tie-breaker role; Opus reserved for rare cases only, cost-prohibitive at scale |

**None of the three vendors offer gemology/mineralogy fine-tuning** — all are general-purpose models applied to a specialist task. This is exactly why the reference knowledge base (§2 below) and specialized CV layers (§3) matter as much as model choice.

**Recommended combination:** Gemini Flash as the default single-call engine for free-tier and Tier-1 premium scans; GPT-5-mini + Claude Sonnet added as a 3-model ensemble only for premium "deep scan" requests or when Tier-1 confidence is low; Opus held back as a rare, separately-capped "expert re-check" action. This mirrors the FrugalGPT cascade pattern (up to ~90% cost reduction vs. always-calling-the-best-model) and keeps unit economics sound (see cost modeling below).

**Important caveat — ensemble diversity is limited.** Gemini, GPT, and Claude are all general-purpose transformers trained on overlapping web-scale corpora, so the ensemble reduces single-model *noise* but does not eliminate shared systematic blind spots (e.g., all three are likely weaker on the same underrepresented regional/East African specimens, since that's a training-data gap, not random variance). Don't market the ensemble as solving accuracy on its own — the real unlock is the licensed reference knowledge base below plus the human-in-the-loop tier in §4.

**Multi-photo fusion.** Each scan can include 2–4 user-captured photos (different angle/lighting, per the guided capture flow in §02/§06) rather than a single image. Luster and transparency in particular are lighting-dependent and under-constrained by one photo; all ensemble calls receive the full photo set and are prompted to reconcile across them. This is a low-cost accuracy improvement no single-photo competitor in §01 can match.

**Locality-aware re-ranking.** When a user opts in to location for a scan, candidate species are re-weighted against USGS/Macrostrat locality data before being returned — a mineral not documented in the scan's region is deprioritized rather than presented with equal confidence. This is only possible because of the licensed geological database (§3) and is a structural advantage over pure-vision competitors.

**Hallmarks use a separate pipeline, not the general vision ensemble.** Reading assay-office marks, maker's marks, and date letters is an OCR + small-symbol-database matching problem, not fine-grained visual classification. Hallmark scans run through a dedicated OCR pass matched against a licensed hallmark reference table (structured like `reference_species`, see §04), falling back to general vision-LLM interpretation only when OCR confidence is low.

## 2. On-device / specialized computer vision (non-LLM layer)

- **YOLO (v8/v11)** — role is strictly **detection/localization**, not identification: confirms a specimen is in frame, drives live-camera framing/lighting guidance, crops the region of interest, and filters out non-specimen frames before any paid API call is made. Runs in 10–20ms on-device.
- **TensorFlow Lite (MobileNet/EfficientNet-Lite)** — role is a **coarse, narrow pre-classifier** (e.g., "quartz-family / corundum-family / diamond-like / organic gem / base-metal jewelry / not applicable"), not full species+variety ID. Even the best mobile-class models (EfficientNet-Lite4, 80.4% top-1 on the *easier* ImageNet task) are not accurate enough for fine-grained gem/mineral classes — scope it narrowly and let it gate/route, not decide.
- **Vision Transformer (ViT)** — used server-side (not on-device) as an additional ensemble signal, trained/fine-tuned on the licensed image corpus described below once it exists at sufficient scale; not viable on public gemstone datasets alone today (largest public set, Kaggle's 87-class "Gemstones-Images," has often <40 images/class — too small to generalize from scratch).

## 3. Scientific reference knowledge base — required, not optional

The system must ground its output in real reference data, not rely purely on an LLM's internal "knowledge." Below is the full licensing analysis of every candidate source, with the legal distinction that matters most: **scientific/factual data (Mohs hardness, crystal system, chemical formula, locality names) is not copyrightable in essentially any relevant jurisdiction (US: *Feist v. Rural*); photographs and curated compilations are separately and individually protected.**

### Tier 1 — Commercial-safe today, no negotiation required
| Source | Cost | License | Commercial use | Best for |
|---|---|---|---|---|
| **USGS (MRDS + publications)** | Free | US public domain (17 U.S.C. §105) | Yes, unrestricted | Deposit/locality/geologic facts. *Caveat: some hosted photos are third-party and NOT public domain — verify per-image.* |
| **Smithsonian NMNH Open Access** | Free | CC0 (per-record, filter on rights field) | Yes, no attribution required | Structured mineral records + some CC0 photos |
| **CrossRef API** | Free | Facts, not copyrightable | Yes, unrestricted | Citing peer-reviewed literature |
| **arXiv (metadata only)** | Free | CC0 metadata; full text stays author-copyright | Yes for metadata/citation links | Linking to research, not reproducing papers |
| **Macrostrat API** | Free | CC BY 4.0 | Yes, with attribution | Geologic/stratigraphic context |
| **Meteoritical Bulletin data (via NASA's public-domain "Meteorite Landings" dataset)** | Free | Public domain / CC BY | Yes | Meteorite classification facts. *Photos are outbound links only — do not embed without independent rights check.* |
| **RRUFF (spectral/chemistry, U. Arizona)** | Free | CC BY 4.0 (recommend written confirmation before scale-up — site-wide licensing documentation is inconsistent) | Yes, with attribution | Raman/XRD/chemistry reference — the strongest scientific differentiator vs. pure-vision competitors |

### Tier 2 — Usable with filtering or a paid commercial license
| Source | Status | Action needed |
|---|---|---|
| GBIF | Mixed CC0/CC-BY/CC-BY-NC per dataset; limited geological relevance | Filter programmatically, exclude NC-tagged records |
| PetDB / EarthChem | CC BY-SA (share-alike) / mixed per-dataset | Fine for informing derived facts; avoid verbatim redistribution due to copyleft |
| Semantic Scholar API | Free tier explicitly **forbids** commercial embedding | Apply for AI2's commercial license before shipping |
| SerpAPI / reverse-image search | Paid infrastructure, legal to query | Use only as "visually similar — see source" pass-through; never as training data or stored images |

### Tier 3 — Requires partnership or excluded entirely
| Source | Finding | Action |
|---|---|---|
| **Mindat.org** | The single best mineral/locality database in existence, but API/data is explicitly **non-commercial only** during its current beta; photos are a patchwork of individually-copyrighted contributor images | **Budget a direct BD/licensing negotiation with Mindat early in the roadmap** — this is a business-development task, not just an engineering one, and is likely the highest-leverage partnership available to this product |
| **GIA** | No general commercial API path exists for this use case; their API ToS only covers report-number verification for trade partners, not reference-data licensing; also poor fit (finished/graded gems, not rough field specimens) | Drop as a data source. Keep only as citation/education links to GIA's public consumer content |
| **Bing Search/Image API** | Fully retired (Aug 2025) | Excluded |
| **Google Custom Search API** | Closed to new customers; full retirement Jan 1, 2027 | Do not build a dependency on it |
| **Google Scholar (any form)** | No official API; all alternatives are ToS-violating scrapers | Excluded entirely — use Semantic Scholar (licensed) + CrossRef + arXiv instead |

### Architectural conclusion
Build the **ground-truth knowledge graph** (species → hardness, crystal system, formula, common localities, distinguishing tests, citations) from **USGS + Smithsonian CC0 + RRUFF + Macrostrat** — all cleanly usable today. Pursue a **Mindat commercial partnership** in parallel as a roadmap item for locality/community-verified breadth. Use only Smithsonian CC0 images and the app's own commissioned/field photography to train or fine-tune any proprietary vision model — never Mindat, GIA, or scraped search-engine images without per-item clearance.

## 4. Human-in-the-loop tier — the real accuracy ceiling-breaker

Given the MDPI study's finding that even expert human gemmologists only reach 42.6–66.9% on photo-only ID, no pure-AI ensemble will fully close that gap. Rather than hide this limit, GemScan AI turns it into a product feature: a paid **"Ask a Real Gemologist"** on-demand escalation, routed from any Low/Medium-confidence result to a vetted human expert for a second opinion (async review, priced per consult). This is the single most defensible accuracy claim available — "AI + human expert" is a materially different (and more honest) product than any pure-AI competitor in §01, none of which offer this.

## 5. Continuous-improvement / "living" knowledge base

- New scan submissions (with user consent, stripped of PII/location if the user opts out of sharing) feed a review queue; specimens with expert-confirmed labels (via in-house review or partner gemologists) are added to the proprietary training corpus over time — this is how the system improves beyond the static public datasets described above, and is the realistic path to closing the gap toward higher accuracy on rarer/regional specimens.
- Reference facts (hardness, formula, etc.) are versioned and re-synced periodically from USGS/RRUFF/Macrostrat/Smithsonian APIs so the encyclopedia and chat assistant stay current without manual re-entry.
- Model performance is tracked per specimen category (§02 success metrics) so retraining/re-prompting effort is prioritized where the ensemble's agreement rate is lowest — i.e., continuous improvement is driven by measured weak spots, not guesswork.

## 6. Cost modeling (validates the freemium tier)

- Free tier (5 scans/day, single Gemini Flash call): ≈$0.001/scan → a fully-maxed free user costs ≈$1.80/year in API spend — comfortably sustainable even at zero conversion.
- Premium ensemble scan (Flash + GPT-5-mini + Sonnet): ≈$0.01–0.03/scan. **Risk:** at $25/year, a power user running 2 full ensemble scans/day would already consume $15–22/year in API cost alone before infra/support — thin or negative margin. **Mitigation:** default premium scans to the cheaper single/dual-model tier; gate the full 3-model ensemble + Opus arbitration behind a soft daily cap even for paying users; enforce server-side image downscaling before every cloud call regardless of tier.

## 7. Hard, explicit accuracy boundaries (must be reflected in product copy, not just this doc)

- **Realistic ceiling for common, natural, untreated species in good macro lighting:** ~70–85% with a good ensemble.
- **Rare species, close look-alikes (ruby vs. red spinel vs. garnet; emerald vs. green tourmaline vs. glass), poor lighting/dirty specimens:** materially lower, plausibly under 50–60% — consistent with the human-expert baseline cited above.
- **Natural vs. synthetic origin:** **not achievable from a photo, full stop** — requires DiamondView/UV fluorescence, FTIR/photoluminescence spectroscopy, or trained inclusion analysis under magnification. The app must say so, not hedge with a fake percentage.
- **Treatment detection** (heat, dye, irradiation, fracture-filling, HPHT): same — requires spectroscopic examination in the overwhelming majority of cases per gemological sourcing (Gem-A, GIA-adjacent literature).
- **Confidence should be presented as a qualitative agreement band (Low/Medium/High), not a false-precision percentage** — current VLM-ensemble research shows models are better at ranking candidates than producing calibrated absolute confidence scores.

This honesty is a competitive advantage, not a limitation to hide: every competitor researched in §01 either overclaims or gets caught giving inconsistent answers. Being the one product that says "we're not sure, here's why, here's what would confirm it" is differentiating in a category where trust is the scarcest resource.
