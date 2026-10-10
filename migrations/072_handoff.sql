-- ===========================================================================
-- 072: hand-off to another tracker or another Cairn (CAIRN-366)
--
-- Ported from Croft's 080, in its final shape. A task may be handed off to
-- another tracker: which tracker, the task it became there (ref, url), and
-- what that tracker last said about it. While the hand-off is open the
-- tracker owns the task's status, and the API refuses status changes here
-- with 409 `handed_off`. A project may name where its tasks go by default.
--
-- The tracker is data; nothing here calls one. Not a Lab feature: it works
-- on any task, whether or not the Lab is on.
--
-- A `cairn` hand-off must say WHICH Cairn: a bare `KDP-41` names a task on
-- any instance that has a KDP project, which is the trap Croft's links fell
-- into (knowledge croft-cairn-shared-work-boundary). Its url is required and
-- is the destination task's absolute https address.
-- ===========================================================================

alter table tasks add column if not exists handoff_tracker   text;
alter table tasks add column if not exists handoff_ref       text;
alter table tasks add column if not exists handoff_url       text;
alter table tasks add column if not exists handoff_status    text;
alter table tasks add column if not exists handoff_synced_at timestamptz;

alter table projects add column if not exists handoff_tracker text;
alter table projects add column if not exists handoff_target  text;

-- Every check NOT VALID: a validating add scans the table under a lock that
-- stops writes, and an instance that migrates on start would stall for it.
-- New rows are checked at once; 076 validates the old ones (all null here)
-- without blocking writes.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_pair_check') then
    alter table tasks add constraint tasks_handoff_pair_check
      check ((handoff_ref is null) = (handoff_tracker is null)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_tracker_shape_check') then
    alter table tasks add constraint tasks_handoff_tracker_shape_check
      check (handoff_tracker is null or handoff_tracker ~ '^[a-z][a-z0-9-]{1,31}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_ref_shape_check') then
    alter table tasks add constraint tasks_handoff_ref_shape_check
      check (handoff_ref is null or (char_length(handoff_ref) between 1 and 200 and handoff_ref !~ '\s')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_url_shape_check') then
    alter table tasks add constraint tasks_handoff_url_shape_check
      check (handoff_url is null or (handoff_url ~* '^https?://' and char_length(handoff_url) <= 2000)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tasks_handoff_cairn_url_check') then
    alter table tasks add constraint tasks_handoff_cairn_url_check
      -- coalesce: a null url makes the match null, and a null check passes.
      check (handoff_tracker is distinct from 'cairn' or coalesce(handoff_url ~* '^https://', false)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_handoff_pair_check') then
    alter table projects add constraint projects_handoff_pair_check
      check ((handoff_target is null) = (handoff_tracker is null)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_handoff_tracker_shape_check') then
    alter table projects add constraint projects_handoff_tracker_shape_check
      check (handoff_tracker is null or handoff_tracker ~ '^[a-z][a-z0-9-]{1,31}$') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'projects_handoff_target_shape_check') then
    alter table projects add constraint projects_handoff_target_shape_check
      check (handoff_target is null or handoff_target ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$') not valid;
  end if;
end $$;

create index if not exists tasks_handoff_ref_idx
  on tasks (handoff_tracker, handoff_ref) where handoff_ref is not null;

-- ---------------------------------------------------------------------------
-- The claim paths refuse an open hand-off themselves. The API checks first and
-- answers 409 `handed_off`, but that check reads the row before the claim
-- does; a link landing in between must still not let a claim through. So the
-- conditional UPDATE in claim_task_atomic (047) and the auto-claim in
-- checkpoint_task_atomic (063) learn the same rule. Transformed in place
-- (055): each anchor must appear exactly once.
-- ---------------------------------------------------------------------------
do $migration$
declare
  definition text;
  updated text;
  old_where text;
  new_where text;
  old_claim text;
  new_claim text;
  found int;
begin
  definition := pg_get_functiondef(
    'claim_task_atomic(uuid, uuid, text, text, text, timestamptz, boolean)'::regprocedure);
  if definition not like '%072: an open hand-off%' then
    old_where := $old$     and (claimed_by is null or heartbeat_at < p_stale_before)
  returning * into claimed;$old$;
    new_where := $new$     and (claimed_by is null or heartbeat_at < p_stale_before)
     -- 072: an open hand-off is held by its tracker, not claimable here.
     and (handoff_ref is null or handoff_status in ('done', 'cancelled'))
  returning * into claimed;$new$;
    found := (length(definition) - length(replace(definition, old_where, ''))) / length(old_where);
    if found <> 1 then
      raise exception 'claim_task_atomic: expected exactly one claim condition to extend, found %', found;
    end if;
    updated := replace(definition, old_where, new_where);
    if updated not like '%ownership_version = ownership_version + 1%'
       or updated not like '%''via'', ''claim''%' then
      raise exception 'claim_task_atomic: the rewrite lost behaviour an earlier migration installed';
    end if;
    execute updated;
  end if;

  definition := pg_get_functiondef(
    'checkpoint_task_atomic(uuid, uuid, text, text, text, jsonb, uuid, timestamptz, bigint, bigint)'::regprocedure);
  if definition not like '%072: an open hand-off%' then
    old_claim := $old$  if current_row.claimed_by is null and p_actor_type = 'agent' then$old$;
    new_claim := $new$  -- 072: an open hand-off is held by its tracker; a checkpoint must not claim it.
  if current_row.claimed_by is null and p_actor_type = 'agent'
     and current_row.handoff_ref is not null
     and coalesce(current_row.handoff_status, '') not in ('done', 'cancelled') then
    return jsonb_build_object('code', 'handed_off');
  end if;

  if current_row.claimed_by is null and p_actor_type = 'agent' then$new$;
    found := (length(definition) - length(replace(definition, old_claim, ''))) / length(old_claim);
    if found <> 1 then
      raise exception 'checkpoint_task_atomic: expected exactly one auto-claim to guard, found %', found;
    end if;
    updated := replace(definition, old_claim, new_claim);
    if updated not like '%checkpoint_mutation_id = p_mutation_id%'
       or updated not like '%''code'', ''missing_predecessor''%' then
      raise exception 'checkpoint_task_atomic: the rewrite lost behaviour an earlier migration installed';
    end if;
    execute updated;
  end if;
end
$migration$;
