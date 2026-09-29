// Deep Scan credit accounting — shared by orchestrate-scan (enforce + consume)
// and verify-subscription (report balance to the app). All functions take a
// service-role Supabase client; nothing here trusts client input.
//
// Two credit sources, spent in this order:
//   1. Subscription allowance — deepScanAllowance included per billing period,
//      resets each period. "Used" is counted from scan_usage (credits_used = 0).
//   2. Purchased credits — deep_scan_credits.purchased_balance, roll over,
//      spent atomically via consume_purchased_deep_scan_credit().
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type DeepScanStatus = {
  allowance: number; // included per period for this tier (owner = very large)
  used: number; // allowance-covered Deep Scans this period
  allowanceRemaining: number;
  purchased: number; // rolled-over purchased credits
  remaining: number; // allowanceRemaining + purchased
};

/** The subscription period start to count allowance against (fallback: 180d). */
export function periodStartFor(
  sub: { current_period_start?: string | null } | null | undefined,
): string {
  if (sub?.current_period_start) return sub.current_period_start;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 180); // 6-month plans → 180-day rolling window.
  return d.toISOString();
}

/** Read the caller's current Deep Scan balance (no mutation). */
export async function getDeepScanStatus(
  client: SupabaseClient,
  userId: string,
  allowance: number,
  periodStartISO: string,
): Promise<DeepScanStatus> {
  const { count } = await client
    .from("scan_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("scan_type", "deep")
    .eq("credits_used", 0)
    .gte("created_at", periodStartISO);

  const used = count ?? 0;
  const allowanceRemaining = Math.max(0, allowance - used);

  const { data: cr } = await client
    .from("deep_scan_credits")
    .select("purchased_balance")
    .eq("user_id", userId)
    .maybeSingle();
  const purchased = (cr?.purchased_balance as number | undefined) ?? 0;

  return {
    allowance,
    used,
    allowanceRemaining,
    purchased,
    remaining: allowanceRemaining + purchased,
  };
}

/**
 * Consume one Deep Scan credit and record the scan in scan_usage. Allowance is
 * spent before purchased credits. Returns the source used, or null when there
 * was nothing to spend (caller must NOT run the ensemble in that case).
 */
export async function consumeDeepScan(
  client: SupabaseClient,
  args: {
    userId: string;
    scanId: string;
    plan: string;
    periodStartISO: string;
    status: DeepScanStatus;
    aiModels: string[];
  },
): Promise<"allowance" | "purchase" | null> {
  const { userId, scanId, plan, periodStartISO, status, aiModels } = args;

  let source: "allowance" | "purchase";
  if (status.allowanceRemaining > 0) {
    source = "allowance";
  } else {
    // Spend a purchased credit atomically; -1 means none were left.
    const { data: newBalance, error } = await client.rpc(
      "consume_purchased_deep_scan_credit",
      { p_user_id: userId },
    );
    if (error || typeof newBalance !== "number" || newBalance < 0) {
      return null;
    }
    source = "purchase";
  }

  await client.from("scan_usage").insert({
    user_id: userId,
    scan_id: scanId,
    scan_type: "deep",
    ai_models_used: aiModels,
    credits_used: source === "purchase" ? 1 : 0,
    subscription_plan: plan,
    period_start: periodStartISO,
  });

  return source;
}

export type StandardScanVerdict = {
  allowed: boolean; // false => caller must block the scan (limit reached)
  used: number; // scans counted against the window AFTER this call
  remaining: number | null; // null when the limit is unlimited
  alreadyCounted: boolean; // true => this scanId was already recorded (a retry)
};

/**
 * Atomically enforce AND record ONE Standard (single-model) scan against the
 * free-tier lifetime cap (or a paid daily cap). Delegates to the
 * consume_standard_scan SQL function so the count check and the usage insert
 * happen in a single per-user-serialized transaction — concurrent scans can
 * never both slip past the cap, and a retried request (same scanId) is
 * idempotent (counted once). Standard scans never spend credits.
 *
 * The caller blocks the scan when `allowed` is false. Reuses the existing
 * scan_usage ledger — there is no separate counter.
 */
export async function consumeStandardScan(
  client: SupabaseClient,
  args: {
    userId: string;
    scanId: string;
    plan: string;
    limit: number | null; // null = unlimited (abuse guard disabled)
    lifetime: boolean; // true = all-time window; false = per-UTC-day
    aiModels?: string[];
  },
): Promise<StandardScanVerdict> {
  const { data, error } = await client.rpc("consume_standard_scan", {
    p_user_id: args.userId,
    p_scan_id: args.scanId,
    p_limit: args.limit,
    p_lifetime: args.lifetime,
    p_plan: args.plan,
    p_ai_models: args.aiModels ?? ["gemini"],
  });
  if (error) throw new Error(`consume_standard_scan failed: ${error.message}`);
  // A set-returning function comes back as an array of rows via PostgREST.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed: boolean; used: number; remaining: number | null; already_counted: boolean }
    | undefined;
  if (!row) throw new Error("consume_standard_scan returned no row");
  return {
    allowed: row.allowed,
    used: row.used,
    remaining: row.remaining ?? null,
    alreadyCounted: row.already_counted,
  };
}

/**
 * Best-effort compensating refund: remove the standard usage row that
 * consumeStandardScan reserved for a scan that then FAILED, so a failed scan
 * does not consume the lifetime allowance. Only call this when THIS request
 * inserted the row (verdict.alreadyCounted === false) — never delete a row a
 * prior successful scan created. Swallows its own errors: a lingering row
 * over-counts by one at worst, and never under-counts to give away a free scan.
 */
export async function refundStandardScan(
  client: SupabaseClient,
  args: { userId: string; scanId: string },
): Promise<void> {
  try {
    await client
      .from("scan_usage")
      .delete()
      .eq("user_id", args.userId)
      .eq("scan_id", args.scanId)
      .eq("scan_type", "standard");
  } catch {
    /* best-effort */
  }
}
