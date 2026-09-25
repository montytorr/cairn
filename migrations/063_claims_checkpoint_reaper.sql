-- ===========================================================================
-- 063: a session-end checkpoint is not a sign of life, and a release means it
--
-- CAIRN-283. checkpointHeldTasks wrote a summary onto every task the actor's
-- label held, and every write went through tasks_touch, so updated_at said
-- "just edited" on claims nobody had opened in a week. The reaper reads
-- updated_at as liveness, so those claims could never go quiet, and the text
-- replaced whatever real checkpoint was there: 28 tasks lost one.
--
-- The policy (which tasks, which text, never over a written checkpoint) lives
-- in src/lib/api/sessions.ts, where it is pure and unit-tested. What lives here
-- is what has to be atomic: the write only lands if the claim, its generation
-- and the checkpoint it was planned against are all still what the plan saw,
-- and it leaves updated_at alone.
--
-- CAIRN-284. A release now clears claimed_session, and a manual release moves
-- a held `doing` task back to `todo` the way the reaper already did. The
-- reaper's optimistic check compares timestamps at millisecond precision,
-- which is all the application can hand back (see reconcile_task_atomic).
-- Both functions are rebuilt from their CURRENT definitions (047); nothing
-- between 047 and here redefined them.
-- ===========================================================================

-- A write that is bookkeeping, not activity, says so for the length of one
-- statement. Transaction-local and reset by the caller straight after, so it
-- cannot leak onto a later write in the same transaction. Deliberately not
-- `alter table ... disable trigger`, which takes an exclusive lock on tasks
-- from a request path.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('cairn.keep_updated_at', true), '') = 'on' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end $$;

-- 040's list, plus the automatic checkpoint. Its own event name rather than
-- `checkpointed`, because vitals counts `checkpointed` as evidence that an
-- agent recorded where it got to, and nobody chose to record this one.
alter table task_activity_events
  drop constraint if exists task_activity_events_event_check;

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'resolved', 'resolution_revised', 'resolution_withdrawn',
    'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    'git_commit', 'git_push', 'run_result',
    'checkpointed', 'auto_checkpointed', 'attachment_added', 'attachment_removed',
    'dependency_added', 'dependency_removed',
    'project_created', 'project_renamed', 'project_key_changed',
    'project_archived', 'project_restored', 'project_deleted',
    'task_deleted', 'knowledge_deleted'
  ));

-- Does not bump checkpoint_version: a deliberate checkpoint racing this one
-- must win, and it can only win if its predecessor check still passes.
create or replace function auto_checkpoint_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_version bigint,
  p_expected_checkpoint_version bigint,
  p_expected_summary text,
  p_summary text,
  p_at timestamptz,
  p_data jsonb default '{}'::jsonb
) returns boolean language plpgsql as $$
declare
  written tasks%rowtype;
  wrote boolean;
begin
  perform set_config('cairn.keep_updated_at', 'on', true);
  update tasks set
    checkpoint_summary = p_summary,
    checkpoint_at = p_at
  where id = p_task_id
    and claimed_by = p_actor_id
    and ownership_version = p_expected_version
    and checkpoint_version = p_expected_checkpoint_version
    and checkpoint_summary is not distinct from p_expected_summary
    and checkpoint_summary is distinct from p_summary
    and status not in ('done', 'cancelled')
  returning * into written;
  -- Captured before the reset: PERFORM sets FOUND too.
  wrote := found;
  perform set_config('cairn.keep_updated_at', '', true);
  if not wrote then return false; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, written.project_id, written.id, p_actor_type, p_actor_id,
     'auto_checkpointed',
     coalesce(p_data, '{}'::jsonb) || jsonb_build_object(
       'summary', left(p_summary, 300),
       'replaced', left(p_expected_summary, 300),
       'ownershipVersion', written.ownership_version));
  return true;
end $$;

create or replace function release_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_version bigint,
  p_expected_holder text default null
) returns jsonb language plpgsql as $$
declare
  before_row tasks%rowtype;
  released tasks%rowtype;
  reopen boolean;
begin
  select * into before_row from tasks where id = p_task_id for update;
  if not found then return null; end if;

  -- `doing` on a held task means "an agent is on it"; once the claim is gone
  -- that is no longer true. An unheld `doing` is a person working, and a
  -- release of nothing must not move it.
  reopen := before_row.status = 'doing' and before_row.claimed_by is not null;

  update tasks
     set claimed_by = null, claimed_at = null, heartbeat_at = null, claimed_session = null,
         status = case when reopen then 'todo' else status end
   where id = p_task_id
     and ownership_version = p_expected_version
     and (p_expected_holder is null or claimed_by = p_expected_holder)
  returning * into released;
  if not found then return null; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, released.project_id, released.id, p_actor_type, p_actor_id,
     'released', jsonb_build_object('previousHolder', p_expected_holder,
       'ownershipVersion', p_expected_version, 'reopened', reopen));
  return to_jsonb(released);
end $$;

create or replace function reconcile_task_atomic(
  p_task_id uuid,
  p_owner_user_id uuid,
  p_actor_type text,
  p_actor_id text,
  p_expected_holder text,
  p_expected_version bigint,
  p_expected_heartbeat timestamptz,
  p_expected_updated_at timestamptz,
  p_reopen boolean,
  p_note text,
  p_content_hash text
) returns boolean language plpgsql as $$
declare released tasks%rowtype;
begin
  update tasks set
    claimed_by = null, claimed_at = null, heartbeat_at = null, claimed_session = null,
    status = case when p_reopen then 'todo' else status end
  where id = p_task_id
    and claimed_by = p_expected_holder
    and ownership_version = p_expected_version
    -- At the precision the caller can hold. The snapshot comes back through
    -- node-postgres as a JS Date, which keeps milliseconds and drops the
    -- microseconds now() writes, so an exact comparison never matched a row
    -- stamped by now() and the swap lost every time — silently, because a
    -- lost swap is the designed answer to a race.
    and date_trunc('milliseconds', heartbeat_at)
        is not distinct from date_trunc('milliseconds', p_expected_heartbeat)
    and date_trunc('milliseconds', updated_at)
        is not distinct from date_trunc('milliseconds', p_expected_updated_at)
  returning * into released;
  if not found then return false; end if;

  insert into task_notes
    (task_id, actor_type, actor_id, kind, note, content_hash)
  values (released.id, p_actor_type, p_actor_id, 'handoff', p_note, p_content_hash)
  on conflict (task_id, content_hash) do nothing;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, released.project_id, released.id, p_actor_type, p_actor_id,
     'released', jsonb_build_object('reason', 'reconcile', 'reopened', p_reopen,
       'previousHolder', p_expected_holder,
       'ownershipVersion', p_expected_version));
  return true;
end $$;
