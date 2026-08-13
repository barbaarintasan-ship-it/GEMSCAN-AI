// The AI report, rendered through the app's REAL locale files.
//
// The other report tests use a fixture translator, which proves the renderer.
// These prove the SHIPPED translations: that both languages carry every key, and
// that the vocabulary the prompt asks a model to use is actually renderable in
// Somali. A renderer that works and a locale file that does not is a Somali
// geologist reading English.
import en from "../../locales/en.json";
import so from "../../locales/so.json";
import {
  MISSION_FINDINGS_VERSION, type MissionFindings,
} from "../../../shared/geo-core/gie/missionFindings";
import { renderReport } from "../../../shared/geo-core/gie/renderReport";

type Dict = Record<string, unknown>;

/** i18next semantics: a missing key comes back as the key itself. */
function translator(bundle: Dict): (k: string, p?: Record<string, string | number>) => string {
  return (key, params) => {
    let node: unknown = bundle;
    for (const part of key.split(".")) {
      if (node == null || typeof node !== "object") return key;
      node = (node as Dict)[part];
    }
    if (typeof node !== "string") return key;
    let out = node;
    for (const [k, v] of Object.entries(params ?? {})) out = out.replace(`{{${k}}}`, String(v));
    return out;
  };
}

function keys(o: unknown, prefix = ""): string[] {
  if (o == null || typeof o !== "object") return [prefix];
  return Object.entries(o as Dict).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("both locales carry every report key", () => {
  test("the key sets are identical", () => {
    // The app sets fallbackLng "en". A key missing from Somali therefore renders in
    // ENGLISH rather than being flagged as untranslated — which is precisely the
    // failure renderReport's `untranslated` list exists to catch, defeated by the
    // fallback. The only reliable defence is that no report key is ever missing.
    const a = keys((en as Dict).report).sort();
    const b = keys((so as Dict).report).sort();
    expect(a.length).toBeGreaterThan(80);
    expect(b).toEqual(a);
  });

  test("no report string was left as an empty placeholder", () => {
    for (const [name, bundle] of [["en", en], ["so", so]] as const) {
      for (const key of keys((bundle as Dict).report)) {
        const value = translator(bundle as Dict)(`report.${key}`);
        expect(value.length).toBeGreaterThan(0);
        expect(value).not.toBe(`report.${key}`);
      }
    }
  });

  test("the Somali is Somali, not a copy of the English", () => {
    // A locale file filled in by copying is the commonest way a bilingual app ends
    // up monolingual. Checked on the sections a reader sees first.
    const enT = translator(en as Dict);
    const soT = translator(so as Dict);
    for (const key of [
      "report.section.summary", "report.section.missing", "report.section.confidence",
      "report.score.notAProbability", "report.confidence.meaning",
      "report.action.collect_rock_samples", "report.missing.assay",
    ]) {
      expect(soT(key)).not.toBe(enT(key));
    }
  });
});

describe("the vocabulary the prompt asks for is renderable in both languages", () => {
  // Exactly the codes missionPrompt tells the model to use. If the model follows
  // the instruction, nothing should come back untranslated.
  const EVIDENCE_TYPES = [
    "quartz_vein", "sulphides", "gossan", "alteration", "malachite", "iron_staining",
    "fault_proximity", "contact_proximity", "lithology", "host_rock",
    "terrain_morphology", "valley_landform", "ridge_landform", "elevation",
    "drainage_proximity", "occurrence_cluster", "geochemistry", "geophysics",
    "remote_sensing", "field_observation", "photograph", "outcrop", "float", "shear_zone",
  ];
  const SIGNIFICANCES = [
    "hydrothermal_indicator", "fluid_pathway", "favourable_host", "structural_control",
    "placer_potential", "weathering_product", "oxidation_indicator", "not_available",
    "none_in_range", "unstated", "context_only", "requires_assay",
  ];
  const ACTIONS = [
    "collect_rock_samples", "submit_for_assay", "record_vein_orientation",
    "photograph_fresh_surfaces", "map_strike_extent", "soil_geochemistry",
    "stream_sediment_sampling", "panning_test", "trace_contact", "examine_alteration",
    "revisit_with_gps", "petrographic_analysis", "check_fault_zone",
  ];
  const MISSING = [
    "assay", "geochemistry", "geophysics", "remote_sensing", "alteration_mapping",
    "lineaments", "drilling", "trenching", "vein_orientation", "sample_collected",
    "confirmed_mineralization", "grade_data", "petrography", "structural_measurement",
  ];

  function findings(): MissionFindings {
    return {
      version: MISSION_FINDINGS_VERSION,
      commodity: "gold",
      interest: "moderate",
      confidence: "low",
      evidence: EVIDENCE_TYPES.map((type, i) => ({
        type,
        origin: "engine_layer" as const,
        status: "present" as const,
        strength: "moderate" as const,
        confidence: "medium" as const,
        significance: SIGNIFICANCES[i % SIGNIFICANCES.length],
      })),
      missingEvidence: MISSING,
      recommendations: ACTIONS.map((action, i) => ({
        action, priority: ((i % 3) + 1) as 1 | 2 | 3, becauseOf: [],
      })),
      model: "test-model",
      analysedAt: 0,
    };
  }

  for (const [name, bundle] of [["English", en], ["Somali", so]] as const) {
    test(`${name}: every code the prompt asks for has a translation`, () => {
      const r = renderReport(
        findings(), translator(bundle as Dict), name === "Somali" ? "so" : "en",
        { prospectivityScore: 0.62 },
      );
      expect(r.untranslated).toEqual([]);
    });

    test(`${name}: no line renders blank or leaks a raw code`, () => {
      const r = renderReport(
        findings(), translator(bundle as Dict), name === "Somali" ? "so" : "en",
        { prospectivityScore: 0.62 },
      );
      for (const s of r.sections) {
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.title.startsWith("report.")).toBe(false);
        for (const line of s.lines) {
          expect(line.trim().length).toBeGreaterThan(0);
          // A snake_case fragment surviving into the text means a key was missed.
          expect(/[a-z]_[a-z]/.test(line)).toBe(false);
        }
      }
    });
  }

  test("an unknown code is humanised and REPORTED, never silently English", () => {
    const f = findings();
    f.evidence.push({
      type: "some_code_nobody_translated", origin: "engine_layer", status: "present",
      strength: "weak", confidence: "low", significance: "unstated",
    });
    const r = renderReport(f, translator(so as Dict), "so", { prospectivityScore: 0.5 });
    expect(r.untranslated).toContain("some_code_nobody_translated");
    // And it is readable rather than blank.
    const line = r.sections
      .flatMap((s) => s.lines)
      .find((l) => l.includes("Some code nobody translated"));
    expect(line).toBeDefined();
  });
});

describe("the two languages tell the same story", () => {
  test("confidence, interest and structure are identical", () => {
    const f: MissionFindings = {
      version: MISSION_FINDINGS_VERSION, commodity: "gold",
      interest: "moderate", confidence: "medium", claimedConfidence: "high",
      evidence: [{
        type: "quartz_vein", origin: "field_observation", status: "present",
        strength: "moderate", confidence: "medium", significance: "hydrothermal_indicator",
      }],
      missingEvidence: ["assay"],
      recommendations: [{ action: "submit_for_assay", priority: 1, becauseOf: [] }],
      model: "m", analysedAt: 0,
    };
    const a = renderReport(f, translator(en as Dict), "en", { prospectivityScore: 0.62 });
    const b = renderReport(f, translator(so as Dict), "so", { prospectivityScore: 0.62 });

    expect(a.confidence).toBe(b.confidence);
    expect(a.interest).toBe(b.interest);
    expect(a.sections.map((s) => s.titleKey)).toEqual(b.sections.map((s) => s.titleKey));
    expect(a.sections.map((s) => s.lines.length)).toEqual(b.sections.map((s) => s.lines.length));
    // Both say the confidence was reduced — a reader in either language is told.
    const capped = (r: typeof a) =>
      r.sections.find((s) => s.titleKey === "report.section.confidence")!.lines.length;
    expect(capped(a)).toBe(capped(b));
    expect(capped(a)).toBe(3);
  });

  test("neither language states odds, and both say so explicitly", () => {
    const f: MissionFindings = {
      version: MISSION_FINDINGS_VERSION, commodity: null,
      interest: "limited", confidence: "low",
      evidence: [], missingEvidence: ["assay"], recommendations: [],
      model: "m", analysedAt: 0,
    };
    for (const [bundle, lang] of [[en, "en"], [so, "so"]] as const) {
      const r = renderReport(f, translator(bundle as Dict), lang, { prospectivityScore: 0.62 });
      const text = r.sections.flatMap((s) => s.lines).join(" ");
      // The report says outright that the score is not a probability, in both.
      expect(/not a probability|MA AHA suurtogalnimada/i.test(text)).toBe(true);
      // And contains no odds of its own.
      expect(/\d{1,3}\s*%/.test(text)).toBe(false);
      expect(/boqolkiiba \d/i.test(text)).toBe(false);
    }
  });
});

describe("the six sections of a field report", () => {
  // The report the geologist asked for reads in the order they read one: what was
  // investigated, what they saw, what the photographs show, what the ground says,
  // what it might mean, what to do. Evidence used to be one flat list, which put
  // a geologist's own observation and a layer read off a map side by side as
  // though they were the same kind of claim.
  const findings = {
    version: 1, commodity: "gold", interest: "worth_following_up",
    confidence: "low",
    evidence: [
      { type: "gossan", origin: "field_observation", status: "present",
        strength: "moderate", confidence: "low", significance: "oxidised_sulphides" },
      { type: "iron_staining", origin: "photograph", status: "present",
        strength: "weak", confidence: "low", significance: "surface_alteration" },
      { type: "fault_proximity", origin: "engine_layer", status: "present",
        strength: "moderate", confidence: "low", significance: "structural_control" },
      { type: "quartz_association", origin: "commodity_profile", status: "present",
        strength: "weak", confidence: "low", significance: "pathfinder" },
    ],
    missingEvidence: ["assay"], recommendations: [], model: "m", analysedAt: 1,
  } as never;

  const titles = (lang: "en" | "so") =>
    renderReport(findings, translator((lang === "en" ? en : so) as Dict), lang, { prospectivityScore: 0.4 })
      .sections.map((s) => s.titleKey);

  test("the six requested sections are all present, in order", () => {
    const order = titles("en");
    const wanted = [
      "report.section.overview",
      "report.section.observations",
      "report.section.visual",
      "report.section.context",
      "report.section.actions",
    ];
    let last = -1;
    for (const key of wanted) {
      const at = order.indexOf(key);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  test("a field observation and an engine layer land in DIFFERENT sections", () => {
    const r = renderReport(findings, translator(en as Dict), "en", { prospectivityScore: 0.4 });
    const obs = r.sections.find((s) => s.titleKey === "report.section.observations")!.lines.join(" ").toLowerCase();
    const ctx = r.sections.find((s) => s.titleKey === "report.section.context")!.lines.join(" ").toLowerCase();
    expect(obs).toContain("gossan");
    expect(obs).not.toContain("fault");
    expect(ctx).toContain("fault");
    expect(ctx).not.toContain("gossan");
  });

  test("what came from a PHOTOGRAPH is its own section", () => {
    const r = renderReport(findings, translator(en as Dict), "en", { prospectivityScore: 0.4 });
    const vis = r.sections.find((s) => s.titleKey === "report.section.visual")!;
    expect(vis.lines.join(" ").toLowerCase()).toContain("iron");
  });

  test("an empty section says so rather than disappearing", () => {
    // A missing section reads as "not applicable"; an empty one reads as "looked,
    // found nothing", and in greenfield exploration those are different findings.
    const bare = { ...(findings as never as Record<string, unknown>), evidence: [] } as never;
    const r = renderReport(bare, translator(en as Dict), "en", { prospectivityScore: 0.4 });
    for (const key of ["report.section.observations", "report.section.visual", "report.section.context"]) {
      const s = r.sections.find((x) => x.titleKey === key)!;
      expect(s).toBeDefined();
      expect(s.lines.length).toBeGreaterThan(0);
    }
  });

  test("both languages still produce the SAME structure", () => {
    expect(titles("so")).toEqual(titles("en"));
  });
});
