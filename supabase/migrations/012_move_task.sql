-- ---------------------------------------------------------------------------
-- 012: move a task to another project
--
-- Per-project numbering means a move is not a field edit: the task needs a
-- fresh number from the target's counter, and its ref changes. Two statements
-- through PostgREST could allocate a number and then fail to use it, so this
-- is one function and one transaction.
-- ---------------------------------------------------------------------------

create or replace function move_task(p_owner uuid, p_task uuid, p_project uuid)
returns table (id uuid, number integer, project_key text)
language plpgsql
as $$
declare
  v_next integer;
  v_key  text;
begin
  -- Both ends must belong to the caller. The function runs with the service
  -- role, so this is the only thing standing between one owner and another's
  -- data; it is not a convenience check.
  if not exists (
    select 1 from tasks t join projects p on p.id = t.project_id
     where t.id = p_task and p.owner_user_id = p_owner
  ) then
    raise exception 'task not found';
  end if;

  select p.key into v_key
    from projects p
   where p.id = p_project and p.owner_user_id = p_owner;

  if v_key is null then
    raise exception 'project not found';
  end if;

  -- Same row-lock discipline as the insert trigger. MAX(number)+1 would race
  -- with a concurrent agent filing into the same project.
  update projects
     set task_counter = task_counter + 1
   where projects.id = p_project
  returning task_counter into v_next;

  update tasks
     set project_id = p_project,
         number = v_next
   where tasks.id = p_task;

  return query select p_task, v_next, v_key;
end;
$$;

comment on function move_task is
  'Moves a task to another project, allocating a number from the target''s '
  'counter. The task ref changes, so any prose referring to the old one goes '
  'stale — the caller is expected to say so.';
