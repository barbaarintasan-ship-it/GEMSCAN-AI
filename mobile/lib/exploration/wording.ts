// Turning what the engines found into sentences, in the reader's language.
//
// Extracted from the exploration screen when the map became the workspace: the
// guidance pill lives on the MAP and the sheet lives in a SURFACE above it, and
// both say the same things about the same targets. Two copies of "what a
// regional lead is called" is how the pill and the sheet start disagreeing in
// front of a geologist.
//
// Every function here takes `t` and returns a translated string. None of them
// decides anything: the engine reports WHAT it found, structured, and this
// decides how to SAY it. That split is what lets a Somali geologist read the
// same reasoning an English one does, instead of a translated shell wrapped
// around English geology.
import { compassPoint as compassPointOf } from "../../../shared/geo-core/geo/spatial.ts";
import type { TargetReason } from "../geo/targeting.ts";
import { classifyDistance, type RegionalTarget } from "../geo/expedition";
import { roadFactor } from "../geo/roadFactor";
import { NEARBY_FAULT_M, type Orientation } from "../geo/orientation";
import { waypointTypeLabelKey, type WaypointType } from "../field/waypointTypes";
import type { ExplorationSnapshot } from "./orchestrator.ts";
import {
  compassKey, formatDistance, formatTravel, roadClause, transportKey, type TFunc,
} from "./format";

export function unitOf(ctx: { geology?: { unit?: string } } | null): string | null {
  return ctx?.geology?.unit ?? null;
}

export const reasonKey = (r: TargetReason, i: number): string => r.kind + "-" + String(i);

/** What a regional lead IS, in one phrase — never more than the pack recorded. */
export function regionalLabel(r: RegionalTarget, t: TFunc): string {
  if (r.reason.kind === "known_occurrence") {
    return r.reason.commodity
      ? t("field.regional.occurrence", { commodity: r.reason.commodity })
      : t("field.regional.occurrenceUnnamed");
  }
  return r.reason.name
    ? t("field.regional.faultNamed", { name: r.reason.name })
    : t("field.regional.fault");
}

/** Renders a structured reason in the active language. */
export function renderReason(r: TargetReason, t: TFunc): string {
  switch (r.kind) {
    case "occurrence":
      return t("field.reason.occurrence", { commodity: r.commodity, distance: formatDistance(t, r.distanceM) });
    case "association":
      return t("field.reason.association", { commodity: r.commodity });
    case "community":
      return t("field.reason.community", { count: r.count });
    case "observation":
      return t("field.reason.observation", {
        label: t(waypointTypeLabelKey(r.label as WaypointType)),
        distance: formatDistance(t, r.distanceM),
      });
    case "fault":
      return t("field.reason.fault", { distance: formatDistance(t, r.distanceM) });
    case "contact":
      return t("field.reason.contact", { distance: formatDistance(t, r.distanceM) });
    case "intersection":
      return t("field.reason.intersection", { distance: formatDistance(t, r.distanceM) });
    case "unit":
      return t("field.reason.unit", { name: r.name });
  }
}

/** Two or three words for the collapsed "Reason" column. */
export function shortReason(r: TargetReason, t: TFunc): string {
  switch (r.kind) {
    case "occurrence": return t("field.short.occurrence", { commodity: r.commodity });
    case "association": return t("field.short.association", { commodity: r.commodity });
    case "community": return t("field.short.community");
    case "observation": return t("field.short.observation");
    case "fault": return t("field.short.fault");
    case "contact": return t("field.short.contact");
    case "intersection": return t("field.short.intersection");
    case "unit": return r.name;
  }
}

/**
 * One sentence for the collapsed sheet: what to do now, and why.
 *
 * The one thing it must never do is end the workflow. Every branch below either
 * gives a direction or explains what is being waited for — and where the engine
 * has no recommendation, the nearest MEASURED feature in the pack is offered
 * with the means and time to reach it, rather than the sentence this screen used
 * to finish on: "nothing to walk to here".
 */
export function recommendation(
  s: ExplorationSnapshot, o: Orientation | null, nearest: RegionalTarget | null, t: TFunc,
): string {
  if (s.suspendedBy) {
    return s.suspendedBy === "no-fix" ? t("field.status.waitingGps")
      : s.suspendedBy === "paused" ? t("field.status.paused")
      : t("field.status.sensorError");
  }
  if (s.inspecting) return t("field.location.lookupHint");
  if (s.state === "awaitingEvidence") return t("field.arrived.body");
  if (s.activeTarget) {
    const first = s.activeTarget.reasons[0];
    return t("field.sheet.walkToward", {
      distance: formatDistance(t, s.distanceToTargetM ?? s.activeTarget.distanceM),
      compass: t(compassKey(s.activeTarget.compass)),
      reason: first ? renderReason(first, t) : "",
    });
  }
  // A chosen destination outranks a suggestion: the user already decided.
  if (s.destination && s.destinationDistanceM != null && s.destinationBearingDeg != null) {
    const cls = classifyDistance(s.destinationDistanceM, roadFactor().current());
    return t("field.sheet.regionalLead", {
      distance: formatDistance(t, s.destinationDistanceM),
      compass: t(compassKey(compassPointOf(s.destinationBearingDeg))),
      // The hours below were computed from the ROAD, not from this straight
      // line. Saying one without the other is how "94.4 km · 2 h 42" happened.
      road: roadClause(t, cls.travelDistanceM, cls.roadFactorApplied),
      transport: t(transportKey(cls.transport)),
      travel: formatTravel(t, cls.travelMinutes),
    });
  }
  // No target within one leg. Not a dead end — a classification. The pack knows
  // where the nearest mapped ground is; say so, and say how to get to it.
  if (nearest) {
    return t("field.sheet.nothingHereFar", {
      distance: formatDistance(t, nearest.distanceM),
      compass: t(compassKey(nearest.compass)),
      road: roadClause(
        t, nearest.distanceClass.travelDistanceM, nearest.distanceClass.roadFactorApplied,
      ),
      transport: t(transportKey(nearest.distanceClass.transport)),
      travel: formatTravel(t, nearest.distanceClass.travelMinutes),
    });
  }
  // The scan has not finished yet — a pause, not a conclusion.
  if (s.state === "orienting") return t("field.status.orienting");
  // Only now, with the whole pack read and genuinely nothing in it, is silence
  // the honest answer. Unknown stays Unknown.
  if (o?.nothingNearby) return t("field.regional.none");
  return t("field.none.noStrongerBody");
}

/** A short paragraph for the expanded sheet: what this ground is. */
export function interpretation(
  s: ExplorationSnapshot, o: Orientation | null, t: TFunc,
): string {
  const unit = unitOf(s.context);
  const parts: string[] = [];
  parts.push(unit ? t("field.sheet.youAreOn", { unit }) : t("field.sheet.unitUnknown"));
  if (o?.fault && o.fault.distanceM <= NEARBY_FAULT_M) {
    parts.push(t("field.sheet.faultAhead", { distance: formatDistance(t, o.fault.distanceM) }));
  }
  if (s.activeTarget?.reasons[0]) parts.push(renderReason(s.activeTarget.reasons[0], t));
  return parts.join(" ");
}
