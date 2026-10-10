-- ===========================================================================
-- 073: search finds Lab subjects (CAIRN-366)
--
-- Subjects become a fifth arm of search_all, so `cairn check` and the command
-- palette find a subject and its conclusion the way they find a task and its
-- resolution. Title and conclusion weigh A, the write-up B (071's generated
-- vector). A project-scoped search includes the subjects of that project.
--
-- While the Lab is off the arm returns nothing: an instance that never turned
-- it on must not grow subject rows in its answers.
--
-- Transformed, not re-copied (055): the installed definition is edited at one
-- anchor that must appear exactly once, and what earlier migrations installed
-- is asserted to have survived.
-- ===========================================================================

do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_candidates text;
  new_candidates text;
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

  if definition like '%073: Lab subjects%' then
    raise notice 'search_all already searches subjects; nothing to do';
    return;
  end if;

  old_candidates := $old$  candidates as (
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows
  ),$old$;

  new_candidates := $new$  -- 073: Lab subjects. The stage name is the status; a recorded conclusion
  -- is the answer. Nothing while the Lab is off.
  subject_rows as (
    select 'subject'::text as kind, s.id,
           'LAB-' || s.number as ref,
           s.title,
           nullif(left(regexp_replace(coalesce(s.conclusion, ''), '\s+', ' ', 'g'), 120), '') as subtitle,
           sp.key as project_key,
           st.name as status,
           'subject'::text as type,
           (s.conclusion is not null) as answered,
           s.updated_at,
           (coalesce(length(s.body), 0) + coalesce(length(s.conclusion), 0))::int as body_bytes,
           s.search_vector as vec
    from subjects s
    join lab_stages st on st.id = s.stage_id
    left join projects sp on sp.id = s.project_id
    cross join want w
    where exists (select 1 from lab_settings ls where ls.enabled)
      and (p_project is null or sp.key = upper(p_project))
      and (w.all_kinds or 'subject' = any (w.kinds))
  ),

  candidates as (
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows   union all
    select * from subject_rows
  ),$new$;

  found := (length(definition) - length(replace(definition, old_candidates, ''))) / length(old_candidates);
  if found <> 1 then
    raise exception 'search_all: expected exactly one candidates CTE to replace, found %', found;
  end if;
  updated := replace(definition, old_candidates, new_candidates);

  if updated = definition or updated not like '%select * from subject_rows%' then
    raise exception 'search_all: the rewrite produced no subject arm';
  end if;
  -- What this migration must NOT have cost: 055's two arms, 064's length
  -- normalisation, 038's knowledge scoping, 033's superseded demotion and
  -- 048's removal of owner predicates.
  if updated not like '%055: both arms run%'
     or updated not like '%1|32%'
     or updated not like '%join project_entities ep on ep.entity_id = ke.entity_id%'
     or updated not like '%case when hits.status = ''superseded'' then 0.4 else 1 end%'
     or updated like '%owner_user_id = p_owner%' then
    raise exception 'search_all: the rewrite lost behaviour an earlier migration installed';
  end if;

  execute updated;
end
$migration$;

comment on function search_all(uuid, text, text[], text, text[], int, int) is
  'Prior-work retrieval over tasks, notes, knowledge, sessions and Lab subjects (073; only while '
  'the Lab is on). Both arms always run and are merged: the precise arm returns rows carrying at '
  'least half the distinctive terms, the wide arm everything matching any of them, and a row '
  'found by both appears once, in the precise head. p_min_precise caps how many precise rows '
  'lead the answer.';
