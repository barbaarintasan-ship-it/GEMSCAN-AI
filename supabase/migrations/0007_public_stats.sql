-- Public + admin stats for the "live counters" feature.
--
--  * gemscan_public_stats()  — two AGGREGATE counts safe to show publicly in the
--    mobile app footer: how many people have registered, and how many scans
--    produced a CONFIRMED valuable identification. No personal data. Callable by
--    the app directly (anon / authenticated) because it returns only totals.
--
--  * gemscan_users_list()    — the FULL registrant list (email, joined, plan,
--    scan counts) for the WordPress admin "Registered Users" page. Reads
--    auth.users, so it is NOT granted to anon/authenticated; it is reached only
--    server-to-server through the secret-protected gemscan-users Edge Function.

-- "Confirmed valuable gem" = a completed scan whose ensemble decision was
-- confident (high or medium band) and not flagged insufficient. This excludes
-- failed scans, low-confidence guesses, and "not a valuable item" results.
create or replace function public.gemscan_confirmed_gems_count()
returns bigint
language sql
security definer
set search_path = public
stable
as $$
  select count(*)
  from public.scans
  where status = 'completed'
    and confidence_band in ('high', 'medium')
    and coalesce((final_result ->> 'insufficientConfidence')::boolean, false) = false;
$$;

create or replace function public.gemscan_public_stats()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'registered_users', (select count(*) from auth.users),
    'confirmed_gems',   public.gemscan_confirmed_gems_count(),
    'generated_at',     now()
  );
$$;

-- The two aggregate counts are safe for any signed-in (or anonymous) app user.
grant execute on function public.gemscan_public_stats() to anon, authenticated;
grant execute on function public.gemscan_confirmed_gems_count() to anon, authenticated;

-- Full registrant list — admin only (service_role), never exposed to the app.
-- p_search filters by email (case-insensitive). p_limit/p_offset paginate.
create or replace function public.gemscan_users_list(
  p_limit  integer default 50,
  p_offset integer default 0,
  p_search text    default ''
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with filtered as (
    select u.id, u.email, u.created_at
    from auth.users u
    where p_search = '' or u.email ilike '%' || p_search || '%'
  ),
  page as (
    select f.*
    from filtered f
    order by f.created_at desc
    limit greatest(p_limit, 1)
    offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'users', coalesce(
      (
        select jsonb_agg(row)
        from (
          select jsonb_build_object(
            'email',      p.email,
            'created_at', p.created_at,
            'tier',       coalesce(s.tier, 'free'),
            'status',     coalesce(s.status, '—'),
            'expires',    s.current_period_end,
            'standard',   coalesce(su.standard, 0),
            'deep',       coalesce(su.deep, 0)
          ) as row
          from page p
          left join public.subscriptions s on s.user_id = p.id
          left join (
            select user_id,
                   count(*) filter (where scan_type = 'standard') as standard,
                   count(*) filter (where scan_type = 'deep')     as deep
            from public.scan_usage
            group by user_id
          ) su on su.user_id = p.id
          order by p.created_at desc
        ) t
      ),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.gemscan_users_list(integer, integer, text) from public, anon, authenticated;
