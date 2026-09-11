-- ===========================================================================
-- 020: search_all reports entity scope for knowledge
--
-- The knowledge branch built its `project_key` from knowledge_projects alone,
-- so a fact scoped to an entity came back with none — and every caller that
-- renders "project keys, else global" reported it as true everywhere. Exactly
-- backwards, and the same mistake as `globalIds` in 018: when a second way of
-- scoping something appears, every existing check for "unscoped" silently
-- becomes a check for "not scoped *that particular way*".
--
-- Projects first, since they are narrower; entity keys only when there are no
-- project links to report.
-- ===========================================================================

create or replace function search_all(
  p_owner       uuid,
  p_query       text,
  p_terms       text[] default null,
  p_project     text default null,
  p_kinds       text[] default null,
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

  knowledge_rows as (
    select 'knowledge'::text as kind, k.id,
           k.slug as ref,
           k.title,
           nullif(array_to_string(k.labels, ', '), '') as subtitle,
           -- Projects are narrower, so they win; entities only when there are
           -- none. Reporting neither is what made an entity-scoped fact look
           -- global to every caller.
           coalesce(
             (select string_agg(pr.key, ',' order by pr.key)
                from knowledge_projects kp
                join projects pr on pr.id = kp.project_id
               where kp.knowledge_id = k.id),
             (select string_agg(e.key, ',' order by e.key)
                from knowledge_entities ke
                join entities e on e.id = ke.entity_id
               where ke.knowledge_id = k.id)
           ) as project_key,
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
