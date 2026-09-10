-- ===========================================================================
-- External references, for content imported from another tracker.
--
-- Migrated tasks keep a pointer home so the original is findable and a
-- re-import can be made idempotent rather than duplicating everything.
-- ===========================================================================

alter table projects
  add column if not exists external_ref text,
  add column if not exists external_url text;

alter table tasks
  add column if not exists external_ref text,   -- e.g. 'BBTRADE-1135'
  add column if not exists external_url text;

alter table task_comments
  add column if not exists external_ref text;

-- Makes a re-run of an import update rather than duplicate. Partial, so the
-- overwhelming majority of rows (which have no external ref) are unaffected.
create unique index if not exists tasks_external_ref_key
  on tasks (external_ref) where external_ref is not null;

create unique index if not exists projects_external_ref_key
  on projects (external_ref) where external_ref is not null;

create unique index if not exists task_comments_external_ref_key
  on task_comments (external_ref) where external_ref is not null;

-- The imported identifier is how a human will actually search for old work
-- ("what was BBTRADE-902 about?"), so it belongs in the search vector.
-- Dropping and recreating because a generated column cannot be altered.
alter table tasks drop column if exists search_vector;

alter table tasks add column search_vector tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, coalesce(title, '')),        'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(resolution, '')),   'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(external_ref, '')), 'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(description, '')),  'B')
) stored;

create index if not exists tasks_search_idx on tasks using gin (search_vector);
