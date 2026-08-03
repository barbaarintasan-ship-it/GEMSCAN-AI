-- 0088_mineral_assemblage_rule.sql
--
-- EMIE — mineral ASSEMBLAGE → interpreted geological system/process. This upgrades
-- the old simple rock→mineral mapping to true geological associations: a co-occurring
-- mineral set implies a process (e.g. quartz + arsenopyrite → a possible gold-bearing
-- hydrothermal system). Read by the expanded Mineral Association Provider. Weak
-- evidence (tier knowledge_kb); it never asserts certainty.

create table if not exists geo.mineral_assemblage_rule (
  id             uuid primary key default gen_random_uuid(),
  minerals       text[] not null,        -- co-occurring set (order-independent; subset match)
  interpretation text not null,          -- the interpreted system/process
  commodity_code text references geo.commodity_profile(code),
  likelihood     text not null default 'possible'
                 check (likelihood in ('diagnostic','common','possible','indicative')),
  relationship   text not null,          -- the "WHY"
  weight         numeric(3,2) not null default 0.35,
  created_at     timestamptz not null default now()
);
create index if not exists idx_assemblage_minerals on geo.mineral_assemblage_rule using gin (minerals);

alter table geo.mineral_assemblage_rule enable row level security;
grant select on geo.mineral_assemblage_rule to service_role;

-- ── SEED ────────────────────────────────────────────────────────────────────
insert into geo.mineral_assemblage_rule
  (minerals, interpretation, commodity_code, likelihood, relationship, weight) values

('{quartz,pyrite}','Hydrothermal system', null, 'common',
 'Quartz with pyrite indicates hot fluids moved through the rock — a hydrothermal system that is worth examining for metals.',0.34),
('{quartz,arsenopyrite}','Possible gold-bearing hydrothermal system','gold','possible',
 'Arsenopyrite with quartz is a well-known pathfinder for orogenic gold; gold often sits with or near arsenopyrite.',0.36),
('{quartz,galena,sphalerite}','Polymetallic (Pb-Zn-Ag) vein system','silver','possible',
 'Galena and sphalerite in quartz point to a lead-zinc-silver vein system.',0.34),
('{malachite,azurite}','Oxidised copper system','copper','common',
 'Green malachite and blue azurite are the oxidised cap of a copper system — follow it down to primary chalcopyrite.',0.36),
('{chalcopyrite,bornite}','Copper sulphide mineralisation','copper','common',
 'Chalcopyrite with bornite indicates primary copper sulphide mineralisation, typical of porphyry and skarn systems.',0.35),
('{chromite,olivine}','Ultramafic (Ni-PGE-Cr) system','pgm','possible',
 'Chromite with olivine marks an ultramafic body — a setting for chromium, nickel and platinum-group metals.',0.33),
('{garnet,pyroxene}','Skarn (contact-metasomatic) system','tungsten','possible',
 'Calc-silicate garnet and pyroxene indicate a skarn at an intrusive-carbonate contact, which may host tungsten, copper or iron.',0.32),
('{cassiterite,tourmaline}','Greisen / evolved-granite tin system','tin','possible',
 'Cassiterite with tourmaline signals a greisen or evolved-granite system carrying tin (and often tungsten).',0.34),
('{pyrope garnet,chrome diopside}','Kimberlite indicator suite','diamond','indicative',
 'Pyrope garnet with chrome diopside is the classic mantle-indicator suite geologists use to trace kimberlite and diamond potential.',0.36),
('{spodumene,lepidolite}','LCT pegmatite (lithium) system','lithium','common',
 'Spodumene with lepidolite is diagnostic of a lithium-rich (LCT) pegmatite.',0.38),
('{bastnaesite,monazite}','Carbonatite / REE system','ree','common',
 'Bastnaesite and monazite together indicate rare-earth mineralisation, typically in a carbonatite or alkaline complex.',0.36),
('{scheelite,quartz}','Tungsten vein/skarn system','tungsten','possible',
 'Scheelite in quartz (fluorescing blue under UV) indicates a tungsten-bearing vein or skarn.',0.34);

-- ── VERIFY ── expect ~12 assemblage rules ───────────────────────────────────
--   select count(*) from geo.mineral_assemblage_rule;

-- ── ROLLBACK ──
--   drop table if exists geo.mineral_assemblage_rule;
