-- 0154_area_spectral_index_band_means.sql
--
-- Issue 2 (2026-09-24 audit) — store the raw B04/B02 band means alongside
-- the ratio, not just the computed ratio's own mean. No AOI/quota/cloud-
-- masking change: the evalscript already reads B04/B02 as INPUT bands to
-- compute the ratio; this just also emits them as two extra OUTPUT bands in
-- the SAME single Statistics API call — handler.ts's own header note has the
-- full detail.

alter table enterprise.area_spectral_index
  add column if not exists b04_mean numeric,
  add column if not exists b02_mean numeric;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--     where table_schema='enterprise' and table_name='area_spectral_index'
--       and column_name in ('b04_mean','b02_mean');  -- expect 2 rows

-- ── ROLLBACK (down-path) ────────────────────────────────────────────────────
--   alter table enterprise.area_spectral_index drop column if exists b04_mean, drop column if exists b02_mean;
