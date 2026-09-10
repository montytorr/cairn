-- ===========================================================================
-- Ranked search.
--
-- Relevance ranking has to happen in Postgres: ts_rank needs the tsvector and
-- the tsquery together, and PostgREST cannot order by an expression it did
-- not select. Ranking in the application instead — by recency, say — throws
-- away the only signal that says which row actually answers the question.
-- (Learned the hard way: doing exactly that dropped measured recall from 75%
-- to 6%, because widening returns many more rows and a recency sort buries
-- the exact match among them.)
--
-- The precise (AND) query runs first. The widened (OR) query contributes rows
-- only when the precise one returned fewer than `p_min_precise` — expressed
-- as a predicate so this stays one statement and the function stays STABLE.
-- Precise always outranks widened; within each group ts_rank decides, and a
-- recorded resolution breaks ties, because a hit carrying an answer is worth
-- more than a hit that merely mentions the subject.
-- ===========================================================================

drop function if exists search_tasks(uuid, text, text, text, text, text, int, int);

create function search_tasks(
  p_owner       uuid,
  p_query       text,
  p_widen       text default null,
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
  rank real, widened boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with
  q as (
    select websearch_to_tsquery('english', p_query) as precise,
           case when p_widen is null then null
                else websearch_to_tsquery('english', p_widen) end as wide
  ),
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
    select v.*, ts_rank(v.search_vector, q.precise) as rank, false as widened
    from visible v, q
    where v.search_vector @@ q.precise
    order by ts_rank(v.search_vector, q.precise) desc
    limit p_limit
  ),
  wide as (
    select v.*, ts_rank(v.search_vector, q.wide) as rank, true as widened
    from visible v, q
    where q.wide is not null
      and (select count(*) from precise) < p_min_precise
      and v.search_vector @@ q.wide
      and v.id not in (select precise.id from precise)
    order by ts_rank(v.search_vector, q.wide) desc
    limit p_limit * 2
  ),
  hits as (
    select * from precise
    union all
    select * from wide
  )
  select h.id, h.number, h.title, h.type, h.status, h.priority,
         h.resolution, h.resolution_kind, h.description, h.claimed_by,
         h.updated_at, h.external_ref, h.pkey,
         h.rank, h.widened
  from hits h
  order by
    h.widened asc,                       -- precise beats widened
    h.rank desc,                         -- then relevance
    (h.resolution is not null) desc,     -- then answers beat mere mentions
    h.updated_at desc
  limit p_limit;
$$;

revoke all on function search_tasks from public;
grant execute on function search_tasks to authenticated, service_role;
