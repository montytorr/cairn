-- ===========================================================================
-- 016: search_all — one verb reaches everything an agent has ever written
--
-- `cairn check` is the first instruction in the skill, and until now it has
-- searched exactly one thing: tasks. Meanwhile the skill's other insistence is
-- that agents record findings and dead ends as notes, "tried X, no difference
-- is as valuable as a fix".
--
-- Those two instructions did not meet. task_notes has carried its own GIN
-- index since 001 and nothing has ever queried it, so all 190 notes -- every
-- dead end anybody bothered to write down -- were unreachable from the one
-- verb told to find them. Comments were reachable only by accident, through
-- the denormalised tasks.comments_text.
--
-- This adds knowledge and sessions in the same pass, so there is one index to
-- read rather than four places to look.
--
-- Ranking is inherited wholesale from search_tasks and for the same measured
-- reasons (004, 006, 007): a precise websearch_to_tsquery pass, widened to OR
-- only when the precise pass comes back under p_min_precise, ts_rank as the
-- primary sort, ordered inside Postgres. 006 proved coverage-first is worse
-- (87%->81%) and re-sorting in the application dropped recall from 75% to 6%.
--
-- Deliberately NOT weighting one kind above another. A curated knowledge row
-- arguably deserves a boost over an offhand note, but that is a guess, and the
-- one time this project ranked on a plausible theory instead of a measurement
-- it had to be reverted. Kind breaks ties and nothing more. Measure first.
-- ===========================================================================

create function search_all(
  p_owner       uuid,
  p_query       text,
  p_terms       text[] default null,
  p_project     text default null,
  p_kinds       text[] default null,   -- task | note | knowledge | session
  p_limit       int  default 20,
  p_min_precise int  default 3
)
returns table (
  kind         text,
  id           uuid,
  ref          text,
  title        text,
  subtitle     text,
  project_key  text,
  status       text,
  type         text,
  answered     boolean,
  updated_at   timestamptz,
  body_bytes   int,
  rank         real,
  widened      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with
  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end as wide
  ),
  want as (
    select p_kinds is null as all_kinds, coalesce(p_kinds, '{}'::text[]) as kinds
  ),

  -- ----- tasks -----------------------------------------------------------
  task_rows as (
    select 'task'::text as kind, t.id,
           p.key || '-' || t.number as ref,
           t.title,
           nullif(concat_ws(' · ', t.priority, nullif(array_to_string(t.labels, ', '), '')), '') as subtitle,
           p.key as project_key, t.status, t.type,
           t.has_resolution as answered, t.updated_at,
           (coalesce(length(t.description), 0) + coalesce(length(t.resolution), 0))::int as body_bytes,
           t.search_vector as vec
    from tasks t
    join projects p on p.id = t.project_id
    cross join want w
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'task' = any (w.kinds))
  ),

  -- ----- notes: the work log, finally reachable ---------------------------
  note_rows as (
    select 'note'::text as kind, n.id,
           p.key || '-' || t.number as ref,
           left(regexp_replace(n.note, '\s+', ' ', 'g'), 120) as title,
           n.kind as subtitle,
           p.key as project_key, t.status, t.type,
           (n.kind in ('finding', 'decision')) as answered,
           n.created_at as updated_at,
           coalesce(length(n.note), 0)::int as body_bytes,
           to_tsvector('english'::regconfig, coalesce(n.note, '')) as vec
    from task_notes n
    join tasks t    on t.id = n.task_id
    join projects p on p.id = t.project_id
    cross join want w
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))
  ),

  -- ----- knowledge --------------------------------------------------------
  knowledge_rows as (
    select 'knowledge'::text as kind, k.id,
           k.slug as ref,
           k.title,
           nullif(array_to_string(k.labels, ', '), '') as subtitle,
           (select string_agg(pr.key, ',' order by pr.key)
              from knowledge_projects kp
              join projects pr on pr.id = kp.project_id
             where kp.knowledge_id = k.id) as project_key,
           case when k.superseded_by is not null then 'superseded' else 'current' end as status,
           'knowledge'::text as type,
           (k.verified_at is not null) as answered,
           k.updated_at,
           coalesce(length(k.body), 0)::int as body_bytes,
           k.search_vector as vec
    from knowledge k
    cross join want w
    where k.owner_user_id = p_owner
      and (w.all_kinds or 'knowledge' = any (w.kinds))
  ),

  -- ----- sessions ---------------------------------------------------------
  session_rows as (
    select 'session'::text as kind, s.id,
           to_char(coalesce(s.ended_at, s.created_at), 'YYYY-MM-DD') as ref,
           coalesce(s.request, s.completed, '(session)') as title,
           nullif(concat_ws(' · ', s.platform_source, s.cwd), '') as subtitle,
           p.key as project_key,
           s.platform_source as status,
           'session'::text as type,
           (s.next_steps is not null) as answered,
           coalesce(s.ended_at, s.created_at) as updated_at,
           (coalesce(length(s.learned), 0) + coalesce(length(s.completed), 0)
            + coalesce(length(s.next_steps), 0))::int as body_bytes,
           s.search_vector as vec
    from sessions s
    left join projects p on p.id = s.project_id
    cross join want w
    where s.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'session' = any (w.kinds))
  ),

  candidates as (
    select * from task_rows      union all
    select * from note_rows      union all
    select * from knowledge_rows union all
    select * from session_rows
  ),

  precise as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.precise) as rank, false as widened
    from candidates c, q
    where c.vec @@ q.precise
    order by ts_rank(c.vec, q.precise) desc
    limit p_limit
  ),

  wide as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.wide) as rank, true as widened
    from candidates c, q
    where q.wide is not null
      and (select count(*) from precise) < p_min_precise
      and c.vec @@ q.wide
      and c.id not in (select precise.id from precise)
    order by ts_rank(c.vec, q.wide) desc
    limit p_limit * 2
  )

  select * from (select * from precise union all select * from wide) hits
  order by
    hits.widened asc,
    hits.rank desc,
    hits.answered desc,
    case hits.kind when 'task' then 0 when 'knowledge' then 1
                   when 'note' then 2 else 3 end,
    hits.updated_at desc
  limit p_limit;
$$;

revoke all on function search_all from public;
grant execute on function search_all to authenticated, service_role;

comment on function search_all is
  'Ranked index across tasks, work-log notes, knowledge and sessions. Returns '
  'refs and one-liners with a size column -- never bodies. Ranking is '
  'deliberately kind-blind; see the migration header.';
