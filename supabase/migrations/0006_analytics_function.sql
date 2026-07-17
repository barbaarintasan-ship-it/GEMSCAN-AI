-- Analytics aggregation for the WordPress dashboard. One server-side function
-- returns every USAGE / subscription / credit metric as a single JSON blob, so
-- the website makes ONE secret-authenticated call (via the gemscan-analytics
-- Edge Function) instead of many, and all the heavy GROUP BY work happens in
-- Postgres. Revenue & expenses are NOT here — those live in WordPress
-- (gemscan_revenue / gemscan_ledger).
create or replace function public.gemscan_analytics()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'generated_at', now(),

    'subscriptions', (
      select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (
          where status = 'active' and (current_period_end is null or current_period_end >= now())
        ),
        'expired', count(*) filter (
          where status <> 'active' or (current_period_end is not null and current_period_end < now())
        ),
        'premium', count(*) filter (where tier = 'premium' and status = 'active'),
        'professional', count(*) filter (where tier = 'professional' and status = 'active')
      )
      from public.subscriptions
    ),

    'scans', (
      select jsonb_build_object(
        'standard_total', count(*) filter (where scan_type = 'standard'),
        'deep_total', count(*) filter (where scan_type = 'deep'),
        'standard_today', count(*) filter (where scan_type = 'standard' and created_at >= date_trunc('day', now())),
        'deep_today', count(*) filter (where scan_type = 'deep' and created_at >= date_trunc('day', now())),
        'standard_month', count(*) filter (where scan_type = 'standard' and created_at >= date_trunc('month', now())),
        'deep_month', count(*) filter (where scan_type = 'deep' and created_at >= date_trunc('month', now())),
        'distinct_users', count(distinct user_id)
      )
      from public.scan_usage
    ),

    'credits', (
      select jsonb_build_object(
        'remaining_total', coalesce((select sum(purchased_balance) from public.deep_scan_credits), 0),
        'consumed_purchased', (select count(*) from public.scan_usage where scan_type = 'deep' and credits_used = 1),
        'consumed_allowance', (select count(*) from public.scan_usage where scan_type = 'deep' and credits_used = 0)
      )
    ),

    -- Top 20 most active users (by total scans), with per-type breakdown so the
    -- dashboard can also show per-user AI cost.
    'top_users', (
      select coalesce(jsonb_agg(t), '[]'::jsonb)
      from (
        select u.email,
               count(*) filter (where su.scan_type = 'standard') as standard,
               count(*) filter (where su.scan_type = 'deep') as deep,
               count(*) as total
        from public.scan_usage su
        join auth.users u on u.id = su.user_id
        group by u.email
        order by total desc
        limit 20
      ) t
    ),

    -- Scans grouped by the plan recorded at scan time (for per-plan AI cost).
    'by_plan', (
      select coalesce(jsonb_object_agg(plan, counts), '{}'::jsonb)
      from (
        select subscription_plan as plan,
               jsonb_build_object(
                 'standard', count(*) filter (where scan_type = 'standard'),
                 'deep', count(*) filter (where scan_type = 'deep')
               ) as counts
        from public.scan_usage
        group by subscription_plan
      ) x
    )
  );
$$;

revoke all on function public.gemscan_analytics() from public, anon, authenticated;
