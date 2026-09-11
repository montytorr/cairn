-- ===========================================================================
-- 015: file_touches — recall keyed to a path, with no query to write
--
-- The single best retrieval mechanism in the store this replaces, and the only
-- one that needed no agent discipline at all: before a file is read, say what
-- is already known about it. No search string, no decision to remember, no
-- tool call the model has to choose to make.
--
-- Cairn has had no file index whatsoever -- `cairn files` lists attachments.
--
-- Nothing here costs a model call. Paths come straight out of a transcript at
-- session end, or off `cairn note --file`. That is the whole reason this is
-- affordable when per-tool-use observation was not.
--
-- Paths are stored repo-relative where a repo root can be determined, absolute
-- otherwise. Storing both forms of the same file would split its history in
-- two, which is exactly the failure this table exists to avoid.
-- ===========================================================================

create table file_touches (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,

  path          text not null,
  repo          text,

  project_id    uuid references projects(id)  on delete cascade,
  session_id    uuid references sessions(id)  on delete cascade,
  task_id       uuid references tasks(id)     on delete cascade,
  knowledge_id  uuid references knowledge(id) on delete cascade,

  kind          text not null default 'touched'
                  check (kind in ('touched', 'modified', 'discussed')),
  created_at    timestamptz not null default now(),

  -- a row that points at nothing is unreachable noise
  constraint file_touches_has_a_source check (
    session_id is not null or task_id is not null or knowledge_id is not null
  )
);

create index file_touches_path_idx  on file_touches (owner_user_id, path, created_at desc);
create index file_touches_base_idx  on file_touches (owner_user_id, (split_part(path, '/', -1)));
create index file_touches_task_idx  on file_touches (task_id) where task_id is not null;

comment on table file_touches is
  'Which sessions, tasks and knowledge concern a given file. Populated '
  'deterministically -- never by a model -- so it stays cheap enough to write '
  'on every session.';
comment on index file_touches_base_idx is
  'Basename lookup, for when the caller has a path rooted differently from the '
  'one that was recorded.';

alter table file_touches enable row level security;

create policy file_touches_owner on file_touches
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());
