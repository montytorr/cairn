-- Croft schema at migration 081, vendored so the importer test needs no Croft checkout.
-- Regenerate from a database built by croft/migrations:
--   pg_dump --schema-only --no-owner --no-privileges <db>   (then drop the psql meta lines)
-- tests/integration/croft-import.test.ts compares it with CROFT_MIGRATIONS_DIR when that is set.

SET check_function_bodies = false;

--
-- PostgreSQL database dump
--




--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: activity_feed(uuid, timestamp with time zone, integer, text, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activity_feed(p_owner uuid, p_before timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_project text DEFAULT NULL::text, p_actor text DEFAULT NULL::text, p_kinds text[] DEFAULT NULL::text[]) RETURNS TABLE(kind text, at timestamp with time zone, actor text, project_key text, ref text, title text, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with
  want as (select p_kinds is null as all_kinds, coalesce(p_kinds, '{}'::text[]) as kinds),
  ceiling as (select coalesce(p_before, 'infinity'::timestamptz) as before),

  -- A task appearing. Its later life is covered by the event rows below.
  filed as (
    select 'task'::text as kind, t.created_at as at, t.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           t.title, t.type as detail
    from tasks t
    join projects p on p.id = t.project_id
    cross join want w, ceiling c
    where t.created_at < c.before
      and (w.all_kinds or 'task' = any (w.kinds))
      -- 076: a todo is seen only by those who can see its subject.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  ),

  -- What actually changed, recorded whether or not anyone narrated it.
  events as (
    select 'event'::text as kind, e.created_at as at, e.actor_id as actor,
           p.key as project_key,
           -- The ref, or what it was called before it stopped existing. A
           -- tombstone keeps its ref in `data` because the row it names is
           -- gone; events about knowledge, from before 072, carry a slug.
           coalesce(
             case when t.id is not null then p.key || '-' || t.number end,
             e.data->>'ref',
             p.key,
             e.data->>'slug'
           ) as ref,
           coalesce(
             t.title,
             case when e.event in ('project_key_changed', 'project_renamed')
                   and e.data ? 'from'
                  then (e.data->>'from') || ' → ' || coalesce(e.data->>'to', '?')
             end,
             e.data->>'title', e.data->>'key', ''
           ) as title,
           -- Delivery evidence carries its own answer, so the feed says what
           -- it was rather than only that it happened.
           case e.event
             when 'git_commit' then 'git_commit ' || coalesce(substr(e.data->>'sha', 1, 8), '?')
             when 'git_push'   then 'git_push '   || coalesce(e.data->>'branch', substr(e.data->>'sha', 1, 8), '?')
             when 'run_result' then 'run_result ' || coalesce(e.data->>'status', '?')
             else e.event
           end as detail
    from task_activity_events e
    -- LEFT, all of it: an event outlives its task, and an event about a
    -- project has no task at all.
    left join tasks t    on t.id = e.task_id
    left join projects p on p.id = coalesce(e.project_id, t.project_id)
    cross join want w, ceiling c
    where e.created_at < c.before
      and (w.all_kinds or 'event' = any (w.kinds))
      -- 076: the subject stamped at the time, and the task's subject now.
      and (e.subject_id is null or e.subject_id in (select croft_visible_subjects(p_owner)))
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  ),

  notes as (
    select 'note'::text as kind, n.created_at as at, n.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           croft_clip(regexp_replace(n.note, '\s+', ' ', 'g'), 160) as title,
           n.kind as detail
    from task_notes n
    join tasks t    on t.id = n.task_id
    join projects p on p.id = t.project_id
    cross join want w, ceiling c
    where n.created_at < c.before
      and (w.all_kinds or 'note' = any (w.kinds))
      -- 076: a todo's work log.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  ),

  comments as (
    select 'comment'::text as kind, c.created_at as at, c.actor_id as actor,
           p.key as project_key, p.key || '-' || t.number as ref,
           croft_clip(regexp_replace(c.content, '\s+', ' ', 'g'), 160) as title,
           c.comment_type as detail
    from task_comments c
    join tasks t    on t.id = c.task_id
    join projects p on p.id = t.project_id
    cross join want w, ceiling cl
    where c.created_at < cl.before
      and (w.all_kinds or 'comment' = any (w.kinds))
      -- 076: a todo's comments.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  ),

  everything as (
    select * from filed    union all
    select * from events   union all
    select * from notes    union all
    select * from comments
  )

  select e.kind, e.at, e.actor, e.project_key, e.ref, e.title, e.detail
  from everything e
  where (p_project is null or e.project_key = upper(p_project))
    and (p_actor is null or e.actor = p_actor)
  order by e.at desc
  limit p_limit;
$$;


--
-- Name: FUNCTION activity_feed(p_owner uuid, p_before timestamp with time zone, p_limit integer, p_project text, p_actor text, p_kinds text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.activity_feed(p_owner uuid, p_before timestamp with time zone, p_limit integer, p_project text, p_actor text, p_kinds text[]) IS 'One timeline across tasks filed, what changed on them, notes and comments. Keyset-paginated on `at` because the feed grows from the head and an OFFSET page would drift under it. 076: p_owner is the viewer again. Only what croft_visible_subjects(p_owner) allows is read, counted or (rename_label) written: todos of subjects the viewer cannot see, and everything hanging off them, are left out before any limit.';


--
-- Name: assign_subject_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_subject_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.number is null then
    update subject_number_counter
       set last_number = last_number + 1
     where singleton
    returning last_number into new.number;
  else
    -- An explicit number (an import) moves the counter past it.
    update subject_number_counter
       set last_number = greatest(last_number, new.number)
     where singleton;
  end if;
  return new;
end
$$;


--
-- Name: assign_task_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_task_number() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.number is null then
    update projects
       set task_counter = task_counter + 1
     where id = new.project_id
    returning task_counter into new.number;
  end if;
  return new;
end $$;


--
-- Name: checkpoint_task_atomic(uuid, uuid, text, text, text, jsonb, uuid, timestamp with time zone, bigint, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.checkpoint_task_atomic(p_task_id uuid, p_owner_user_id uuid, p_actor_type text, p_actor_id text, p_summary text, p_payload jsonb, p_mutation_id uuid, p_queued_at timestamp with time zone, p_expected_version bigint DEFAULT NULL::bigint, p_expected_checkpoint_version bigint DEFAULT NULL::bigint) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  current_row tasks%rowtype;
  claimed_now boolean := false;
begin
  select * into current_row from tasks where id = p_task_id for update;
  if not found then return jsonb_build_object('code', 'not_found'); end if;

  if current_row.checkpoint_mutation_id = p_mutation_id then
    return jsonb_build_object('code', 'duplicate', 'data', to_jsonb(current_row));
  end if;
  if current_row.status in ('done', 'cancelled') then
    return jsonb_build_object('code', 'terminal');
  end if;
  if current_row.claimed_by is not null and
     (p_expected_version is null or p_expected_checkpoint_version is null) then
    return jsonb_build_object('code', 'missing_predecessor');
  end if;
  if p_expected_version is not null and
     (current_row.claimed_by is null or current_row.ownership_version <> p_expected_version) then
    return jsonb_build_object('code', 'ownership_changed', 'version', current_row.ownership_version);
  end if;
  if p_expected_checkpoint_version is not null and
     current_row.checkpoint_version <> p_expected_checkpoint_version then
    return jsonb_build_object('code', 'checkpoint_changed', 'version', current_row.checkpoint_version);
  end if;

  if current_row.claimed_by is null and p_actor_type = 'agent' then
    update tasks set
      claimed_by = p_actor_id, claimed_at = now(), heartbeat_at = now(),
      attempt = attempt + 1, ownership_version = ownership_version + 1,
      status = 'doing'
    where id = p_task_id returning * into current_row;
    claimed_now := true;
  elsif current_row.claimed_by is distinct from p_actor_id and p_actor_type = 'agent' then
    return jsonb_build_object('code', 'already_claimed', 'holder', current_row.claimed_by);
  end if;

  update tasks set
    checkpoint_summary = p_summary,
    checkpoint_payload = p_payload,
    checkpoint_at = now(),
    checkpoint_version = checkpoint_version + 1,
    checkpoint_mutation_id = p_mutation_id,
    heartbeat_at = case when claimed_by = p_actor_id then now() else heartbeat_at end
  where id = p_task_id returning * into current_row;

  if claimed_now then
    insert into task_activity_events
      (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
    values
      (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
       'claimed', jsonb_build_object('agent', p_actor_id, 'attempt', current_row.attempt,
         'ownershipVersion', current_row.ownership_version)),
      (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
       'status_changed', jsonb_build_object('to', 'doing', 'via', 'checkpoint'));
  end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, current_row.project_id, current_row.id, p_actor_type, p_actor_id,
     'checkpointed', jsonb_build_object('summary', left(p_summary, 300),
       'queuedAt', p_queued_at,
       'checkpointVersion', current_row.checkpoint_version,
       'ownershipVersion', current_row.ownership_version));

  return jsonb_build_object('code', 'ok', 'data', to_jsonb(current_row), 'claimed', claimed_now);
end $$;


--
-- Name: claim_task_atomic(uuid, uuid, text, text, text, timestamp with time zone, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_task_atomic(p_task_id uuid, p_owner_user_id uuid, p_actor_type text, p_actor_id text, p_holder text, p_stale_before timestamp with time zone, p_set_doing boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  before_row tasks%rowtype;
  claimed tasks%rowtype;
begin
  select * into before_row from tasks where id = p_task_id;
  if not found then return null; end if;

  update tasks
     set claimed_by = p_holder,
         claimed_at = now(),
         heartbeat_at = now(),
         attempt = attempt + 1,
         ownership_version = ownership_version + 1,
         status = case when p_set_doing then 'doing' else status end
   where id = p_task_id
     and status not in ('done', 'cancelled')
     and (claimed_by is null or heartbeat_at < p_stale_before)
  returning * into claimed;
  if not found then return null; end if;

  insert into task_activity_events
    (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
  values
    (p_owner_user_id, claimed.project_id, claimed.id, p_actor_type, p_actor_id,
     'claimed', jsonb_build_object('agent', p_holder, 'attempt', claimed.attempt,
       'ownershipVersion', claimed.ownership_version));

  if claimed.status is distinct from before_row.status then
    insert into task_activity_events
      (owner_user_id, project_id, task_id, actor_type, actor_id, event, data)
    values
      (p_owner_user_id, claimed.project_id, claimed.id, p_actor_type, p_actor_id,
       'status_changed', jsonb_build_object('from', before_row.status, 'to', claimed.status, 'via', 'claim'));
  end if;

  return to_jsonb(claimed);
end $$;


--
-- Name: croft_clip(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_clip(p_text text, p_limit integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case
    when p_text is null then null
    when length(p_text) <= p_limit then p_text
    else
      -- Greedy up to the last whitespace inside the limit, so a word is never
      -- cut in half. `substring` returns null when there is no whitespace at
      -- all — 160 unbroken characters are not prose, and a hard cut is then
      -- the honest answer.
      rtrim(
        coalesce(
          substring(left(p_text, p_limit) from '^.*\s'),
          left(p_text, p_limit)
        )
      ) || '…'
  end;
$$;


--
-- Name: croft_pulse(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_pulse(p_owner uuid, p_project text DEFAULT NULL::text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with scoped_tasks as (
    select t.updated_at
      from tasks t
      join projects p on p.id = t.project_id
     where (p_project is null or p.key = upper(p_project))
       -- 076: only the tasks the viewer can see.
       and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  )
  select concat_ws('|',
    coalesce(max(updated_at)::text, '-') || ':' || count(*)::text,
    case when p_project is not null then '' else (
      select coalesce(max(e.created_at)::text, '-')
        from task_activity_events e
        left join tasks t on t.id = e.task_id
       -- 076: as the activity feed filters them.
       where (e.subject_id is null or e.subject_id in (select croft_visible_subjects(p_owner)))
         and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
    ) end,
    -- 071: the lab. Subjects move on every edit, note and tag change.
    case when p_project is not null then '' else (
      select coalesce(max(su.updated_at)::text, '-') || ':' || count(*)::text
        from subjects su
       where su.id in (select croft_visible_subjects(p_owner)) -- 076: visible only
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(n.created_at)::text, '-') || ':' || count(*)::text
        from subject_notes n
       where n.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(st.updated_at)::text, '-') || ':' || count(*)::text
        from subject_stages st
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(tg.updated_at)::text, '-') || ':' || count(*)::text
        from tags tg
    ) end,
    case when p_project is not null then '' else (
      select count(*)::text
        from subject_tags x
       where x.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
    ) end,
    -- 074: lab projects.
    case when p_project is not null then '' else (
      select coalesce(max(lp.updated_at)::text, '-') || ':' || count(*)::text
        from lab_projects lp
    ) end,
    -- 075: people's notes and files on subjects.
    case when p_project is not null then '' else (
      select coalesce(max(hn.updated_at)::text, '-') || ':' || count(*)::text
        from subject_human_notes hn
       where hn.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(sa.created_at)::text, '-') || ':' || count(*)::text
        from subject_attachments sa
       where sa.subject_id in (select croft_visible_subjects(p_owner)) -- 076: visible only
    ) end
  )
  from scoped_tasks;
$$;


--
-- Name: FUNCTION croft_pulse(p_owner uuid, p_project text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.croft_pulse(p_owner uuid, p_project text) IS 'One string that changes whenever anything visible changes: tasks, activity, and the lab (subjects, their notes, human notes, files and tags, stages, tags, lab projects). Read by the SSE stream every few seconds, so it must stay index-cheap. 076: p_owner is the viewer again. Only what croft_visible_subjects(p_owner) allows is read, counted or (rename_label) written: todos of subjects the viewer cannot see, and everything hanging off them, are left out before any limit.';


--
-- Name: croft_stamp_ref(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_stamp_ref(p_task uuid, p_ref text) RETURNS void
    LANGUAGE sql
    AS $$
  update task_activity_events
     set data = data || jsonb_build_object('ref', p_ref)
   where task_id = p_task
     and data->>'ref' is distinct from p_ref;
$$;


--
-- Name: FUNCTION croft_stamp_ref(p_task uuid, p_ref text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.croft_stamp_ref(p_task uuid, p_ref text) IS 'Writes the task ref into every one of its activity rows, so they stay readable after the task is deleted and they detach from it.';


--
-- Name: croft_subject_visible(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_subject_visible(p_subject uuid, p_viewer uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((
    select s.visibility = 'lab'
        or (p_viewer is not null and (
             s.owner_user_id = p_viewer
          or (s.visibility = 'members'
              and exists (select 1 from subject_members m
                           where m.subject_id = s.id and m.user_id = p_viewer))
        ))
      from subjects s
     where s.id = p_subject
  ), false);
$$;


--
-- Name: FUNCTION croft_subject_visible(p_subject uuid, p_viewer uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.croft_subject_visible(p_subject uuid, p_viewer uuid) IS 'Whether p_viewer may see subject p_subject: a lab subject, its owner, or a member of a members subject. No administrator exception (077): a private subject whose owner is gone is hidden from everyone until the owner is restored. False for a subject that does not exist and, for a non-lab subject, for a null viewer. The one place the rule lives.';


--
-- Name: croft_task_visible(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_task_visible(p_subject_id uuid, p_viewer uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select p_subject_id is null or croft_subject_visible(p_subject_id, p_viewer);
$$;


--
-- Name: FUNCTION croft_task_visible(p_subject_id uuid, p_viewer uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.croft_task_visible(p_subject_id uuid, p_viewer uuid) IS 'Whether p_viewer may see a task whose subject_id is p_subject_id: true when it has no subject, otherwise croft_subject_visible.';


--
-- Name: croft_user_active(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_user_active(p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((
    select u.deleted_at is null
       and coalesce(u.banned_until, '-infinity'::timestamptz) <= now()
      from app_users u
     where u.id = p_user
  ), false);
$$;


--
-- Name: croft_visible_subjects(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.croft_visible_subjects(p_viewer uuid) RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select s.id
    from subjects s
   where s.visibility = 'lab' or croft_subject_visible(s.id, p_viewer);
$$;


--
-- Name: list_labels(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_labels(p_owner uuid) RETURNS TABLE(label text, task_count bigint)
    LANGUAGE sql STABLE
    AS $$
  select l as label, count(*) as task_count
    from tasks t
    join projects p on p.id = t.project_id
   cross join lateral unnest(t.labels) as l
   -- 076: only the tasks the viewer can see are counted.
   where (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
   group by l
   order by count(*) desc, l;
$$;


--
-- Name: FUNCTION list_labels(p_owner uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.list_labels(p_owner uuid) IS 'Every label in use by this owner, with how many tasks carry it. 076: p_owner is the viewer again. Only what croft_visible_subjects(p_owner) allows is read, counted or (rename_label) written: todos of subjects the viewer cannot see, and everything hanging off them, are left out before any limit.';


--
-- Name: reconcile_task_atomic(uuid, uuid, text, text, text, bigint, timestamp with time zone, timestamp with time zone, boolean, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reconcile_task_atomic(p_task_id uuid, p_owner_user_id uuid, p_actor_type text, p_actor_id text, p_expected_holder text, p_expected_version bigint, p_expected_heartbeat timestamp with time zone, p_expected_updated_at timestamp with time zone, p_reopen boolean, p_note text, p_content_hash text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: refresh_task_comments_text(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_task_comments_text() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  target uuid := coalesce(new.task_id, old.task_id);
begin
  update tasks t
     set comments_text = (
       select string_agg(c.content, E'\n' order by c.created_at)
       from task_comments c
       where c.task_id = target
     )
   where t.id = target;
  return null;
end $$;


--
-- Name: release_task_atomic(uuid, uuid, text, text, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_task_atomic(p_task_id uuid, p_owner_user_id uuid, p_actor_type text, p_actor_id text, p_expected_version bigint, p_expected_holder text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: rename_label(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rename_label(p_owner uuid, p_from text, p_to text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
declare
  affected integer;
begin
  if p_from is null or p_from = '' then
    raise exception 'a label to rename is required';
  end if;

  update tasks t
     set labels = case
           when p_to is null or p_to = ''
             then array_remove(t.labels, p_from)
           else (
             select coalesce(array_agg(distinct x order by x), '{}'::text[])
               from unnest(array_replace(t.labels, p_from, p_to)) as x
           )
         end
    from projects p
   where t.project_id = p.id
     and p_from = any (t.labels)
     -- 076: only the tasks the caller can see.
     and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)));

  get diagnostics affected = row_count;
  return affected;
end;
$$;


--
-- Name: FUNCTION rename_label(p_owner uuid, p_from text, p_to text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.rename_label(p_owner uuid, p_from text, p_to text) IS 'Rename a label across every task, merging into the target if it already exists. A null or empty p_to deletes the label instead. Returns the number of tasks changed. 076: p_owner is the viewer again. Only what croft_visible_subjects(p_owner) allows is read, counted or (rename_label) written: todos of subjects the viewer cannot see, and everything hanging off them, are left out before any limit.';


--
-- Name: search_all(uuid, text, text[], text, text[], integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_all(p_owner uuid, p_query text, p_terms text[] DEFAULT NULL::text[], p_project text DEFAULT NULL::text, p_kinds text[] DEFAULT NULL::text[], p_limit integer DEFAULT 20, p_min_precise integer DEFAULT 3) RETURNS TABLE(kind text, id uuid, ref text, title text, subtitle text, project_key text, status text, type text, answered boolean, updated_at timestamp with time zone, body_bytes integer, rank real, widened boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  with
  -- 055: both arms run and the precise one asks for N of M terms.
  terms as (
    -- The distinctive terms as the text-search configuration will actually
    -- see them. A stopword term can never match, so it must not count
    -- towards the threshold.
    select plainto_tsquery('english', term) as tq
      from unnest(coalesce(p_terms, '{}'::text[])) as term
     where numnode(plainto_tsquery('english', term)) > 0
  ),

  q as (
    select
      websearch_to_tsquery('english', p_query) as precise,
      -- nullif: a query whose every distinctive term is a stopword produces an
      -- EMPTY tsquery rather than a null one, and would lose the fallback.
      nullif(case
        when p_terms is not null and cardinality(p_terms) >= 2
        then websearch_to_tsquery('english', array_to_string(p_terms, ' OR '))
      end, ''::tsquery) as wide,
      -- N of M. Half the live terms, and never fewer than two.
      greatest(2, ceil((select count(*) from terms) / 2.0))::int as threshold
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
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'task' = any (w.kinds))
      -- 076: a todo is seen only by those who can see its subject.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
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
    where (p_project is null or p.key = upper(p_project))
      and (w.all_kinds or 'note' = any (w.kinds))
      -- 076: and so is its work log.
      and (t.subject_id is null or t.subject_id in (select croft_visible_subjects(p_owner)))
  ),

  -- 070: subjects. No project, so a project-scoped search leaves them out.
  -- The stage name is the status; a recorded conclusion is the answer.
  subject_rows as (
    select 'subject'::text as kind, s.id,
           'S-' || s.number as ref,
           s.title,
           nullif(left(regexp_replace(coalesce(s.conclusion, ''), '\s+', ' ', 'g'), 120), '') as subtitle,
           null::text as project_key,
           st.name as status,
           'subject'::text as type,
           (s.conclusion is not null) as answered,
           s.updated_at,
           (coalesce(length(s.body), 0) + coalesce(length(s.conclusion), 0))::int as body_bytes,
           s.search_vector as vec
    from subjects s
    join subject_stages st on st.id = s.stage_id
    cross join want w
    where p_project is null
      and (w.all_kinds or 'subject' = any (w.kinds))
      -- 076: private and members-only subjects.
      and s.id in (select croft_visible_subjects(p_owner))
  ),

  candidates as (
    select * from task_rows    union all
    select * from note_rows    union all
    select * from subject_rows
  ),

  precise as (
    -- At least half of the distinctive terms, counted per row.
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32) as rank, false as widened
    from candidates c, q
    where case
            -- One distinctive term or none: no OR query to count coverage
            -- against, so the whole question stays the test.
            when q.wide is null then c.vec @@ q.precise
            else c.vec @@ q.wide
                 and (select count(*) from terms t where c.vec @@ t.tq) >= q.threshold
          end
    order by ts_rank(c.vec, coalesce(q.wide, q.precise), 1|32) desc
    -- A head, not a block: p_min_precise is the size of the confident head.
    limit (select case when q.wide is null then p_limit
                       else least(p_limit, greatest(p_min_precise, 1)) end from q)
  ),

  wide as (
    select c.kind, c.id, c.ref, c.title, c.subtitle, c.project_key, c.status,
           c.type, c.answered, c.updated_at, c.body_bytes,
           ts_rank(c.vec, q.wide, 1|32) as rank, true as widened
    from candidates c, q
    where q.wide is not null
      and c.vec @@ q.wide
      and c.id not in (select precise.id from precise)
    order by ts_rank(c.vec, q.wide, 1|32) desc
    limit p_limit * 2
  )

  select * from (select * from precise union all select * from wide) hits
  order by
    hits.widened asc,
    hits.rank desc,
    hits.answered desc,
    case hits.kind when 'task' then 0 when 'note' then 1 else 2 end,
    hits.updated_at desc
  limit p_limit;
$$;


--
-- Name: FUNCTION search_all(p_owner uuid, p_query text, p_terms text[], p_project text, p_kinds text[], p_limit integer, p_min_precise integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.search_all(p_owner uuid, p_query text, p_terms text[], p_project text, p_kinds text[], p_limit integer, p_min_precise integer) IS 'Prior-work retrieval over tasks, notes and subjects. Both arms always run and are merged: the precise arm returns rows carrying at least half the distinctive terms, the wide arm everything matching any of them, and a row found by both appears once, in the precise head. p_min_precise caps how many precise rows lead the answer. 076: p_owner is the viewer again. Only what croft_visible_subjects(p_owner) allows is read, counted or (rename_label) written: todos of subjects the viewer cannot see, and everything hanging off them, are left out before any limit.';


--
-- Name: subjects_require_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.subjects_require_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.visibility <> 'lab'
     and new.owner_user_id is null
     and (tg_op = 'INSERT' or pg_trigger_depth() = 1) then
    raise exception 'a % subject must have an owner', new.visibility
      using errcode = '23514', constraint = 'subjects_owner_required';
  end if;
  return new;
end
$$;


--
-- Name: task_activity_stamp_subject(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.task_activity_stamp_subject() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.subject_id is null and new.task_id is not null then
    select t.subject_id into new.subject_id from tasks t where t.id = new.task_id;
  end if;
  return new;
end
$$;


--
-- Name: task_is_descendant(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.task_is_descendant(p_candidate uuid, p_ancestor uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  with recursive up as (
    select id, parent_id from tasks where id = p_candidate
    union all
    select t.id, t.parent_id from tasks t join up on t.id = up.parent_id
  )
  select exists (select 1 from up where id = p_ancestor);
$$;


--
-- Name: FUNCTION task_is_descendant(p_candidate uuid, p_ancestor uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.task_is_descendant(p_candidate uuid, p_ancestor uuid) IS 'True when p_candidate is p_ancestor, or is nested anywhere beneath it. Used to refuse a parent assignment that would close a loop.';


--
-- Name: tasks_default_assignee(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tasks_default_assignee() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.assignee_user_id is null then
    select owner_user_id into new.assignee_user_id from projects where id = new.project_id;
  end if;
  return new;
end
$$;


--
-- Name: touch_subject_from_note(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_subject_from_note() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update subjects set updated_at = now() where id = new.subject_id;
  return null;
end
$$;


--
-- Name: touch_subject_from_tag(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_subject_from_tag() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  -- On a cascade from a deleted subject the row is already gone; the update
  -- then matches nothing, which is right.
  update subjects set updated_at = now()
   where id = case when tg_op = 'DELETE' then old.subject_id else new.subject_id end;
  return null;
end
$$;


--
-- Name: touch_task_from_note(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_task_from_note() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  update tasks set updated_at = now()
   where id = coalesce(new.task_id, old.task_id);
  return null;
end $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(current_setting('croft.keep_updated_at', true), '') = 'on' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end $$;




--
-- Name: _cairn_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._cairn_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_name text NOT NULL,
    platform_source text,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_epoch bigint DEFAULT 0 NOT NULL
);


--
-- Name: app_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    user_agent text,
    session_epoch bigint DEFAULT 0 NOT NULL
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    encrypted_password text NOT NULL,
    banned_until timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    auth_epoch bigint DEFAULT 0 NOT NULL,
    session_epoch bigint DEFAULT 0 NOT NULL,
    CONSTRAINT app_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: connect_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connect_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_code_hash text NOT NULL,
    user_code text NOT NULL,
    host text NOT NULL,
    runtimes text[] NOT NULL,
    cli_version text,
    client_address text,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_by uuid,
    approved_runtimes text[],
    decided_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connect_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'consumed'::text, 'expired'::text])))
);


--
-- Name: instance_branding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_branding (
    id boolean DEFAULT true NOT NULL,
    name text,
    accent text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT instance_branding_accent_check CHECK (((accent IS NULL) OR (accent ~ '^#[0-9a-f]{6}$'::text))),
    CONSTRAINT instance_branding_id_check CHECK (id),
    CONSTRAINT instance_branding_name_check CHECK (((name IS NULL) OR ((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 60))))
);


--
-- Name: lab_projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#8a8792'::text NOT NULL,
    handoff_target text,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    handoff_tracker text,
    CONSTRAINT lab_projects_color_check CHECK ((color ~ '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT lab_projects_handoff_pair_check CHECK (((handoff_target IS NULL) = (handoff_tracker IS NULL))),
    CONSTRAINT lab_projects_handoff_target_shape_check CHECK (((handoff_target IS NULL) OR (handoff_target ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'::text))),
    CONSTRAINT lab_projects_handoff_tracker_shape_check CHECK (((handoff_tracker IS NULL) OR (handoff_tracker ~ '^[a-z][a-z0-9-]{1,31}$'::text))),
    CONSTRAINT lab_projects_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 40)))
);


--
-- Name: password_reset_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    requested_by uuid,
    purpose text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT password_reset_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['admin_reset'::text, 'forgot'::text]))),
    CONSTRAINT password_reset_tokens_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: TABLE password_reset_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.password_reset_tokens IS 'Single-use password reset links (077). token_hash is sha256(token) in hex; the token is only ever in the email, or on the host''s stdout for scripts/reset-password.mjs. used_at marks a token used or invalidated; at most one unused token per user.';


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    key text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    task_counter integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    external_ref text,
    external_url text,
    CONSTRAINT projects_key_format CHECK ((key ~ '^[A-Z][A-Z0-9]{0,9}$'::text)),
    CONSTRAINT projects_status_check CHECK ((status = ANY (ARRAY['planning'::text, 'active'::text, 'paused'::text, 'completed'::text, 'archived'::text])))
);


--
-- Name: subject_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    storage_path text NOT NULL,
    sha256 text,
    uploaded_by text NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_attachments_filename_check CHECK (((char_length(filename) >= 1) AND (char_length(filename) <= 255))),
    CONSTRAINT subject_attachments_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: subject_human_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_human_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_id uuid NOT NULL,
    body text NOT NULL,
    user_id uuid,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_human_notes_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT subject_human_notes_body_check CHECK (((char_length(btrim(body)) >= 1) AND (char_length(btrim(body)) <= 100000)))
);


--
-- Name: subject_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_members (
    subject_id uuid NOT NULL,
    user_id uuid NOT NULL,
    added_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subject_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_id uuid NOT NULL,
    kind text DEFAULT 'note'::text NOT NULL,
    note text NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    user_id uuid,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_notes_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT subject_notes_kind_check CHECK ((kind = ANY (ARRAY['note'::text, 'finding'::text, 'decision'::text, 'attempt'::text, 'handoff'::text, 'stage'::text, 'visibility'::text])))
);


--
-- Name: subject_number_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_number_counter (
    singleton boolean DEFAULT true NOT NULL,
    last_number integer NOT NULL,
    CONSTRAINT subject_number_counter_last_number_check CHECK ((last_number >= 0)),
    CONSTRAINT subject_number_counter_singleton_check CHECK (singleton)
);


--
-- Name: subject_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#8a8792'::text NOT NULL,
    category text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subject_stages_category_check CHECK ((category = ANY (ARRAY['planned'::text, 'active'::text, 'completed'::text, 'dropped'::text]))),
    CONSTRAINT subject_stages_color_check CHECK ((color ~ '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT subject_stages_name_check CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 40)))
);


--
-- Name: subject_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subject_tags (
    subject_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subjects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    number integer NOT NULL,
    title text NOT NULL,
    body text,
    stage_id uuid NOT NULL,
    owner_user_id uuid,
    conclusion text,
    concluded_at timestamp with time zone,
    "position" integer DEFAULT 0 NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    search_vector tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(conclusion, ''::text)), 'A'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(body, ''::text)), 'B'::"char"))) STORED,
    project_id uuid,
    visibility text DEFAULT 'lab'::text NOT NULL,
    CONSTRAINT subjects_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT subjects_title_check CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 300))),
    CONSTRAINT subjects_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'members'::text, 'lab'::text])))
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#8a8792'::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tags_color_check CHECK ((color ~ '^#[0-9a-f]{6}$'::text)),
    CONSTRAINT tags_name_check CHECK (((name = lower(btrim(name))) AND ((char_length(name) >= 1) AND (char_length(name) <= 40))))
);


--
-- Name: task_activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_activity_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    event text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    project_id uuid,
    owner_user_id uuid,
    subject_id uuid,
    CONSTRAINT task_activity_events_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT task_activity_events_event_check CHECK ((event = ANY (ARRAY['created'::text, 'status_changed'::text, 'priority_changed'::text, 'type_changed'::text, 'renamed'::text, 'labels_changed'::text, 'due_date_changed'::text, 'body_edited'::text, 'assignee_changed'::text, 'resolved'::text, 'resolution_revised'::text, 'resolution_withdrawn'::text, 'marked_duplicate'::text, 'duplicate_cleared'::text, 'claimed'::text, 'released'::text, 'blocked'::text, 'unblocked'::text, 'git_commit'::text, 'git_push'::text, 'run_result'::text, 'checkpointed'::text, 'auto_checkpointed'::text, 'attachment_added'::text, 'attachment_removed'::text, 'dependency_added'::text, 'dependency_removed'::text, 'project_created'::text, 'project_renamed'::text, 'project_key_changed'::text, 'project_archived'::text, 'project_restored'::text, 'project_deleted'::text, 'task_deleted'::text, 'knowledge_deleted'::text])))
);


--
-- Name: COLUMN task_activity_events.task_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_activity_events.task_id IS 'Null once the task is deleted: the event detaches rather than cascading, so the timeline keeps the record. `data` carries the ref it referred to.';


--
-- Name: COLUMN task_activity_events.data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.task_activity_events.data IS 'Event payload. Delivery evidence uses git_commit, git_push, or run_result.';


--
-- Name: task_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    filename text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    storage_path text NOT NULL,
    sha256 text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_attachments_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT task_attachments_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: task_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    content text NOT NULL,
    comment_type text DEFAULT 'comment'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    external_ref text,
    mutation_id uuid,
    CONSTRAINT task_comments_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT task_comments_comment_type_check CHECK ((comment_type = ANY (ARRAY['comment'::text, 'status_change'::text, 'assignment'::text, 'system'::text])))
);


--
-- Name: task_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_id text NOT NULL,
    note text NOT NULL,
    kind text DEFAULT 'note'::text NOT NULL,
    facts jsonb,
    content_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_notes_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT task_notes_kind_check CHECK ((kind = ANY (ARRAY['note'::text, 'finding'::text, 'decision'::text, 'attempt'::text, 'handoff'::text])))
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    number integer NOT NULL,
    title text NOT NULL,
    description text,
    type text DEFAULT 'feature'::text NOT NULL,
    status text DEFAULT 'backlog'::text NOT NULL,
    priority text DEFAULT 'medium'::text NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    due_date date,
    "position" integer DEFAULT 0 NOT NULL,
    actor_type text DEFAULT 'human'::text NOT NULL,
    actor_id text NOT NULL,
    claimed_by text,
    claimed_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    attempt integer DEFAULT 0 NOT NULL,
    checkpoint_summary text,
    checkpoint_payload jsonb,
    checkpoint_at timestamp with time zone,
    blocked_reason text,
    blocked_at timestamp with time zone,
    resolution text,
    resolution_kind text,
    resolved_at timestamp with time zone,
    resolved_by text,
    memory_session_id text,
    observation_ids jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    external_ref text,
    external_url text,
    has_resolution boolean GENERATED ALWAYS AS ((resolution IS NOT NULL)) STORED,
    comments_text text,
    search_vector tsvector GENERATED ALWAYS AS (((((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(resolution, ''::text)), 'A'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(external_ref, ''::text)), 'A'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(comments_text, ''::text)), 'C'::"char"))) STORED,
    duplicate_of uuid,
    parent_id uuid,
    ownership_version bigint DEFAULT 0 NOT NULL,
    checkpoint_version bigint DEFAULT 0 NOT NULL,
    checkpoint_mutation_id uuid,
    claimed_session text,
    assignee_user_id uuid NOT NULL,
    subject_id uuid,
    handoff_ref text,
    handoff_status text,
    handoff_synced_at timestamp with time zone,
    handoff_tracker text,
    handoff_url text,
    CONSTRAINT tasks_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT tasks_duplicate_needs_kind CHECK (((duplicate_of IS NULL) OR (resolution_kind = 'duplicate'::text))),
    CONSTRAINT tasks_duplicate_not_self CHECK (((duplicate_of IS NULL) OR (duplicate_of <> id))),
    CONSTRAINT tasks_handoff_pair_check CHECK (((handoff_ref IS NULL) = (handoff_tracker IS NULL))),
    CONSTRAINT tasks_handoff_tracker_shape_check CHECK (((handoff_tracker IS NULL) OR (handoff_tracker ~ '^[a-z][a-z0-9-]{1,31}$'::text))),
    CONSTRAINT tasks_parent_not_self CHECK (((parent_id IS NULL) OR (parent_id <> id))),
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['urgent'::text, 'high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT tasks_resolution_kind_check CHECK (((resolution_kind IS NULL) OR (resolution_kind = ANY (ARRAY['fixed'::text, 'verified'::text, 'wont-fix'::text, 'duplicate'::text, 'not-reproducible'::text, 'superseded'::text, 'answered'::text])))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['backlog'::text, 'todo'::text, 'doing'::text, 'in-review'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT tasks_type_check CHECK ((type = ANY (ARRAY['feature'::text, 'bug'::text, 'improvement'::text, 'chore'::text, 'spike'::text, 'docs'::text])))
);


--
-- Name: COLUMN tasks.resolution_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.resolution_kind IS 'How it ended. `fixed` claims the change; `verified` says the fix was already present and this close is the record that somebody checked.';


--
-- Name: COLUMN tasks.claimed_session; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tasks.claimed_session IS 'Which session holds the claim, when the runtime can name one. NULL means unknown, never "nobody".';


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    id uuid NOT NULL,
    display_name text,
    avatar_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: _cairn_migrations _cairn_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._cairn_migrations
    ADD CONSTRAINT _cairn_migrations_pkey PRIMARY KEY (name);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_sessions app_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_pkey PRIMARY KEY (id);


--
-- Name: app_sessions app_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: connect_requests connect_requests_device_code_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_requests
    ADD CONSTRAINT connect_requests_device_code_hash_key UNIQUE (device_code_hash);


--
-- Name: connect_requests connect_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_requests
    ADD CONSTRAINT connect_requests_pkey PRIMARY KEY (id);


--
-- Name: instance_branding instance_branding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_branding
    ADD CONSTRAINT instance_branding_pkey PRIMARY KEY (id);


--
-- Name: lab_projects lab_projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_projects
    ADD CONSTRAINT lab_projects_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_pkey PRIMARY KEY (id);


--
-- Name: password_reset_tokens password_reset_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: subject_attachments subject_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_attachments
    ADD CONSTRAINT subject_attachments_pkey PRIMARY KEY (id);


--
-- Name: subject_attachments subject_attachments_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_attachments
    ADD CONSTRAINT subject_attachments_storage_path_key UNIQUE (storage_path);


--
-- Name: subject_human_notes subject_human_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_human_notes
    ADD CONSTRAINT subject_human_notes_pkey PRIMARY KEY (id);


--
-- Name: subject_members subject_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_members
    ADD CONSTRAINT subject_members_pkey PRIMARY KEY (subject_id, user_id);


--
-- Name: subject_notes subject_notes_dedupe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_notes
    ADD CONSTRAINT subject_notes_dedupe UNIQUE (subject_id, content_hash);


--
-- Name: subject_notes subject_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_notes
    ADD CONSTRAINT subject_notes_pkey PRIMARY KEY (id);


--
-- Name: subject_number_counter subject_number_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_number_counter
    ADD CONSTRAINT subject_number_counter_pkey PRIMARY KEY (singleton);


--
-- Name: subject_stages subject_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_stages
    ADD CONSTRAINT subject_stages_pkey PRIMARY KEY (id);


--
-- Name: subject_tags subject_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_tags
    ADD CONSTRAINT subject_tags_pkey PRIMARY KEY (subject_id, tag_id);


--
-- Name: subjects subjects_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_number_unique UNIQUE (number);


--
-- Name: subjects subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: task_activity_events task_activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_activity_events
    ADD CONSTRAINT task_activity_events_pkey PRIMARY KEY (id);


--
-- Name: task_attachments task_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_pkey PRIMARY KEY (id);


--
-- Name: task_attachments task_attachments_storage_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_storage_path_key UNIQUE (storage_path);


--
-- Name: task_comments task_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_pkey PRIMARY KEY (id);


--
-- Name: task_notes task_notes_dedupe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_notes
    ADD CONSTRAINT task_notes_dedupe UNIQUE (task_id, content_hash);


--
-- Name: task_notes task_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_notes
    ADD CONSTRAINT task_notes_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_number_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_number_unique UNIQUE (project_id, number);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: api_keys_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_active_idx ON public.api_keys USING btree (key_hash) WHERE (revoked_at IS NULL);


--
-- Name: api_keys_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_keys_user_idx ON public.api_keys USING btree (user_id);


--
-- Name: app_sessions_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_sessions_expiry_idx ON public.app_sessions USING btree (expires_at);


--
-- Name: app_sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_sessions_user_idx ON public.app_sessions USING btree (user_id);


--
-- Name: app_users_active_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_users_active_role_idx ON public.app_users USING btree (role) WHERE (deleted_at IS NULL);


--
-- Name: app_users_email_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX app_users_email_unique ON public.app_users USING btree (lower(email));


--
-- Name: connect_requests_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX connect_requests_expires_at_idx ON public.connect_requests USING btree (expires_at);


--
-- Name: connect_requests_user_code_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX connect_requests_user_code_live_idx ON public.connect_requests USING btree (user_code) WHERE (status = ANY (ARRAY['pending'::text, 'approved'::text]));


--
-- Name: lab_projects_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lab_projects_name_unique ON public.lab_projects USING btree (lower(name));


--
-- Name: password_reset_tokens_one_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX password_reset_tokens_one_live_idx ON public.password_reset_tokens USING btree (user_id) WHERE (used_at IS NULL);


--
-- Name: projects_external_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX projects_external_ref_key ON public.projects USING btree (external_ref) WHERE (external_ref IS NOT NULL);


--
-- Name: projects_key_unique_workspace; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX projects_key_unique_workspace ON public.projects USING btree (key);


--
-- Name: projects_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_owner_idx ON public.projects USING btree (owner_user_id);


--
-- Name: subject_attachments_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_attachments_subject_idx ON public.subject_attachments USING btree (subject_id, created_at);


--
-- Name: subject_human_notes_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_human_notes_subject_idx ON public.subject_human_notes USING btree (subject_id, created_at DESC);


--
-- Name: subject_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_members_user_idx ON public.subject_members USING btree (user_id);


--
-- Name: subject_notes_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_notes_subject_idx ON public.subject_notes USING btree (subject_id, created_at DESC);


--
-- Name: subject_stages_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX subject_stages_name_unique ON public.subject_stages USING btree (lower(name));


--
-- Name: subject_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subject_tags_tag_idx ON public.subject_tags USING btree (tag_id);


--
-- Name: subjects_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subjects_owner_idx ON public.subjects USING btree (owner_user_id) WHERE (owner_user_id IS NOT NULL);


--
-- Name: subjects_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subjects_project_idx ON public.subjects USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: subjects_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subjects_search_idx ON public.subjects USING gin (search_vector);


--
-- Name: subjects_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subjects_stage_idx ON public.subjects USING btree (stage_id, "position");


--
-- Name: subjects_visibility_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subjects_visibility_idx ON public.subjects USING btree (visibility) WHERE (visibility <> 'lab'::text);


--
-- Name: tags_name_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tags_name_unique ON public.tags USING btree (name);


--
-- Name: task_activity_events_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_activity_events_owner_idx ON public.task_activity_events USING btree (owner_user_id, created_at DESC);


--
-- Name: task_activity_events_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_activity_events_project_idx ON public.task_activity_events USING btree (project_id, created_at DESC) WHERE (project_id IS NOT NULL);


--
-- Name: task_activity_events_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_activity_events_subject_idx ON public.task_activity_events USING btree (subject_id) WHERE (subject_id IS NOT NULL);


--
-- Name: task_activity_evidence_sha_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_activity_evidence_sha_idx ON public.task_activity_events USING btree (task_id, event, ((data ->> 'sha'::text))) WHERE ((event = ANY (ARRAY['git_commit'::text, 'git_push'::text])) AND (data ? 'sha'::text));


--
-- Name: task_activity_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_activity_task_idx ON public.task_activity_events USING btree (task_id, created_at DESC);


--
-- Name: task_attachments_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_attachments_task_idx ON public.task_attachments USING btree (task_id);


--
-- Name: task_comments_external_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_comments_external_ref_key ON public.task_comments USING btree (external_ref) WHERE (external_ref IS NOT NULL);


--
-- Name: task_comments_mutation_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX task_comments_mutation_key ON public.task_comments USING btree (task_id, mutation_id);


--
-- Name: task_comments_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_comments_search_idx ON public.task_comments USING gin (to_tsvector('english'::regconfig, COALESCE(content, ''::text)));


--
-- Name: task_comments_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_comments_task_idx ON public.task_comments USING btree (task_id, created_at);


--
-- Name: task_notes_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_notes_kind_idx ON public.task_notes USING btree (task_id, kind);


--
-- Name: task_notes_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_notes_search_idx ON public.task_notes USING gin (to_tsvector('english'::regconfig, COALESCE(note, ''::text)));


--
-- Name: task_notes_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_notes_task_idx ON public.task_notes USING btree (task_id, created_at DESC);


--
-- Name: tasks_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_assignee_idx ON public.tasks USING btree (assignee_user_id) WHERE (status <> ALL (ARRAY['done'::text, 'cancelled'::text]));


--
-- Name: tasks_claimed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_claimed_idx ON public.tasks USING btree (claimed_by) WHERE (claimed_by IS NOT NULL);


--
-- Name: tasks_duplicate_of_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_duplicate_of_idx ON public.tasks USING btree (duplicate_of) WHERE (duplicate_of IS NOT NULL);


--
-- Name: tasks_external_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tasks_external_ref_key ON public.tasks USING btree (external_ref) WHERE (external_ref IS NOT NULL);


--
-- Name: tasks_handoff_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_handoff_ref_idx ON public.tasks USING btree (handoff_tracker, handoff_ref) WHERE (handoff_ref IS NOT NULL);


--
-- Name: tasks_has_resolution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_has_resolution_idx ON public.tasks USING btree (project_id, has_resolution) WHERE has_resolution;


--
-- Name: tasks_labels_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_labels_idx ON public.tasks USING gin (labels);


--
-- Name: tasks_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_parent_idx ON public.tasks USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: tasks_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_project_idx ON public.tasks USING btree (project_id);


--
-- Name: tasks_resolution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_resolution_idx ON public.tasks USING btree (project_id) WHERE (resolution IS NOT NULL);


--
-- Name: tasks_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_search_idx ON public.tasks USING gin (search_vector);


--
-- Name: tasks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_status_idx ON public.tasks USING btree (project_id, status);


--
-- Name: tasks_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_subject_idx ON public.tasks USING btree (subject_id) WHERE (subject_id IS NOT NULL);


--
-- Name: tasks_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_type_idx ON public.tasks USING btree (project_id, type);


--
-- Name: lab_projects lab_projects_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER lab_projects_touch BEFORE UPDATE ON public.lab_projects FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: projects projects_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER projects_touch BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: subject_attachments subject_attachments_touch_subject; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_attachments_touch_subject AFTER INSERT ON public.subject_attachments FOR EACH ROW EXECUTE FUNCTION public.touch_subject_from_note();


--
-- Name: subject_human_notes subject_human_notes_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_human_notes_touch BEFORE UPDATE ON public.subject_human_notes FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: subject_human_notes subject_human_notes_touch_subject; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_human_notes_touch_subject AFTER INSERT ON public.subject_human_notes FOR EACH ROW EXECUTE FUNCTION public.touch_subject_from_note();


--
-- Name: subject_notes subject_notes_touch_subject; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_notes_touch_subject AFTER INSERT ON public.subject_notes FOR EACH ROW EXECUTE FUNCTION public.touch_subject_from_note();


--
-- Name: subject_stages subject_stages_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_stages_touch BEFORE UPDATE ON public.subject_stages FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: subject_tags subject_tags_touch_subject; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subject_tags_touch_subject AFTER INSERT OR DELETE ON public.subject_tags FOR EACH ROW EXECUTE FUNCTION public.touch_subject_from_tag();


--
-- Name: subjects subjects_assign_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subjects_assign_number BEFORE INSERT ON public.subjects FOR EACH ROW EXECUTE FUNCTION public.assign_subject_number();


--
-- Name: subjects subjects_require_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subjects_require_owner BEFORE INSERT OR UPDATE OF visibility, owner_user_id ON public.subjects FOR EACH ROW EXECUTE FUNCTION public.subjects_require_owner();


--
-- Name: subjects subjects_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER subjects_touch BEFORE UPDATE ON public.subjects FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: tags tags_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tags_touch BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: task_activity_events task_activity_stamp_subject; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_activity_stamp_subject BEFORE INSERT ON public.task_activity_events FOR EACH ROW EXECUTE FUNCTION public.task_activity_stamp_subject();


--
-- Name: task_attachments task_attachments_touch_task; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_attachments_touch_task AFTER INSERT OR DELETE ON public.task_attachments FOR EACH ROW EXECUTE FUNCTION public.touch_task_from_note();


--
-- Name: task_comments task_comments_reindex; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_comments_reindex AFTER INSERT OR DELETE OR UPDATE OF content ON public.task_comments FOR EACH ROW EXECUTE FUNCTION public.refresh_task_comments_text();


--
-- Name: task_comments task_comments_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_comments_touch BEFORE UPDATE ON public.task_comments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: task_notes task_notes_touch_task; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER task_notes_touch_task AFTER INSERT OR DELETE OR UPDATE ON public.task_notes FOR EACH ROW EXECUTE FUNCTION public.touch_task_from_note();


--
-- Name: tasks tasks_assign_number; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_assign_number BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.assign_task_number();


--
-- Name: tasks tasks_default_assignee; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_default_assignee BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.tasks_default_assignee();


--
-- Name: tasks tasks_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_touch BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: user_profiles user_profiles_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: api_keys api_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: app_sessions app_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: connect_requests connect_requests_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connect_requests
    ADD CONSTRAINT connect_requests_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: instance_branding instance_branding_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_branding
    ADD CONSTRAINT instance_branding_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: password_reset_tokens password_reset_tokens_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: password_reset_tokens password_reset_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_tokens
    ADD CONSTRAINT password_reset_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: projects projects_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: subject_attachments subject_attachments_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_attachments
    ADD CONSTRAINT subject_attachments_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;


--
-- Name: subject_attachments subject_attachments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_attachments
    ADD CONSTRAINT subject_attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: subject_human_notes subject_human_notes_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_human_notes
    ADD CONSTRAINT subject_human_notes_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;


--
-- Name: subject_human_notes subject_human_notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_human_notes
    ADD CONSTRAINT subject_human_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: subject_members subject_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_members
    ADD CONSTRAINT subject_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: subject_members subject_members_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_members
    ADD CONSTRAINT subject_members_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;


--
-- Name: subject_members subject_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_members
    ADD CONSTRAINT subject_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: subject_notes subject_notes_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_notes
    ADD CONSTRAINT subject_notes_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;


--
-- Name: subject_notes subject_notes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_notes
    ADD CONSTRAINT subject_notes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: subject_tags subject_tags_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_tags
    ADD CONSTRAINT subject_tags_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE CASCADE;


--
-- Name: subject_tags subject_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subject_tags
    ADD CONSTRAINT subject_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: subjects subjects_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE SET NULL;


--
-- Name: subjects subjects_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.lab_projects(id) ON DELETE RESTRICT;


--
-- Name: subjects subjects_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES public.subject_stages(id) ON DELETE RESTRICT;


--
-- Name: task_activity_events task_activity_events_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_activity_events
    ADD CONSTRAINT task_activity_events_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: task_activity_events task_activity_events_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_activity_events
    ADD CONSTRAINT task_activity_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: task_activity_events task_activity_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_activity_events
    ADD CONSTRAINT task_activity_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: task_attachments task_attachments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_attachments
    ADD CONSTRAINT task_attachments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_comments task_comments_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_comments
    ADD CONSTRAINT task_comments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: task_notes task_notes_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_notes
    ADD CONSTRAINT task_notes_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.app_users(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: tasks tasks_duplicate_of_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_duplicate_of_fkey FOREIGN KEY (duplicate_of) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE RESTRICT;


--
-- Name: user_profiles user_profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_id_fkey FOREIGN KEY (id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


