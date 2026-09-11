-- ===========================================================================
-- 017: task_projects — work that spans several projects
--
-- A task lives in exactly one project and takes its ref from that project's
-- counter. That is worth keeping: CAI-42 is a stable name precisely because
-- nothing moves it.
--
-- But some work genuinely belongs to several projects at once -- an infra
-- change that lands in four services, a convention adopted everywhere. Until
-- now the choice was to file it in the wrong place or to file it four times.
--
-- So: the home project stays, and secondary links are additive. The task shows
-- up in the other projects' lists, boards and filters as a guest, keeping its
-- original ref.
--
-- Worth recording because it is already true and nobody has used it: parent_id
-- is a plain task FK with no same-project constraint, so sub-tasks can already
-- live in different projects. An epic in CAIRN with children in HM and AT
-- works today. What was missing is only that nothing shows which project a
-- child is in.
-- ===========================================================================

create table task_projects (
  task_id    uuid not null references tasks(id)    on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, project_id)
);

create index task_projects_project_idx on task_projects (project_id);

comment on table task_projects is
  'Secondary project links. The task keeps its home projects.project_id, and '
  'therefore its ref; these rows only widen where it appears.';

-- A link to the home project would make the task appear in its own list twice.
create or replace function reject_home_project_link()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from tasks t
              where t.id = new.task_id and t.project_id = new.project_id) then
    raise exception 'task is already filed in that project';
  end if;
  return new;
end;
$$;

create trigger task_projects_not_home
  before insert or update on task_projects
  for each row execute function reject_home_project_link();
