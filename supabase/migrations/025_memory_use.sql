-- Is the memory earning its keep?
--
-- Kept apart from cairn_work_shape rather than folded into it: that function
-- answers what happened to the work, this one answers whether anybody consulted
-- what was already known. One more round trip is cheaper than a hundred-line
-- function nobody dares change.

create or replace function cairn_memory_use(p_owner uuid, p_hours int default 24)
returns jsonb
language sql
stable
as $$
with
  bounds as (select now() - make_interval(hours => p_hours) as window_start),
  searches as (
    select s.* from search_events s, bounds b
    where s.owner_user_id = p_owner and s.created_at >= b.window_start
  ),
  own as (
    select t.* from tasks t join projects p on p.id = t.project_id
    where p.owner_user_id = p_owner
  )
select jsonb_build_object(
  'windowHours', p_hours,
  'searches', (select count(*) from searches),
  -- The most informative row in the table: what the memory was asked for and
  -- did not have.
  'zeroResults', (select count(*) from searches where result_count = 0),
  'byAgent', (
    select coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.searches desc), '[]'::jsonb)
    from (select actor_id as agent, count(*) as searches from searches group by 1) a
  ),
  -- The discipline the skill actually asks for, finally measurable: work filed
  -- by an actor that had not asked the memory anything in the half hour before.
  'tasksFiledWithoutChecking', (
    select count(*) from own o, bounds b
    where o.created_at >= b.window_start
      and not exists (
        select 1 from search_events s
        where s.owner_user_id = p_owner
          and s.actor_id = o.actor_id
          and s.created_at between o.created_at - interval '30 minutes' and o.created_at
      )
  ),
  'tasksFiled', (select count(*) from own o, bounds b where o.created_at >= b.window_start),
  'recentMisses', (
    select coalesce(jsonb_agg(q.query order by q.created_at desc), '[]'::jsonb)
    from (select query, created_at from searches where result_count = 0 order by created_at desc limit 8) q
  )
)
$$;
