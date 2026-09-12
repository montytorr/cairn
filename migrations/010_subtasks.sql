-- ---------------------------------------------------------------------------
-- 010: sub-tasks
--
-- Dependencies say *ordering*. They do not say *containment*. An agent given
-- "migrate BB/Trade" wants to split it into six pieces and have the parent
-- report progress; until now the only way to express that was prose in the
-- body, which nothing can query.
-- ---------------------------------------------------------------------------

alter table tasks
  add column parent_id uuid references tasks(id) on delete set null;

-- SET NULL, not CASCADE. Deleting an epic must not silently destroy the work
-- recorded against its children — the children become top-level instead, and
-- their resolutions survive.

alter table tasks
  add constraint tasks_parent_not_self check (parent_id is null or parent_id <> id);

create index tasks_parent_idx on tasks(parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- Cycle guard.
--
-- The self-check above stops a -> a. It cannot stop a -> b -> a, and a cycle
-- makes the rollup infinite, so the walk has to happen somewhere. Doing it
-- here keeps it to one round trip and one definition, rather than a bounded
-- loop in the API that quietly disagrees with the database.
-- ---------------------------------------------------------------------------
create or replace function task_is_descendant(p_candidate uuid, p_ancestor uuid)
returns boolean
language sql
stable
as $$
  with recursive up as (
    select id, parent_id from tasks where id = p_candidate
    union all
    select t.id, t.parent_id from tasks t join up on t.id = up.parent_id
  )
  select exists (select 1 from up where id = p_ancestor);
$$;

comment on function task_is_descendant is
  'True when p_candidate is p_ancestor, or is nested anywhere beneath it. '
  'Used to refuse a parent assignment that would close a loop.';
