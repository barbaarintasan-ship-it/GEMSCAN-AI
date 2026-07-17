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

/** Record a Standard (single-model) scan. Standard scans never spend credits. */
export async function recordStandardScan(
  client: SupabaseClient,
  args: { userId: string; scanId: string; plan: string; aiModels: string[] },
): Promise<void> {
  await client.from("scan_usage").insert({
    user_id: args.userId,
    scan_id: args.scanId,
    scan_type: "standard",
    ai_models_used: args.aiModels,
    credits_used: 0,
    subscription_plan: args.plan,
  });
}
