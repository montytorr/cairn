-- ===========================================================================
-- 050: vitals says whether a writer is a person
--
-- `monty.torr@gmail.com has written nothing in 24h, against 97 in the week
-- before. This may simply be an idle runtime; verify it was expected to be
-- active before investigating hooks or keys.`
--
-- That is the owner of the instance, and 97 is a week of his own clicks in the
-- web UI. He has no hooks and no keys to investigate.
--
-- `actorLabel` gives a human their display name unqualified and an agent
-- `<runtime> · <display name>` — 049 says so in as many words when it
-- backfills the older rows. `agent_stats` grouped by actor_id and nothing
-- else, so every person who had ever touched a task arrived in a list the
-- `agent-silent` check reads.
--
-- This carries actor_type rather than filtering people out, because the panel
-- those rows feed is titled "Who wrote" and a person writing ninety-seven
-- times a week is a true answer to that. The check is what was wrong, and the
-- check is what changes; the page keeps the whole picture.
--
-- The cost of getting this wrong is not the noise. `openclaw` wrote 793 times
-- last week and nothing in the last 24 hours, which is exactly what this check
-- exists to surface, and it sat in the same list as a false positive about a
-- person. A warning that is wrong half the time is one nobody finishes
-- reading.
--
-- Only the agent_stats CTE changes. Otherwise 036 verbatim.
-- ===========================================================================

create or replace function cairn_vitals(p_owner uuid, p_hours int default 24)
returns jsonb
language sql
stable
as $$
with
  bounds as (
    select
      now() - make_interval(hours => p_hours)     as window_start,
      -- The week before the window, as the thing to compare against. A count
      -- means nothing on its own; "none today, forty last week" means a lot.
      now() - make_interval(hours => p_hours + 168) as baseline_start,
      now() - make_interval(hours => p_hours)     as baseline_end
  ),
  own_tasks as (
    select t.* from tasks t
    join projects p on p.id = t.project_id
    where p.owner_user_id = p_owner
  ),
  session_stats as (
    select
      count(*) filter (where s.created_at >= b.window_start)                      as recent,
      count(*) filter (where s.created_at >= b.window_start
                         and jsonb_typeof(s.files) = 'array'
                         and jsonb_array_length(s.files) > 0)                     as recent_with_files,
      -- The prose half. A session is the files AND what was learned; the
      -- second costs a model call and can stop being written without anything
      -- failing, because the hook keeps the row when it cannot reach one.
      count(*) filter (where s.created_at >= b.window_start
                         and (coalesce(s.learned, '') <> ''
                           or coalesce(s.completed, '') <> ''
                           or coalesce(s.next_steps, '') <> ''))                  as recent_summarised,
      count(*) filter (where s.created_at >= b.baseline_start
                         and s.created_at < b.baseline_end)                       as baseline,
      count(*) filter (where s.created_at >= b.baseline_start
                         and s.created_at < b.baseline_end
                         and jsonb_typeof(s.files) = 'array'
                         and jsonb_array_length(s.files) > 0)                     as baseline_with_files
    from sessions s, bounds b
    where s.owner_user_id = p_owner
  ),
  task_stats as (
    select
      count(*) filter (where t.created_at >= b.window_start)                      as opened,
      count(*) filter (where t.resolved_at >= b.window_start)                     as closed,
      count(*) filter (where t.status = 'doing' and t.claimed_by is null
                         and coalesce(t.heartbeat_at, t.updated_at) < b.window_start) as stalled,
      count(*) filter (where t.claimed_by is not null)                            as held
    from own_tasks t, bounds b
  ),
  release_stats as (
    select count(*) as auto_released
    from task_activity_events e
    join own_tasks t on t.id = e.task_id, bounds b
    where e.event = 'released'
      and e.data->>'reason' = 'reconcile'
      and e.created_at >= b.window_start
  ),
  knowledge_stats as (
    select count(*) as written
    from knowledge k, bounds b
    where k.owner_user_id = p_owner and k.created_at >= b.window_start
  ),
  -- Per agent, because an agent that has gone silent is the single clearest
  -- sign that its wiring broke, and it is invisible in any total.
  agent_stats as (
    select coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.agent), '[]'::jsonb) as agents
    from (
      select
        e.actor_id                                                   as agent,
        -- Carried, not filtered on. "Who wrote" is a true answer that should
        -- include people; it is the `agent-silent` CHECK that has no business
        -- looking at them, and it cannot tell without being told.
        e.actor_type                                                 as "actorType",
        count(*) filter (where e.created_at >= b.window_start)        as recent,
        count(*) filter (where e.created_at >= b.baseline_start
                           and e.created_at < b.baseline_end)         as baseline
      from task_activity_events e
      join own_tasks t on t.id = e.task_id, bounds b
      where e.created_at >= b.baseline_start
      -- By type as well, so a person and a runtime that somehow share an id
      -- stay two rows rather than being summed into one.
      group by e.actor_id, e.actor_type
    ) a
  )
select jsonb_build_object(
  'windowHours', p_hours,
  'sessions', jsonb_build_object(
    'recent', s.recent,
    'recentWithFiles', s.recent_with_files,
    'recentSummarised', s.recent_summarised,
    'baseline', s.baseline,
    'baselineWithFiles', s.baseline_with_files
  ),
  'tasks', jsonb_build_object(
    'opened', t.opened, 'closed', t.closed, 'stalled', t.stalled, 'held', t.held
  ),
  'autoReleased', r.auto_released,
  'knowledgeWritten', k.written,
  'agents', a.agents
)
from session_stats s, task_stats t, release_stats r, knowledge_stats k, agent_stats a;
$$;
