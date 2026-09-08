-- 0109_geo_knowledge_rule_add_strong_hosts.sql
--
-- Luul Scan — three additional host_rock → commodity knowledge rules for the
-- EMIE GeologicalKnowledgeProvider (geo.geo_knowledge_rule, first seeded in 0087).
--
-- These fill three genuine coverage holes found by a gap analysis against
-- geo.commodity_profile.typical_host_rocks. Each is a textbook PRIMARY host that
-- was missing, and each commodity previously had NO host_rock rule at all:
--
--   lamproite  → diamond      primary diamond host, like kimberlite (Argyle)
--   sandstone  → uranium      roll-front sandstone-hosted U — a major U class
--   pegmatite  → tourmaline   gem elbaite/rubellite in evolved (LCT) pegmatites
--
-- WHY THIS TABLE (and not geo.mineral_association): geo.geo_knowledge_rule is the
-- table the LIVE GeologicalKnowledgeProvider actually reads — via the
-- geo.knowledge_rules_for RPC on the server and the offline PackGateway on the
-- device. geo.mineral_association is wired to no provider and is deliberately
-- left untouched here.
--
-- Additive and idempotent. No schema change, no scoring/weight-mechanism change,
-- no commodity_profile change. antecedent_key values are lowercase single tokens
-- that match the existing rule vocabulary AND the production rock-family
-- normalization (mobile/lib/geo/commodityModel.ts recognises lamproite,
-- sandstone and pegmatite). Weights sit within the existing "common" band
-- (0.35–0.42) alongside their sibling rules; requires_setting is descriptive
-- metadata only (it does not gate firing).

insert into geo.geo_knowledge_rule
  (antecedent_type, antecedent_key, commodity_code, expected_minerals, relationship, likelihood, requires_setting, weight) values

-- Lamproite (primary diamond host — the missing twin of kimberlite)
('host_rock','lamproite','diamond','{diamond,pyrope garnet,chromite,olivine}',
 'Lamproite is a rare potassic, mantle-derived volcanic rock that, like kimberlite, can carry diamond to the surface — the Argyle lamproite in Australia was for years the world''s largest diamond producer by volume.','common','{craton,precambrian_basement}',0.40),

-- Sandstone (roll-front uranium — a major, low-cost uranium deposit class)
('host_rock','sandstone','uranium','{uraninite,coffinite,carnotite}',
 'Sandstone-hosted (roll-front) uranium precipitates where oxidised, uranium-bearing groundwater meets a reducing zone in permeable continental sandstone — one of the world''s largest and lowest-cost uranium deposit classes.','common','{intracontinental_basin}',0.36),

-- Pegmatite (gem tourmaline — co-located with the existing Li/Ta pegmatite rules)
('host_rock','pegmatite','tourmaline','{tourmaline,elbaite,rubellite}',
 'Highly evolved (LCT) pegmatites host gem tourmaline (elbaite, rubellite) alongside their lithium and tantalum, so zoned pegmatites are a target for coloured gem tourmaline as well as rare metals.','common','{craton_margin,collisional_orogen}',0.36)

on conflict (antecedent_type, antecedent_key, commodity_code, relationship) do nothing;
