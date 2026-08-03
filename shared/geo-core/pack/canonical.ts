// Canonical JSON — the serialisation a pack hash is taken over.
//
// E1's exit criterion is that identical geo.* input produces a byte-identical
// pack and therefore an identical sha256. JSON.stringify does not guarantee
// that on its own: key order follows insertion order, so two builds that read
// the same rows in a different column order would serialise differently and
// hash differently, making integrity verification and divergence triage
// guesswork (Architecture §7.2).
//
// Rules: object keys sorted, no insignificant whitespace, undefined dropped,
// non-finite numbers rejected rather than silently becoming null.

export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    const n = v as number;
    if (!Number.isFinite(n)) {
      // JSON.stringify turns these into null, which would silently corrupt a
      // coordinate or a weight. A pack must never carry a fabricated value.
      throw new Error(`canonicalJson: non-finite number (${String(n)})`);
    }
    // ECMAScript Number::toString is fully specified (shortest round-trip), so
    // this is identical on V8 and Hermes.
    return JSON.stringify(n);
  }
  if (t === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => stringify(x === undefined ? null : x)).join(",")}]`;
  if (t === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${t}`);
}
