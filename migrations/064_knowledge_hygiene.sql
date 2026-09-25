-- ===========================================================================
-- 064: knowledge hygiene — provenance, sweep-proof recall, length-fair ranking
--      (CAIRN-289)
--
-- Measured by the CAIRN-282 audit over the live store (425 rows):
--
--   * 0 rows carry source_session_id or source_task_id. The CLI already sends
--     the session on every request (X-Cairn-Session); nothing stored it.
--   * 1,169 of 1,243 knowledge_reads came from audit loops reading 10-141
--     distinct slugs a minute, and every one marked its entry as recalled
--     (062), so 370 of 424 entries looked used and `know --unused` could not
--     find the ~211 nobody has ever been given.
--   * 11 imported entries over 5k tokens (2.6% of the store) took 28% of the
--     knowledge result slots, because ts_rank without normalisation rewards a
--     long body for containing every word somewhere.
--
-- Four parts, one file, all in the migration runner's transaction.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Provenance: the session as its runtime named it.
--
-- knowledge.source_session_id references sessions(id), and a sessions row is
-- normally written at session END — after the fact was learned. So the
-- foreign key is filled when the row already exists and otherwise stays null,
-- and the external id is kept beside it for readers to resolve through
-- sessions.external_id once the session has ended.
--
-- Resolving it later by updating knowledge is deliberately not done: every
-- UPDATE of a knowledge row fires knowledge_touch (013) and would stamp the
-- fact as just edited, reorder every updated_at list and put a fabricated edit
-- in the activity feed — the failure 062's header describes for recall.
-- ---------------------------------------------------------------------------

alter table knowledge add column if not exists source_session_ref text;

comment on column knowledge.source_session_ref is
  'The session that wrote this entry, as its runtime named it (X-Cairn-Session). '
  'source_session_id is filled only when that session''s row already existed; '
  'otherwise resolve this through sessions.external_id.';

-- sessions_external_idx leads with platform_source, which the header does
-- not carry; this is the lookup that resolves a ref without it.
create index if not exists sessions_external_id_idx on sessions (external_id);

alter table knowledge_revisions add column if not exists edited_session text;

comment on column knowledge_revisions.edited_session is
  'The session that made the edit which replaced this version, when the caller named one.';

-- ---------------------------------------------------------------------------
-- 2. Sweeps are reads, not recalls.
--
-- Kept as rows — a sweep is still something that happened — and tagged so
-- that nothing counting recall counts them. Two ways in:
--   * declared: the CLI sends X-Cairn-Read: sweep (`know --sweep`,
--     CAIRN_SWEEP=1) and the API writes sweep = true;
--   * inferred: the audit loops declared nothing, so a read is also a sweep
--     when the same actor has already read 9 OTHER slugs in the last minute.
--     Organic use measured at most a handful a minute; the loops ran 10-141.
--     The first nine reads of an undeclared burst still count — a live read
--     cannot know the burst is coming — which bounds the leak at nine
--     entries per burst instead of all of them. History is tagged whole (4).
-- ---------------------------------------------------------------------------

alter table knowledge_reads add column if not exists sweep boolean not null default false;

comment on column knowledge_reads.sweep is
  'Part of a bulk read (declared by the caller, or 10+ distinct slugs by one actor within a minute). '
  'Kept for the record; excluded from recall counts and knowledge_recall_state.';

create or replace function knowledge_reads_tag_sweep() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not new.sweep and (
    select count(distinct r.slug)
      from knowledge_reads r
     where r.owner_user_id = new.owner_user_id
       and r.actor_id = new.actor_id
       and r.created_at > new.created_at - interval '1 minute'
       and r.created_at <= new.created_at
       and r.slug <> new.slug
  ) >= 9 then
    new.sweep := true;
  end if;
  return new;
end;
$$;

drop trigger if exists knowledge_reads_tag_sweep on knowledge_reads;
create trigger knowledge_reads_tag_sweep
  before insert on knowledge_reads
  for each row execute function knowledge_reads_tag_sweep();

-- From 062, the only definition, plus `not new.sweep`. The AFTER trigger sees
-- the value the BEFORE trigger settled on.
create or replace function knowledge_touch_recalled_from_read() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.hit and not new.sweep then
    perform knowledge_mark_recalled(
      array(select k.id from knowledge k where k.slug = replace(lower(btrim(new.slug)), '_', '-')),
      new.created_at);
  end if;
  return null;
end;
$$;

-- From 061, the only definition, plus `and not r.sweep` in the reads CTE.
create or replace function knowledge_recall_counts(p_since timestamptz, p_ids uuid[] default null)
returns table (
  knowledge_id    uuid,
  returned        integer,
  read            integer,
  last_recalled   timestamptz
)
language sql
stable
set search_path = public
as $$
  with wanted as (
    select k.id, k.slug from knowledge k
     where p_ids is null or k.id = any (p_ids)
  ),
  returned as (
    select w.id, count(*)::int as n, max(e.created_at) as last_at
      from search_events e
      cross join lateral unnest(e.returned_slugs) as s(slug)
      join wanted w on w.slug = s.slug
     where e.created_at >= p_since
     group by w.id
  ),
  reads as (
    select w.id, count(*)::int as n, max(r.created_at) as last_at
      from knowledge_reads r
      join wanted w on w.slug = replace(lower(btrim(r.slug)), '_', '-')
     where r.hit and not r.sweep and r.created_at >= p_since
     group by w.id
  )
  select w.id,
         coalesce(rt.n, 0),
         coalesce(rd.n, 0),
         greatest(rt.last_at, rd.last_at)
    from wanted w
    left join returned rt on rt.id = w.id
    left join reads rd on rd.id = w.id
$$;

comment on function knowledge_recall_counts(timestamptz, uuid[]) is
  'Per entry since p_since: how many searches returned it, how many direct reads fetched it (sweeps excluded, 064), and when it was last recalled either way. The session briefing and cairn recall are not counted — they record nothing.';

-- ---------------------------------------------------------------------------
-- 3. History: tag the sweeps already recorded, then recompute recall state.
--
-- Symmetric window for the past, because here the whole burst is visible:
-- a read is a sweep when its actor read 10+ distinct slugs within a minute
-- either side of it. knowledge_reads carries no touch trigger and its only
-- other trigger fires on insert, so this rewrites nothing else.
--
-- knowledge_recall_state is derived data (062) that only ever moves forward,
-- so it cannot un-count a sweep in place. It is rebuilt from the same
-- function it was first built from, which now leaves sweeps out.
-- ---------------------------------------------------------------------------

update knowledge_reads r
   set sweep = true
 where not r.sweep
   and (
     select count(distinct r2.slug)
       from knowledge_reads r2
      where r2.owner_user_id = r.owner_user_id
        and r2.actor_id = r.actor_id
        and r2.created_at between r.created_at - interval '1 minute'
                              and r.created_at + interval '1 minute'
   ) >= 10;

delete from knowledge_recall_state;
select knowledge_recall_state_backfill();

-- ---------------------------------------------------------------------------
-- 4. Ranking stops rewarding length.
--
-- ts_rank(vec, q) with no normalisation grows with how often the terms occur,
-- so an 11k-token import that mentions everything outranks the short entry
-- that answers the question. Normalisation 1 divides by 1 + log(document
-- length) — gentle, a long body still wins when it is genuinely denser — and
-- 32 maps the result into [0,1) without changing order. Applied to every
-- kind and to both arms, so the merge stays one ordering (055's invariant):
-- normalising knowledge alone would demote every fact below every task.
--
-- TRANSFORMED, NOT RE-COPIED, as 055 was: this edits the definition actually
-- installed (038, as 048 and 055 left it), and each anchor must appear exactly
-- twice — once in an arm's select list and once in its order by — or the
-- migration refuses to guess.
-- ---------------------------------------------------------------------------

do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_precise text := $old$ts_rank(c.vec, coalesce(q.wide, q.precise))$old$;
  new_precise text := $new$ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32)$new$;
  old_wide text := $old$ts_rank(c.vec, q.wide)$old$;
  new_wide text := $new$ts_rank(c.vec, q.wide, 1|32)$new$;
  found int;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_all';

  if fn is null then
    raise exception 'search_all is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%, 1|32)%' then
    raise notice 'search_all already normalises rank by length; nothing to do';
    return;
  end if;

  found := (length(definition) - length(replace(definition, old_precise, ''))) / length(old_precise);
  if found <> 2 then
    raise exception 'search_all: expected the precise arm''s rank twice, found %', found;
  end if;
  updated := replace(definition, old_precise, new_precise);

  found := (length(updated) - length(replace(updated, old_wide, ''))) / length(old_wide);
  if found <> 2 then
    raise exception 'search_all: expected the wide arm''s rank twice, found %', found;
  end if;
  updated := replace(updated, old_wide, new_wide);

  if updated = definition then
    raise exception 'search_all: the rewrites produced no change';
  end if;
  if updated like '%ts_rank(c.vec, coalesce(q.wide, q.precise))%'
     or updated like '%ts_rank(c.vec, q.wide)%' then
    raise exception 'search_all: an unnormalised rank survived the rewrite';
  end if;
  -- What this must NOT have cost: 055's two arms, 038's knowledge scoping,
  -- 033's demotion of superseded rows, and 048's removal of owner predicates.
  if updated not like '%055: both arms run%'
     or updated not like '%>= q.threshold%'
     or updated not like '%join project_entities ep on ep.entity_id = ke.entity_id%'
     or updated not like '%case when hits.status = ''superseded'' then 0.4 else 1 end%'
     or updated like '%owner_user_id = p_owner%' then
    raise exception 'search_all: the rewrite lost behaviour an earlier migration installed';
  end if;

  execute updated;
end
$migration$;
