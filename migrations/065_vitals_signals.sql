-- ===========================================================================
-- 065: vitals can see quiet claims, a dead reaper, a failing summariser and a
--      runtime that stopped
--
-- CAIRN-282 recomputed every vitals number against production and every one
-- matched its SQL. The panel still read "nothing wrong in the last 24h" while:
--
--   * 17 of 22 held claims had shown no sign of life for more than 20h, and
--     the reaper had released nothing since 2026-09-12. `stalled` counts only
--     UNclaimed work, `held` is a bare count, and `claims-abandoned` needs
--     five automatic releases — which a dead reaper holds at zero. The one
--     check that should have caught it was structurally unable to fire.
--   * 1 of 16 sessions was summarised on 09-24 (openclaw 0/8, codex 0/2),
--     against about 75% the week before. The alarm fires only at zero.
--   * codex recorded nothing for 24h and openclaw's scheduled runs stopped on
--     09-20. Sessions were only ever totalled, never split by runtime.
--   * 421 of 424 current knowledge entries had never been verified.
--   * the summariser's own `claude -p` runs were being recorded as sessions,
--     inflating the volume and diluting the summarised share.
--
-- A NEW FUNCTION, NOT A SEVENTH TRANSFORMATION OF cairn_vitals. Everything
-- here is new data rather than a change to a number cairn_vitals already
-- returns, and five migrations have rewritten that function by editing its
-- installed text (048, 050, 051, 054; 050 once by re-copying, which reverted
-- 048). Adding six CTEs to it through string surgery is how the next one of
-- those goes wrong. The app reads both, in parallel, and treats this one as
-- optional so that a database without it still answers the monitor.
--
-- Workspace-wide, like everything 048 left behind: p_owner is accepted for
-- the same N-1 call shape and deliberately unused.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What counts as someone actually being on a claim.
--
-- ONE definition, because the reaper and this monitor must agree about it,
-- and because it is about to change: CAIRN-283 is changing how session-end
-- auto-checkpoints are written. Whatever that lands on, only this function
-- should need to learn it.
--
-- Genuine: the claim itself, an explicit heartbeat, a note, any activity
-- event (a manual checkpoint, a status move, a commit, a test run), and the
-- stored checkpoint when a person or agent wrote it.
--
-- Not genuine:
--   * `updated_at`. The touch trigger stamps it on every write, including the
--     session-end sweep that refreshes every claim the actor holds — which is
--     exactly why BB-385, claimed 168h earlier and untouched since, carried an
--     updated_at of 09:00 that morning.
--   * a checkpoint the session-end hook wrote. Today it writes the stored
--     checkpoint directly, with no event, and marks its text: either the
--     "Still held, not progressed" preamble for a claim it did not work, or
--     the "_Recorded automatically when the session ended._" footer
--     (src/lib/api/sessions.ts) on both kinds. A summary that is only a
--     "Next:" block is the same writer with an empty `completed`.
--   * any activity event that says it was automatic, so that if CAIRN-283
--     starts recording those checkpoints as events, marking them
--     `data.auto = true` or `data.source = 'session-end'` is enough.
--   * the reaper's own release, which ends the claim anyway.
-- ---------------------------------------------------------------------------
create or replace function checkpoint_is_automatic(p_summary text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    p_summary like 'Still held, not progressed%'
    or p_summary like 'Next:%'
    or strpos(p_summary, '_Recorded automatically when the session ended._') > 0,
    false
  )
$$;

create or replace function task_genuine_activity_at(p_task_id uuid)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select greatest(
    t.claimed_at,
    t.heartbeat_at,
    case when not checkpoint_is_automatic(t.checkpoint_summary) then t.checkpoint_at end,
    (select max(n.created_at) from task_notes n where n.task_id = t.id),
    (select max(e.created_at)
       from task_activity_events e
      where e.task_id = t.id
        and e.event <> 'released'
        and coalesce(e.data->>'auto', '') <> 'true'
        and coalesce(e.data->>'source', '') not in ('session-end', 'session_end'))
  )
  from tasks t
  where t.id = p_task_id
$$;

comment on function task_genuine_activity_at(uuid) is
  'The last time anyone was verifiably on a task: claim, heartbeat, note, '
  'activity event, or a checkpoint that was not written by the session-end '
  'hook. Never updated_at. The single definition of claim liveness — see 065.';

-- ---------------------------------------------------------------------------
-- Where a session ran, from its working directory. Coarse on purpose: the two
-- machines this workspace runs on are a Mac (/Users/...) and Clawdius
-- (/home/... or /root). What matters is telling "openclaw on the server
-- stopped" from "openclaw stopped".
-- ---------------------------------------------------------------------------
create or replace function session_host(p_cwd text)
returns text
language sql
immutable
as $$
  select case
    when p_cwd like '/Users/%' then 'mac'
    when p_cwd like '/home/%' or p_cwd = '/root' or p_cwd like '/root/%' then 'clawdius'
    else 'other'
  end
$$;

-- The summariser's own `claude -p` run, captured by the Claude SessionEnd
-- hook as if it were work. Its prompt is fixed (hooks/cairn-session-end.mjs).
create or replace function session_is_summariser(p_request text)
returns boolean
language sql
immutable
as $$
  select coalesce(ltrim(p_request) like 'You are writing one entry in an engineering memory%', false)
$$;

create or replace function cairn_vitals_signals(p_owner uuid, p_hours int default 24)
returns jsonb
language sql
stable
set search_path = public
as $$
with
  bounds as (
    select
      now() - make_interval(hours => p_hours)        as window_start,
      now() - make_interval(hours => p_hours + 168)  as baseline_start,
      now() - make_interval(hours => p_hours)        as baseline_end,
      -- How far back "a runtime we used to see" reaches. Long enough that a
      -- runtime absent from the whole window AND the week before still shows
      -- as gone, rather than vanishing from every list that could say so.
      now() - make_interval(hours => p_hours + 168 + 720) as history_start
  ),
  sess as (
    select
      s.platform_source                          as runtime,
      session_host(s.cwd)                        as host,
      s.created_at,
      session_is_summariser(s.request)           as summariser,
      (coalesce(s.learned, '') <> ''
        or coalesce(s.completed, '') <> ''
        or coalesce(s.next_steps, '') <> '')     as summarised
    from sessions s, bounds b
    where s.created_at >= b.history_start
  ),
  session_totals as (
    select
      count(*) filter (where not x.summariser and x.created_at >= b.window_start)          as recent,
      count(*) filter (where not x.summariser and x.created_at >= b.window_start
                         and x.summarised)                                                  as recent_summarised,
      count(*) filter (where not x.summariser and x.created_at >= b.baseline_start
                         and x.created_at < b.baseline_end)                                 as baseline,
      count(*) filter (where not x.summariser and x.created_at >= b.baseline_start
                         and x.created_at < b.baseline_end and x.summarised)                as baseline_summarised,
      count(*) filter (where x.summariser and x.created_at >= b.window_start)              as summariser_recent,
      count(*) filter (where x.summariser and x.created_at >= b.baseline_start
                         and x.created_at < b.baseline_end)                                 as summariser_baseline
    from sess x, bounds b
  ),
  runtime_stats as (
    select coalesce(jsonb_agg(row_to_json(r)::jsonb order by r.runtime, r.host), '[]'::jsonb) as runtimes
    from (
      select
        x.runtime,
        x.host,
        count(*) filter (where x.created_at >= b.window_start)                     as recent,
        count(*) filter (where x.created_at >= b.window_start and x.summarised)    as "recentSummarised",
        count(*) filter (where x.created_at >= b.baseline_start
                           and x.created_at < b.baseline_end)                      as baseline,
        count(*) filter (where x.created_at >= b.baseline_start
                           and x.created_at < b.baseline_end and x.summarised)     as "baselineSummarised",
        max(x.created_at)                                                          as "lastSeenAt"
      from sess x, bounds b
      where not x.summariser
      group by x.runtime, x.host
    ) r
  ),
  held as (
    select
      p.key || '-' || t.number                    as ref,
      t.title,
      t.claimed_by                                as "claimedBy",
      task_genuine_activity_at(t.id)              as last_activity
    from tasks t
    join projects p on p.id = t.project_id
    where t.claimed_by is not null
  ),
  claim_stats as (
    select
      count(*)                                                                         as held,
      count(*) filter (where coalesce(h.last_activity, '-infinity') < now() - interval '2 hours')  as quiet_2h,
      count(*) filter (where coalesce(h.last_activity, '-infinity') < now() - interval '24 hours') as quiet_24h,
      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'ref', q.ref,
                 'title', q.title,
                 'claimedBy', q."claimedBy",
                 'lastActivityAt', q.last_activity,
                 'quietMinutes', case when q.last_activity is null then null
                                      else floor(extract(epoch from now() - q.last_activity) / 60)::int end
               ) order by q.last_activity asc nulls first)
        from (
          select * from held h2
          where coalesce(h2.last_activity, '-infinity') < now() - interval '2 hours'
          order by h2.last_activity asc nulls first
          limit 10
        ) q
      ), '[]'::jsonb)                                                                  as quietest
    from held h
  ),
  -- The reaper, judged by what it did. `cairn reconcile` with nothing to do
  -- leaves no trace, so a release is the only evidence it runs at all; that
  -- is why "no release" only means something when there is a quiet claim it
  -- should have taken.
  reaper_stats as (
    select
      count(*) filter (where e.created_at >= b.window_start)               as released_in_window,
      count(*) filter (where e.created_at >= now() - interval '7 days')    as released_7d,
      max(e.created_at)                                                    as last_release_at
    from task_activity_events e, bounds b
    where e.event = 'released' and e.data->>'reason' = 'reconcile'
  ),
  maintenance_stats as (
    select greatest(
      (select max(e.created_at) from task_activity_events e
        where e.actor_id = 'maintenance' or e.actor_id like 'maintenance · %'),
      (select max(n.created_at) from task_notes n
        where n.actor_id = 'maintenance' or n.actor_id like 'maintenance · %')
    ) as last_write_at
  ),
  -- A runtime that wrote nothing in the window or the week before falls out
  -- of cairn_vitals' agent list entirely, so "silent" could never be said of
  -- it. These are the ones seen before that and not since.
  absent_agents as (
    select coalesce(jsonb_agg(jsonb_build_object('agent', a.agent, 'lastSeenAt', a.last_seen)
                              order by a.agent), '[]'::jsonb) as agents
    from (
      select e.actor_id as agent, max(e.created_at) as last_seen
      from task_activity_events e, bounds b
      where e.actor_type = 'agent'
        and e.created_at >= b.history_start
        and e.actor_id <> 'maintenance'
        and e.actor_id not like 'maintenance · %'
      group by e.actor_id
      having max(e.created_at) < min(b.baseline_start)
    ) a
  ),
  knowledge_stats as (
    select
      count(*)                                                                  as current_count,
      count(*) filter (where k.verified_at is null)                             as never_verified,
      count(*) filter (where k.verified_at is null
                         or k.verified_at < now() - interval '30 days')         as unverified_30d,
      count(*) filter (where k.verified_at >= b.window_start)                   as verified_in_window,
      max(k.verified_at)                                                        as last_verified_at
    from knowledge k, bounds b
    where k.superseded_by is null
  )
select jsonb_build_object(
  'windowHours', p_hours,
  'sessions', jsonb_build_object(
    'recent', st.recent,
    'recentSummarised', st.recent_summarised,
    'baseline', st.baseline,
    'baselineSummarised', st.baseline_summarised,
    'summariserRecent', st.summariser_recent,
    'summariserBaseline', st.summariser_baseline
  ),
  'runtimes', rs.runtimes,
  'claims', jsonb_build_object(
    'held', c.held,
    'quiet2h', c.quiet_2h,
    'quiet24h', c.quiet_24h,
    'quietest', c.quietest
  ),
  'reaper', jsonb_build_object(
    'releasedInWindow', r.released_in_window,
    'released7d', r.released_7d,
    'lastReleaseAt', r.last_release_at,
    'maintenanceLastWriteAt', m.last_write_at
  ),
  'absentAgents', aa.agents,
  'knowledge', jsonb_build_object(
    'current', k.current_count,
    'neverVerified', k.never_verified,
    'unverified30d', k.unverified_30d,
    'verifiedInWindow', k.verified_in_window,
    'lastVerifiedAt', k.last_verified_at
  )
)
from session_totals st, runtime_stats rs, claim_stats c, reaper_stats r,
     maintenance_stats m, absent_agents aa, knowledge_stats k;
$$;
