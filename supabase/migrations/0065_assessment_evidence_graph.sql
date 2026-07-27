-- 0065_assessment_evidence_graph.sql
--
-- Sprint 4.3 (GIE) S1 — the traceable evidence graph (the differentiator).
--   assessment_conclusion : each interpretation (rock type, mineralization, ore/gangue
--                           minerals, environment, deposit model, exploration significance)
--   assessment_evidence   : each gathered evidence item (field/visual/spatial/occurrence/
--                           knowledge/association/prior_sample)
--   assessment_edge       : conclusion → evidence links, with polarity + weights
--
-- INVARIANT (Principle #2): every conclusion must have ≥1 SUPPORTING edge. Enforced
-- by a DEFERRED constraint trigger so the persist path can insert conclusions then
-- edges within one transaction, but the graph can never commit with an orphan
-- conclusion — "no conclusion without traceable evidence", structurally.
--
-- geo schema, additive. RLS follows the parent assessment (can_read_assessment);
-- writes are service-role only.

-- ── conclusions ─────────────────────────────────────────────────────────────
create table if not exists geo.assessment_conclusion (
  id                uuid primary key default gen_random_uuid(),
  assessment_id     uuid not null references geo.geological_assessment(id) on delete cascade,
  kind              text not null,          -- rock_type|mineralization|ore_mineral|gangue_mineral|
                                            -- environment|deposit_model|exploration_significance
  statement         text not null,          -- English
  statement_so      text,                   -- Somali (falls back to English in the UI)
  is_interpretation boolean not null default true,   -- false ⇒ direct observation
  confidence        numeric(5,2),           -- engine-computed 0..100
  created_at        timestamptz not null default now(),
  constraint ck_conclusion_kind check (kind in
    ('rock_type','mineralization','ore_mineral','gangue_mineral',
     'environment','deposit_model','exploration_significance')),
  constraint ck_conclusion_conf check (confidence is null or (confidence >= 0 and confidence <= 100))
);
create index if not exists idx_conclusion_assessment on geo.assessment_conclusion(assessment_id);

-- ── evidence nodes ──────────────────────────────────────────────────────────
create table if not exists geo.assessment_evidence (
  id             uuid primary key default gen_random_uuid(),
  assessment_id  uuid not null references geo.geological_assessment(id) on delete cascade,
  source         text not null,            -- provider/table the item came from
  ev_type        text not null,            -- field|visual|spatial|occurrence|knowledge|association|prior_sample
  statement      text not null,            -- English
  statement_so   text,                     -- Somali (falls back to English in the UI)
  is_observation boolean not null default false,  -- true ⇒ fact, false ⇒ derived/inferred
  tier           text,                     -- evidence_tier code (drives weighting)
  quality        numeric(6,4),             -- 0..1 item quality
  dataset_id     uuid,                     -- geo.dataset_registry.id when known (no FK: may be external)
  provenance     jsonb,
  created_at     timestamptz not null default now(),
  constraint ck_evidence_type check (ev_type in
    ('field','visual','spatial','occurrence','knowledge','association','prior_sample')),
  constraint ck_evidence_quality check (quality is null or (quality >= 0 and quality <= 1))
);
create index if not exists idx_evidence_assessment on geo.assessment_evidence(assessment_id);

-- ── edges (conclusion → evidence) ───────────────────────────────────────────
create table if not exists geo.assessment_edge (
  id               uuid primary key default gen_random_uuid(),
  assessment_id    uuid not null references geo.geological_assessment(id) on delete cascade,
  conclusion_id    uuid not null references geo.assessment_conclusion(id) on delete cascade,
  evidence_id      uuid not null references geo.assessment_evidence(id) on delete cascade,
  polarity         text not null default 'supporting',   -- supporting|contradicting
  contribution     numeric(6,4) not null,                -- 0..1 AI-asserted relevance
  effective_weight numeric(6,4),                          -- engine: contribution × tier_weight × quality
  created_at       timestamptz not null default now(),
  constraint ck_edge_polarity check (polarity in ('supporting','contradicting')),
  constraint ck_edge_contribution check (contribution >= 0 and contribution <= 1),
  constraint ck_edge_weight check (effective_weight is null or (effective_weight >= 0 and effective_weight <= 1)),
  unique (conclusion_id, evidence_id, polarity)
);
create index if not exists idx_edge_assessment on geo.assessment_edge(assessment_id);
create index if not exists idx_edge_conclusion on geo.assessment_edge(conclusion_id);
create index if not exists idx_edge_evidence on geo.assessment_edge(evidence_id);

-- ── INVARIANT: every conclusion has ≥1 supporting edge (checked at commit) ───
create or replace function geo.assert_conclusion_has_evidence()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from geo.assessment_edge e
    where e.conclusion_id = new.id and e.polarity = 'supporting'
  ) then
    raise exception 'conclusion % has no supporting evidence (traceability invariant)', new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_conclusion_has_evidence on geo.assessment_conclusion;
create constraint trigger trg_conclusion_has_evidence
  after insert on geo.assessment_conclusion
  deferrable initially deferred
  for each row execute function geo.assert_conclusion_has_evidence();

-- ── RLS (follows the parent assessment) ─────────────────────────────────────
alter table geo.assessment_conclusion enable row level security;
alter table geo.assessment_evidence   enable row level security;
alter table geo.assessment_edge       enable row level security;

drop policy if exists assessment_conclusion_select on geo.assessment_conclusion;
create policy assessment_conclusion_select on geo.assessment_conclusion for select to authenticated
  using (geo.can_read_assessment(assessment_id));

drop policy if exists assessment_evidence_select on geo.assessment_evidence;
create policy assessment_evidence_select on geo.assessment_evidence for select to authenticated
  using (geo.can_read_assessment(assessment_id));

drop policy if exists assessment_edge_select on geo.assessment_edge;
create policy assessment_edge_select on geo.assessment_edge for select to authenticated
  using (geo.can_read_assessment(assessment_id));

grant select on geo.assessment_conclusion, geo.assessment_evidence, geo.assessment_edge to authenticated;
grant select, insert on geo.assessment_conclusion, geo.assessment_evidence, geo.assessment_edge to service_role;

-- ── VERIFY — expect the invariant to fire ───────────────────────────────────
--   begin;
--     insert into geo.geological_assessment(id,sample_id,engine_version) values
--       ('00000000-0000-0000-0000-0000000000aa', <a real sample id>, 'test');
--     insert into geo.assessment_conclusion(id,assessment_id,kind,statement) values
--       ('00000000-0000-0000-0000-0000000000bb','00000000-0000-0000-0000-0000000000aa','rock_type','x');
--   commit;   -- expect: ERROR … has no supporting evidence (invariant works)

-- ── ROLLBACK ──
--   drop table if exists geo.assessment_edge, geo.assessment_evidence, geo.assessment_conclusion cascade;
--   drop function if exists geo.assert_conclusion_has_evidence();
