-- 0082_review_console_bucket.sql
--
-- Host the LuulScan Review Console (a static Vite SPA) directly on Supabase Storage,
-- so no third-party host (Vercel/Netlify) is needed. A PUBLIC bucket serves the
-- built HTML/JS/CSS at:
--   https://<project>.supabase.co/storage/v1/object/public/review-console/index.html
--
-- Public = anonymous read of the static app shell only (JS/CSS/HTML). The console
-- still requires a Supabase login and RLS for any actual data — nothing sensitive
-- lives in these files. Uploads are done out-of-band by the maintainer via
-- `supabase storage cp -r --linked ./console/dist ss:///review-console` (service/CLI),
-- never by app users, so no client insert/update policy is added.

insert into storage.buckets (id, name, public)
values ('review-console', 'review-console', true)
on conflict (id) do update set public = true;

-- ── VERIFY ── bucket exists and is public ───────────────────────────────────
--   select public from storage.buckets where id = 'review-console';  -- t

-- ── ROLLBACK ──
--   delete from storage.objects where bucket_id = 'review-console';
--   delete from storage.buckets where id = 'review-console';
