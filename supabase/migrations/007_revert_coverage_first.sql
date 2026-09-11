-- ===========================================================================
-- Revert coverage-first ordering. Measured, and it was worse.
--
-- 006 ordered widened results by how many distinct query terms a row matched,
-- on the theory that frequency ranking buries good low-frequency matches.
-- The theory was reasonable and the measurement rejected it:
--
--   corpus              before 006   after 006
--   general (16 cases)      87%          81%
--   English->French (10)    40%          30%
--
-- Coverage-first floods the top with rows that match all the common terms
-- without being relevant, and once everything shares a coverage of 4 the only
-- discriminator left is the frequency ranking that was just demoted.
--
-- ts_rank goes back to being the primary sort. Coverage is kept in the result
-- (it is genuinely useful to see) but only breaks ties.
-- ===========================================================================

drop function if exists search_tasks(uuid, text, text[], text, text, text, int, int);

create function search_tasks(
  p_owner       uuid,
  p_query       text,
  p_terms       text[] default null,
  p_project     text default null,
  p_type        text default null,
  p_status      text default null,
  p_limit       int  default 20,
  p_min_precise int  default 3
)
returns table (
  id uuid, number int, title text, type text, status text, priority text,
  resolution text, resolution_kind text, description text, claimed_by text,
  updated_at timestamptz, external_ref text, project_key text,
  rank real, coverage int, widened boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with
  q as (select websearch_to_tsquery('english', p_query) as precise),
  visible as (
    select t.*, p.key as pkey
    from tasks t
    join projects p on p.id = t.project_id
    where p.owner_user_id = p_owner
      and (p_project is null or p.key = upper(p_project))
      and (p_type    is null or t.type   = p_type)
      and (p_status  is null or t.status = p_status)
  ),
  precise as (
    select v.*, ts_rank(v.search_vector, q.precise) as rank,
           cardinality(coalesce(p_terms, '{}')) as coverage, false as widened
    from visible v, q
    where v.search_vector @@ q.precise
    order by ts_rank(v.search_vector, q.precise) desc
    limit p_limit
  ),
  wide as (
    select v.*,
           ts_rank(v.search_vector, websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))) as rank,
           (select count(*)::int
              from unnest(p_terms) term
             where v.search_vector @@ plainto_tsquery('english', term)) as coverage,
           true as widened
    from visible v
    where p_terms is not null
      and cardinality(p_terms) >= 2
      and (select count(*) from precise) < p_min_precise
      and v.search_vector @@ websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      and v.id not in (select precise.id from precise)
    order by ts_rank(v.search_vector, websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))) desc
    limit p_limit * 2
  ),
  hits as (select * from precise union all select * from wide)
  select h.id, h.number, h.title, h.type, h.status, h.priority,
         h.resolution, h.resolution_kind, h.description, h.claimed_by,
         h.updated_at, h.external_ref, h.pkey,
         h.rank, h.coverage, h.widened
  from hits h
  order by
    h.widened asc,                       -- precise beats widened
    h.rank desc,                         -- relevance, measured to be the best signal
    h.coverage desc,                     -- coverage only breaks ties
    (h.resolution is not null) desc,
    h.updated_at desc
  limit p_limit;
$$;

revoke all on function search_tasks from public;
