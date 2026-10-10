-- ===========================================================================
-- 075: a subject knows where it was named (CAIRN-366)
--
-- `LAB-12` written in a task's description, resolution, note or comment is a
-- mention of the subject, indexed by the same function and triggers that keep
-- task_mentions (059), so every path that writes task text keeps both. A ref
-- is kept only when the subject exists, as a task ref is only kept when it
-- resolves. `LAB` is never a project key (071), so the task side never sees it.
--
-- Mentions are recorded whether or not the Lab is on, and read only while it
-- is: turning the Lab on shows what was already written.
-- ===========================================================================

create table if not exists subject_mentions (
  id                 uuid primary key default gen_random_uuid(),
  target_subject_id  uuid not null references subjects(id) on delete cascade,
  source_task_id     uuid not null references tasks(id) on delete cascade,
  source             text not null check (source in ('note', 'comment', 'description', 'resolution')),
  note_id            uuid references task_notes(id) on delete cascade,
  comment_id         uuid references task_comments(id) on delete cascade,
  ref_as_written     text not null,
  created_at         timestamptz not null default now(),

  constraint subject_mentions_source_row check (
    (source = 'note' and note_id is not null and comment_id is null) or
    (source = 'comment' and comment_id is not null and note_id is null) or
    (source in ('description', 'resolution') and note_id is null and comment_id is null)
  )
);

create unique index if not exists subject_mentions_unique_idx
  on subject_mentions (source, coalesce(note_id, comment_id, source_task_id), target_subject_id);
create index if not exists subject_mentions_target_idx
  on subject_mentions (target_subject_id, created_at desc);
create index if not exists subject_mentions_source_task_idx
  on subject_mentions (source_task_id);

-- 059's body, unchanged apart from the subject half at the end: the delete
-- and the insert for `LAB-n` run on every refresh, so an edit that drops a
-- subject ref drops its mention too.
create or replace function task_mentions_refresh(
  p_source text,
  p_source_task uuid,
  p_note uuid,
  p_comment uuid,
  p_text text,
  p_at timestamptz
) returns void
language plpgsql
set search_path = public
as $$
begin
  delete from task_mentions m
   where m.source = p_source
     and m.source_task_id = p_source_task
     and m.note_id is not distinct from p_note
     and m.comment_id is not distinct from p_comment;

  delete from subject_mentions m
   where m.source = p_source
     and m.source_task_id = p_source_task
     and m.note_id is not distinct from p_note
     and m.comment_id is not distinct from p_comment;

  if p_text is null or p_text !~ '[A-Z][A-Z0-9]{1,9}-[0-9]' then
    return;
  end if;

  insert into task_mentions
    (target_task_id, source_task_id, source, note_id, comment_id, ref_as_written, created_at)
  select distinct on (t.id)
         t.id, p_source_task, p_source, p_note, p_comment, r.written, coalesce(p_at, now())
    from (
      select m[1] as key, m[2]::int as number, m[1] || '-' || m[2] as written
        from regexp_matches(p_text, '\m([A-Z][A-Z0-9]{1,9})-([0-9]{1,6})\M', 'g') as m
    ) r
    join lateral (
      select p.id from projects p where p.key = r.key
      union
      select f.project_id from project_former_keys f where f.key = r.key
    ) pr on true
    join tasks t on t.project_id = pr.id and t.number = r.number
   where t.id <> p_source_task
   order by t.id, r.written
  on conflict do nothing;

  -- 075: Lab subjects.
  if p_text ~ '\mLAB-[0-9]' then
    insert into subject_mentions
      (target_subject_id, source_task_id, source, note_id, comment_id, ref_as_written, created_at)
    select distinct on (s.id)
           s.id, p_source_task, p_source, p_note, p_comment, 'LAB-' || r.number, coalesce(p_at, now())
      from (
        select m[1]::int as number
          from regexp_matches(p_text, '\mLAB-([0-9]{1,7})\M', 'g') as m
      ) r
      join subjects s on s.number = r.number
     order by s.id
    on conflict do nothing;
  end if;
end
$$;

-- Everything already written, through the same function.
select task_mentions_refresh('note', n.task_id, n.id, null, n.note, n.created_at)
  from task_notes n
 where n.note ~ '\mLAB-[0-9]';

select task_mentions_refresh('comment', c.task_id, null, c.id, c.content, c.created_at)
  from task_comments c
 where c.content ~ '\mLAB-[0-9]';

select task_mentions_refresh('description', t.id, null, null, t.description, t.created_at)
  from tasks t
 where t.description ~ '\mLAB-[0-9]';

select task_mentions_refresh('resolution', t.id, null, null, t.resolution, coalesce(t.resolved_at, t.updated_at))
  from tasks t
 where t.resolution ~ '\mLAB-[0-9]';
