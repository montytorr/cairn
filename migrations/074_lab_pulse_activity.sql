-- ===========================================================================
-- 074: the Lab moves the live-update pulse and shows in the activity feed
-- (CAIRN-366)
--
-- Every page listens to one fingerprint, cairn_pulse (037, made
-- workspace-wide by 048), and refreshes when it changes. Croft's 071, 074 and
-- 075 taught it the lab; this is the same, on Cairn's own definition, which
-- still has its sessions and knowledge arms. The method is the tasks' one: the
-- newest timestamp and a count per store, since a deletion moves no max.
-- Project scope stays tasks-only, as 037 decided; Lab pages subscribe
-- unscoped.
--
-- The activity feed gains, while the Lab is on, the subject events (filed,
-- moved, archived, restored, deleted — recorded with `subject_id`, their ref
-- and title in `data`) and the subject log, as note rows. Transformed in
-- place (055) at three anchors, each of which must appear exactly once.
-- ===========================================================================

create or replace function cairn_pulse(p_owner uuid, p_project text default null)
returns text
language sql
stable
security definer
set search_path = public
as $$
  with scoped_tasks as (
    select t.updated_at
      from tasks t
      join projects p on p.id = t.project_id
     where p_project is null or p.key = upper(p_project)
  )
  select concat_ws('|',
    coalesce(max(updated_at)::text, '-') || ':' || count(*)::text,
    case when p_project is not null then '' else (
      select coalesce(max(s.updated_at)::text, '-') || ':' || count(*)::text
        from sessions s
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(k.updated_at)::text, '-') || ':' || count(*)::text
        from knowledge k
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(e.created_at)::text, '-')
        from task_activity_events e
    ) end,
    -- 074: the Lab. A subject's updated_at moves on edits, log notes, people's
    -- notes, files and tags (071's touch triggers); the rest are counted
    -- because a deletion moves no max.
    case when p_project is not null then '' else (
      select coalesce(max(su.updated_at)::text, '-') || ':' || count(*)::text
        from subjects su
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(n.created_at)::text, '-') || ':' || count(*)::text
        from subject_notes n
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(hn.updated_at)::text, '-') || ':' || count(*)::text
        from subject_human_notes hn
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(sa.created_at)::text, '-') || ':' || count(*)::text
        from subject_attachments sa
    ) end,
    case when p_project is not null then '' else (
      select count(*)::text from subject_tags x
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(st.updated_at)::text, '-') || ':' || count(*)::text
        from lab_stages st
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(tg.updated_at)::text, '-') || ':' || count(*)::text
        from lab_tags tg
    ) end,
    case when p_project is not null then '' else (
      select coalesce(max(ls.updated_at)::text, '-') from lab_settings ls
    ) end
  )
  from scoped_tasks;
$$;

revoke all on function cairn_pulse(uuid, text) from public;

comment on function cairn_pulse(uuid, text) is
  'One string that changes whenever anything visible changes: tasks, sessions, knowledge, '
  'activity, and the Lab (subjects, their log, people''s notes, files and tags, stages, tags, '
  'settings). Read by the SSE stream every few seconds, so it must stay index-cheap.';

do $migration$
declare
  definition text;
  updated text;
  old_where text;
  new_where text;
  old_detail text;
  new_detail text;
  old_everything text;
  new_everything text;
  found int;
begin
  definition := pg_get_functiondef('activity_feed(uuid, timestamptz, int, text, text, text[])'::regprocedure);

  if definition like '%074: the Lab%' then
    raise notice 'activity_feed already shows the Lab; nothing to do';
    return;
  end if;

  old_where := $old$    where e.created_at < c.before
      and (w.all_kinds or 'event' = any (w.kinds))$old$;
  new_where := $new$    where e.created_at < c.before
      and (w.all_kinds or 'event' = any (w.kinds))
      -- 074: the Lab. Subject events only while it is on.
      and (e.subject_id is null or exists (select 1 from lab_settings ls where ls.enabled))$new$;

  old_detail := $old$             when 'run_result' then 'run_result ' || coalesce(e.data->>'status', '?')$old$;
  new_detail := $new$             when 'run_result' then 'run_result ' || coalesce(e.data->>'status', '?')
             when 'subject_stage_changed' then coalesce(e.data->>'from', '?') || ' → ' || coalesce(e.data->>'to', '?')$new$;

  old_everything := $old$  everything as (
    select * from filed     union all
    select * from events    union all
    select * from notes     union all
    select * from comments  union all
    select * from sessions_ union all
    select * from knowledge_
  )$old$;
  new_everything := $new$  -- 074: the Lab. A subject's log, as note rows under its ref.
  subject_notes_ as (
    select 'note'::text as kind, sn.created_at as at, sn.actor_id as actor,
           sp.key as project_key, 'LAB-' || s.number as ref,
           cairn_clip(regexp_replace(sn.note, '\s+', ' ', 'g'), 160) as title,
           sn.kind as detail
    from subject_notes sn
    join subjects s on s.id = sn.subject_id
    left join projects sp on sp.id = s.project_id
    cross join want w, ceiling c
    where sn.created_at < c.before
      and (w.all_kinds or 'note' = any (w.kinds))
      and exists (select 1 from lab_settings ls where ls.enabled)
  ),

  everything as (
    select * from filed     union all
    select * from events    union all
    select * from notes     union all
    select * from comments  union all
    select * from sessions_ union all
    select * from knowledge_ union all
    select * from subject_notes_
  )$new$;

  found := (length(definition) - length(replace(definition, old_where, ''))) / length(old_where);
  if found <> 1 then
    raise exception 'activity_feed: expected exactly one events filter to extend, found %', found;
  end if;
  found := (length(definition) - length(replace(definition, old_detail, ''))) / length(old_detail);
  if found <> 1 then
    raise exception 'activity_feed: expected exactly one run_result detail to extend, found %', found;
  end if;
  found := (length(definition) - length(replace(definition, old_everything, ''))) / length(old_everything);
  if found <> 1 then
    raise exception 'activity_feed: expected exactly one everything CTE to extend, found %', found;
  end if;

  updated := replace(replace(replace(definition, old_where, new_where), old_detail, new_detail),
                     old_everything, new_everything);

  if updated = definition
     or updated not like '%select * from subject_notes_%'
     or updated not like '%e.subject_id is null or exists%'
     or updated not like '%subject_stage_changed%' then
    raise exception 'activity_feed: the rewrite did not add the Lab';
  end if;
  -- What it must not have cost: 040's left joins, 057's renamed-project
  -- titles, 058's knowledge revisions and 048's removal of owner predicates.
  if updated not like '%left join tasks t    on t.id = e.task_id%'
     or updated not like '%project_key_changed%'
     or updated not like '%knowledge_revisions first%'
     or updated like '%owner_user_id = p_owner%' then
    raise exception 'activity_feed: the rewrite lost behaviour an earlier migration installed';
  end if;

  execute updated;
end
$migration$;
