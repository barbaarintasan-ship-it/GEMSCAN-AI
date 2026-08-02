// Guard: the shared-core reasoning contracts must stay identical to the
// server's (Stage E0).
//
// scoring.ts moved into shared/geo-core and needs EvidenceLink / RawConclusion.
// Those are declared in reasoning.ts, which also holds the Gemini transport
// (`Deno.env`, `fetch`) — a module the mobile app can never pull into its type
// graph. So shared/geo-core/gie/contracts.ts declares them independently.
//
// The clean fix is for reasoning.ts to re-export from contracts.ts, but that
// file currently carries unrelated uncommitted work, so it was left untouched
// (see the E0 notes). Until that lands, these are two declarations of one
// contract — exactly the drift Architecture Invariant 3 warns about.
//
// This test makes the duplication SAFE rather than silent: the assertions below
// are compile-time and mutual, so adding, removing or retyping a field on
// either side fails `deno test` immediately.
//
// DELETE THIS FILE once reasoning.ts re-exports from contracts.ts.
import type * as Core from "../../../../shared/geo-core/gie/contracts.ts";
import type * as Server from "./reasoning.ts";

// Strict type identity. Mutual assignability is NOT enough: an added OPTIONAL
// field is assignable in both directions, so `A extends B && B extends A` would
// pass while the contracts had already drifted. Comparing the types in an
// invariant position (the conditional's check type) distinguishes optional from
// required and catches additions, removals and retypings alike.
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertExact<T extends true>(): void {}

assertExact<Exact<Core.ConclusionKind, Server.ConclusionKind>>();
assertExact<Exact<Core.EvidenceLink, Server.EvidenceLink>>();
assertExact<Exact<Core.RawConclusion, Server.RawConclusion>>();
assertExact<Exact<Core.RawRecommendation, Server.RawRecommendation>>();
assertExact<Exact<Core.InterpretationLayer, Server.InterpretationLayer>>();
assertExact<Exact<Core.ReasoningOutput, Server.ReasoningOutput>>();

Deno.test("shared-core reasoning contracts match the server declarations", () => {
  // The real assertions are the compile-time checks above; this body exists so
  // the guard runs as part of the suite and shows up in the report.
});
