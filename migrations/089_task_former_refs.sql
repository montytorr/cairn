-- ===========================================================================
-- A moved task used to orphan the ref it was filed under.
--
-- `move_task` renumbers the task from the target project's counter, so ABC-46
-- moved to XYZ became XYZ-8 and ABC-46 stopped resolving. Refs escape into
-- commit messages, PR titles and other agents' notes, which a move cannot
-- reach — the same problem project_former_keys answers for a key rename.
--
-- The alias stores the project's id, not its key, so a later rename of the
-- source project still resolves through project_former_keys. It points at the
-- task, so a task moved twice keeps every ref it ever had. A live task always
-- wins over an alias: numbers are never reissued, but resolution tries the
-- live row first anyway.
-- ===========================================================================

create table if not exists task_former_refs (
  project_id uuid not null references projects (id) on delete cascade,
  number     integer not null,
  task_id    uuid not null references tasks (id) on delete cascade,
  moved_at   timestamptz not null default now(),
  primary key (project_id, number)
);

create index if not exists task_former_refs_task_idx
  on task_former_refs (task_id);

create or replace function move_task(p_owner uuid, p_task uuid, p_project uuid)
returns table (id uuid, number integer, project_key text)
language plpgsql as $$
declare
  v_next integer;
  v_key text;
  v_old_project uuid;
  v_old_number integer;
begin
  select tasks.project_id, tasks.number into v_old_project, v_old_number
    from tasks where tasks.id = p_task;
  if not found then
    raise exception 'task not found';
  end if;

  select projects.key into v_key from projects where projects.id = p_project;
  if v_key is null then raise exception 'project not found'; end if;

  update projects
     set task_counter = task_counter + 1
   where projects.id = p_project
  returning task_counter into v_next;

  insert into task_former_refs (project_id, number, task_id)
  values (v_old_project, v_old_number, p_task)
  on conflict on constraint task_former_refs_pkey
  do update set task_id = excluded.task_id, moved_at = now();

  update tasks set project_id = p_project, number = v_next where tasks.id = p_task;
  return query select p_task, v_next, v_key;
end;
$$;
