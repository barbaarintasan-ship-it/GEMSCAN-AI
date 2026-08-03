-- 0087_geo_knowledge_rule.sql
--
-- EMIE — the rock/lithology/deposit → commodity knowledge rules. Each row says
-- "this kind of rock/environment commonly carries these commodities/minerals, and
-- HERE IS WHY", with an honesty-preserving likelihood (diagnostic|common|possible|
-- rare) and the tectonic settings that would CORROBORATE it. The Geological
-- Interpretation Layer turns these into clear, educational explanations; the engine
-- keeps them as weak evidence (tier knowledge_kb) so they enrich reasoning without
-- ever, alone, producing high confidence.

create table if not exists geo.geo_knowledge_rule (
  id                uuid primary key default gen_random_uuid(),
  antecedent_type   text not null,   -- host_rock | lithology | deposit_type | age | alteration
  antecedent_key    text not null,   -- e.g. 'kimberlite','pegmatite','skarn'
  commodity_code    text references geo.commodity_profile(code),
  expected_minerals text[] not null default '{}',
  relationship      text not null,   -- the "WHY" — an educational, evidence-based sentence
  likelihood        text not null default 'possible'
                    check (likelihood in ('diagnostic','common','possible','rare')),
  requires_setting  text[] not null default '{}',
  weight            numeric(3,2) not null default 0.35,
  created_at        timestamptz not null default now(),
  unique (antecedent_type, antecedent_key, commodity_code, relationship)
);
create index if not exists idx_geo_knowledge_rule_key on geo.geo_knowledge_rule (antecedent_type, antecedent_key);

alter table geo.geo_knowledge_rule enable row level security;
grant select on geo.geo_knowledge_rule to service_role;

-- Chromium is referenced below but was not in the 0086 seed — add it (idempotent).
insert into geo.commodity_profile
  (code, name, category, industrial_uses, is_critical_mineral, strategic_importance, confidence_limitations) values
('chromium','Chromium','critical','{stainless steel,superalloys,plating,refractories}', true,
 'Chromium is essential to stainless steel and superalloys and is a useful pathfinder for platinum-group metals.',
 'Chromium is confirmed by assay of chromite; the ultramafic host and chromite layers are the geological cue.')
on conflict (code) do nothing;

-- ── SEED — headline economic rock types ─────────────────────────────────────
insert into geo.geo_knowledge_rule
  (antecedent_type, antecedent_key, commodity_code, expected_minerals, relationship, likelihood, requires_setting, weight) values

-- Kimberlite
('host_rock','kimberlite','diamond','{diamond,pyrope garnet,chrome diopside,chromite,ilmenite,olivine}',
 'Kimberlite is a deep-mantle volcanic rock that can carry diamond and mantle indicator minerals to surface, which is why it is the world''s primary diamond source.','common','{craton,precambrian_basement}',0.40),
('host_rock','kimberlite',null,'{pyrope garnet,chrome diopside,chromite,ilmenite}',
 'Mantle indicator minerals (pyrope garnet, chrome diopside, chromite, ilmenite) survive in the soil around kimberlite and are what geologists pan for to trace a pipe.','common','{craton}',0.40),

-- Pegmatite
('host_rock','pegmatite','lithium','{spodumene,lepidolite,petalite,tourmaline}',
 'Highly evolved (LCT) pegmatites concentrate lithium in spodumene and lepidolite, making zoned pegmatites a prime lithium target.','common','{craton_margin,collisional_orogen}',0.38),
('host_rock','pegmatite','tantalum','{tantalite,columbite,cassiterite}',
 'The same evolved pegmatites that carry lithium often host tantalum-niobium oxides (columbite-tantalite) and tin.','common','{craton_margin}',0.36),
('host_rock','pegmatite','beryllium','{beryl,aquamarine}',
 'Beryllium crystallises as beryl (including aquamarine) in pegmatites, a classic rare-metal and gem indicator.','common','{craton_margin}',0.35),

-- Carbonatite
('host_rock','carbonatite','ree','{bastnaesite,monazite,apatite,fluorite}',
 'Carbonatites are the dominant source of rare earth elements, concentrated in bastnaesite, monazite and apatite within the complex.','common','{intracontinental_rift}',0.42),
('host_rock','carbonatite','niobium','{pyrochlore,apatite}',
 'Carbonatites also host most of the world''s niobium as pyrochlore, alongside phosphate and fluorite.','common','{intracontinental_rift}',0.40),

-- Skarn
('host_rock','skarn','tungsten','{scheelite,garnet,pyroxene}',
 'Where intrusions bake carbonate rocks, calc-silicate skarns form and can concentrate tungsten (scheelite), which fluoresces blue under UV.','common','{continental_arc}',0.38),
('host_rock','skarn','copper','{chalcopyrite,bornite,garnet,magnetite}',
 'Skarns around fertile intrusions frequently carry copper (and iron), making the intrusive contact a key place to sample.','common','{continental_arc}',0.36),
('deposit_type','skarn','iron','{magnetite,hematite,garnet}',
 'Iron-rich skarns (magnetite) form at intrusive-carbonate contacts and are a recognised iron source.','possible','{}',0.33),

-- Greisen
('host_rock','greisen','tin','{cassiterite,wolframite,topaz,tourmaline}',
 'Greisen is altered granite where hot fluids concentrated tin (cassiterite) and tungsten (wolframite) — a classic Sn-W setting.','common','{collisional_orogen}',0.38),
('host_rock','greisen','tungsten','{wolframite,scheelite,quartz}',
 'Tungsten (wolframite/scheelite) is commonly enriched with tin in greisen-veined granite cupolas.','common','{collisional_orogen}',0.36),

-- Serpentinite / ultramafic
('host_rock','serpentinite','nickel','{pentlandite,garnierite,magnetite}',
 'Serpentinised ultramafic rock can host nickel — as magmatic sulphide at depth or green garnierite in tropical laterite above it.','possible','{ophiolite,craton}',0.34),
('host_rock','serpentinite','pgm','{chromite,platinum}',
 'Ultramafic bodies and their chromitites are a recognised setting for platinum-group metals.','possible','{craton}',0.32),
('host_rock','ultramafic','nickel','{pentlandite,pyrrhotite,chromite}',
 'Ultramafic rocks (komatiite, dunite, peridotite) are the primary hosts for magmatic nickel-copper-PGE sulphide systems.','common','{craton,large_igneous_province}',0.36),
('host_rock','ultramafic','chromium','{chromite}',
 'Chromite layers in ultramafic rocks are the main source of chromium and a pathfinder for PGE.','common','{ophiolite,craton}',0.34),

-- Banded iron formation
('host_rock','banded iron formation','iron','{hematite,magnetite,goethite}',
 'Banded iron formation (BIF) is the world''s main iron source; supergene weathering upgrades it to high-grade hematite ore.','diagnostic','{craton}',0.45),
('host_rock','banded iron formation','gold','{pyrite,quartz,arsenopyrite}',
 'In some greenstone belts, BIF units are chemically favourable traps that host orogenic gold along structures.','possible','{greenstone_belt}',0.33),

-- Quartz veins
('host_rock','quartz vein','gold','{pyrite,arsenopyrite,quartz,visible gold}',
 'Quartz veins within shear zones are the classic setting for orogenic gold, especially where sulphides like pyrite and arsenopyrite are present.','common','{greenstone_belt,accretionary_orogen}',0.36),

-- Granite
('host_rock','granite','tin','{cassiterite,tourmaline,topaz}',
 'Evolved (S-type) granites can concentrate tin, tungsten and rare metals in their cupolas and greisen zones.','possible','{collisional_orogen}',0.30),
('host_rock','granite','lithium','{spodumene,lepidolite}',
 'Some fractionated granites grade into lithium-tantalum pegmatites — worth checking the granite margins.','possible','{craton_margin}',0.28),

-- Marble
('host_rock','marble','corundum','{corundum,spinel,graphite}',
 'Marble can host ruby (corundum) where aluminous, chromium-bearing fluids interacted during metamorphism.','possible','{collisional_orogen}',0.30),
('host_rock','marble','graphite','{graphite,calcite}',
 'High-grade metamorphosed carbonates and associated gneisses can host flake graphite.','possible','{high_grade_metamorphic}',0.30),

-- Gabbro / mafic layered intrusion
('host_rock','gabbro','pgm','{chromite,pentlandite,chalcopyrite}',
 'Layered mafic intrusions (gabbro) host reef-style platinum-group-metal and nickel-copper sulphide mineralisation.','possible','{craton,large_igneous_province}',0.32),
('host_rock','gabbro','vanadium','{titanomagnetite,magnetite}',
 'Titaniferous magnetite layers in mafic intrusions carry vanadium and titanium.','possible','{large_igneous_province}',0.30),

-- Laterite
('host_rock','laterite','nickel','{garnierite,goethite}',
 'Deep tropical weathering of ultramafic rock forms nickel laterite, with green garnierite marking the richest zones.','possible','{tropical_weathering}',0.32),
('host_rock','laterite','cobalt','{asbolane,goethite}',
 'Nickel laterites commonly carry cobalt in their manganese-oxide layers.','possible','{tropical_weathering}',0.30);

-- ── VERIFY ── expect ~28 rules across the headline rock types ───────────────
--   select count(*) from geo.geo_knowledge_rule;

-- ── ROLLBACK ──
--   drop table if exists geo.geo_knowledge_rule;
