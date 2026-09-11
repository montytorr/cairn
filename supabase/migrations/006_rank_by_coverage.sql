-- ===========================================================================
-- Rank widened results by term COVERAGE, not term frequency.
--
-- ts_rank scores how often the query's terms occur. That is right for a
-- precise query and wrong for a widened one: with `a OR b OR c OR d`, a
-- document that happens to say "real" twenty times outranks one that matches
-- two of the four distinct terms — so the actual answer sinks below hundreds
-- of incidental mentions and never reaches the caller.
--
-- Measured before this change: an English query against a French task matched
-- the row (OR-match = 1) yet did not appear in the top 200. The cause was not
-- language — English stemming reduces the French "Justification des
-- interruptions" to justif/interrupt, exactly what the query asks for — it was
-- that frequency ranking buried a good-coverage, low-frequency match.
--
-- So widened results are ordered by how many DISTINCT query terms they match,
-- and ts_rank only breaks ties within the same coverage.
-- ===========================================================================

drop function if exists search_tasks(uuid, text, text, text, text, text, int, int);

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
  -- Coverage: how many of the distinct query terms this row matches at all.
  -- Counting matches per term is what separates a real answer from a document
  -- that merely repeats one common word.
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
    order by coverage desc, rank desc
    limit p_limit * 3
  ),
  hits as (select * from precise union all select * from wide)
  select h.id, h.number, h.title, h.type, h.status, h.priority,
         h.resolution, h.resolution_kind, h.description, h.claimed_by,
         h.updated_at, h.external_ref, h.pkey,
         h.rank, h.coverage, h.widened
  from hits h
  order by
    h.widened asc,                       -- precise beats widened
    h.coverage desc,                     -- then how much of the query matched
    h.rank desc,                         -- then frequency, as a tiebreak only
    (h.resolution is not null) desc,     -- then answers beat mere mentions
    h.updated_at desc
  limit p_limit;
$$;

revoke all on function search_tasks from public;
