-- Where the work is stuck, rather than who did the most of it.
--
-- The tempting version of this is a leaderboard: tasks closed per agent,
-- writes per agent. It would be actively harmful. The agents read Cairn -- it
-- is their working memory, and the skill tells them to close with a resolution
-- -- so a visible closure score creates an incentive to close things, which is
-- the one behaviour least worth optimising. A resolution written to move a
-- number is worse than an open task, because it looks answered.
--
-- So: no ranking. Per agent, only what is actionable -- what it is holding now
-- and what it walked away from. The rest is about the work itself.

create or replace function cairn_work_shape(p_owner uuid, p_hours int default 24)
returns jsonb
language sql
stable
as $$
with
  bounds as (select now() - make_interval(hours => p_hours) as window_start),
  own as (
    select t.*, p.key as project_key
    from tasks t join projects p on p.id = t.project_id
    where p.owner_user_id = p_owner and p.status <> 'archived'
  ),
  open_tasks as (select * from own where status not in ('done', 'cancelled')),
  -- A day of silence is the same line the briefing and the reconciler use.
  stalled as (
    select * from open_tasks
    where status = 'doing' and claimed_by is null
      and coalesce(heartbeat_at, updated_at) < now() - interval '24 hours'
  ),
  by_project as (
    select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.stalled desc, x."oldestDays" desc), '[]'::jsonb) as projects
    from (
      select
        o.project_key                                                        as key,
        count(*)                                                             as open,
        count(*) filter (where o.id in (select id from stalled))             as stalled,
        round(max(extract(epoch from now() - o.created_at)) / 86400.0)::int  as "oldestDays",
        -- Filed and never touched since: nobody has picked it up at all.
        count(*) filter (where o.updated_at <= o.created_at + interval '1 minute') as "neverTouched"
      from open_tasks o
      group by o.project_key
      order by 3 desc, 4 desc
      limit 8
    ) x
  ),
  holding as (
    select coalesce(jsonb_agg(row_to_json(h)::jsonb order by h."heldMinutes" desc), '[]'::jsonb) as holding
    from (
      select
        o.claimed_by                                                     as agent,
        o.project_key || '-' || o.number                                 as ref,
        left(o.title, 70)                                                as title,
        round(extract(epoch from now() - o.claimed_at) / 60.0)::int      as "heldMinutes"
      from own o
      where o.claimed_by is not null
      order by o.claimed_at
      limit 20
    ) h
  ),
  -- Who walked away from what. Attributed to the actor that last touched it,
  -- which is the best the data supports: the claim itself is long gone.
  dropped as (
    select coalesce(jsonb_agg(row_to_json(d)::jsonb order by d.count desc), '[]'::jsonb) as dropped
    from (select actor_id as agent, count(*) as count from stalled group by 1) d
  ),
  -- Work that came back. Hard to game, because not making a mess is the only
  -- way to move it.
  rework as (
    select jsonb_build_object(
      'reopened', (
        select count(*) from task_activity_events e join own o on o.id = e.task_id, bounds b
        where e.event = 'status_changed' and e.created_at >= b.window_start
          and e.data->>'from' in ('done', 'cancelled')
          and e.data->>'to' not in ('done', 'cancelled')
      ),
      'resolutionsRevised', (
        select count(*) from task_activity_events e join own o on o.id = e.task_id, bounds b
        where e.event = 'resolution_revised' and e.created_at >= b.window_start
      ),
      'duplicatesFiled', (
        select count(*) from own o, bounds b
        where o.duplicate_of is not null and o.created_at >= b.window_start
      )
    ) as rework
  )
select jsonb_build_object(
  'windowHours', p_hours,
  'openTotal', (select count(*) from open_tasks),
  'stalledTotal', (select count(*) from stalled),
  'projects', p.projects,
  'holding', h.holding,
  'dropped', d.dropped,
  'rework', r.rework
)
from by_project p, holding h, dropped d, rework r;
$$;
