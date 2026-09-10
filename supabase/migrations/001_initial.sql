-- ===========================================================================
-- Cairn — initial schema
--
-- Design notes:
--   * `owner_user_id` on `projects` is the single RLS anchor. Everything else
--     derives access from its project.
--   * Agents are NOT owning identities. They are named actors attached to API
--     keys, recorded as (actor_type, actor_id) on every write, so "who tried
--     what, and did it work" is always answerable.
--   * Tasks carry a human-readable identifier (`<project.key>-<number>`, e.g.
--     CAI-42). Agents refer to work in prose across sessions; a UUID is not
--     resolvable in a transcript weeks later, and costs ~13 tokens per row.
--   * `status` is human intent. Claiming (`claimed_by`/`heartbeat_at`) is
--     execution state. They are deliberately orthogonal.
--   * `resolution` is required on close by the API, not by a DB constraint,
--     so that data imports and admin fixes stay possible.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enum-ish domains, as CHECK constraints. Extending one is a one-line
-- migration, which is cheap enough not to warrant lookup tables.
-- ---------------------------------------------------------------------------
-- task.type            feature | bug | improvement | chore | spike | docs
-- task.status          backlog | todo | doing | in-review | done | cancelled
-- task.priority        urgent | high | medium | low
-- actor_type           human | agent

-- ---------------------------------------------------------------------------
-- user_profiles
-- ---------------------------------------------------------------------------
create table user_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- projects
-- ---------------------------------------------------------------------------
create table projects (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  key           text not null,           -- short prefix for task ids, e.g. 'CAI'
  title         text not null,
  description   text,                    -- markdown
  status        text not null default 'active'
                check (status in ('planning','active','paused','completed','archived')),
  position      integer not null default 0,
  task_counter  integer not null default 0,  -- serialises per-project task numbers
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint projects_key_format check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  constraint projects_key_unique_per_owner unique (owner_user_id, key)
);

create index projects_owner_idx on projects(owner_user_id);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table tasks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  -- Per-project sequence. Callers omit it; the BEFORE INSERT trigger fills it,
  -- which runs before constraints are evaluated, so NOT NULL is safe here.
  number      integer not null,
  title       text not null,
  description text,                      -- markdown; source of truth for the body

  type        text not null default 'feature'
              check (type in ('feature','bug','improvement','chore','spike','docs')),
  status      text not null default 'backlog'
              check (status in ('backlog','todo','doing','in-review','done','cancelled')),
  priority    text not null default 'medium'
              check (priority in ('urgent','high','medium','low')),

  labels      text[] not null default '{}',
  due_date    date,
  position    integer not null default 0,

  -- who created it (human or agent)
  actor_type  text not null default 'human' check (actor_type in ('human','agent')),
  actor_id    text not null,

  -- --- execution state: orthogonal to `status` -----------------------------
  -- The whole coordination layer. Claiming and lease-stealing are a single
  -- conditional UPDATE; staleness is computed on read, so there is no reaper.
  claimed_by         text,               -- 'claude-code' | 'codex' | 'openclaw' | ...
  claimed_at         timestamptz,
  heartbeat_at       timestamptz,
  attempt            integer not null default 0,   -- increments per claim; spots thrashing

  -- the single resumable checkpoint. Checkpoint *history* is not kept here;
  -- the latest is what another agent needs in order to take over.
  checkpoint_summary text,
  checkpoint_payload jsonb,
  checkpoint_at      timestamptz,

  blocked_reason     text,
  blocked_at         timestamptz,

  -- --- resolution: what makes a closed task worth finding ------------------
  resolution      text,                  -- markdown: what was actually done, and why
  resolution_kind text check (resolution_kind in
                    ('fixed','wont-fix','duplicate','not-reproducible','superseded','answered')),
  resolved_at     timestamptz,
  resolved_by     text,

  -- --- optional linkage out to claude-mem (episodic session log) -----------
  memory_session_id text,
  observation_ids   jsonb,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint tasks_number_unique unique (project_id, number),

  -- Two volatility rules bite here, and both were found by the database
  -- rejecting this column rather than by reading the docs:
  --
  --  1. The ::regconfig cast is required, not cosmetic. to_tsvector(text, text)
  --     is only STABLE, because the config name resolves through search_path at
  --     runtime, whereas to_tsvector(regconfig, text) is IMMUTABLE. Generated
  --     columns demand IMMUTABLE.
  --  2. `labels` is deliberately absent. array_to_string(anyarray, text) is
  --     also only STABLE, so it cannot appear here at all. No loss: labels have
  --     their own GIN index below, which is the right way to filter them.
  --
  -- Weighting is deliberate: a task's title and its resolution are the two
  -- highest-value pieces of text in the system, because they are what a future
  -- agent needs when asking "has this already been solved?".
  search_vector tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, coalesce(title, '')),       'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(resolution, '')),  'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B')
  ) stored
);

create index tasks_project_idx    on tasks(project_id);
create index tasks_status_idx     on tasks(project_id, status);
create index tasks_type_idx       on tasks(project_id, type);
create index tasks_labels_idx     on tasks using gin(labels);
create index tasks_search_idx     on tasks using gin(search_vector);
create index tasks_claimed_idx    on tasks(claimed_by) where claimed_by is not null;
create index tasks_resolution_idx on tasks(project_id) where resolution is not null;

-- ---------------------------------------------------------------------------
-- task_notes — the append-only work log
--
-- Distinct from comments on purpose. Comments are conversation aimed at a
-- human reader; notes are the debugging trail aimed at the next agent. A
-- recorded dead end ("tried bumping the pool size, no difference") is worth
-- as much as a fix, and saves the next agent from repeating it.
-- ---------------------------------------------------------------------------
create table task_notes (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  actor_type   text not null check (actor_type in ('human','agent')),
  actor_id     text not null,
  note         text not null,            -- markdown
  kind         text not null default 'note'
               check (kind in ('note','finding','decision','attempt','handoff')),
  facts        jsonb,                    -- optional array of atomic one-liners
  content_hash text,                     -- makes a retrying agent's write idempotent
  created_at   timestamptz not null default now(),
  constraint task_notes_dedupe unique (task_id, content_hash)
);

create index task_notes_task_idx on task_notes(task_id, created_at desc);
create index task_notes_kind_idx on task_notes(task_id, kind);
create index task_notes_search_idx on task_notes
  using gin(to_tsvector('english'::regconfig, coalesce(note, '')));

-- ---------------------------------------------------------------------------
-- task_comments
-- ---------------------------------------------------------------------------
create table task_comments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references tasks(id) on delete cascade,
  actor_type   text not null check (actor_type in ('human','agent')),
  actor_id     text not null,
  content      text not null,            -- markdown
  comment_type text not null default 'comment'
               check (comment_type in ('comment','status_change','assignment','system')),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index task_comments_task_idx on task_comments(task_id, created_at);
create index task_comments_search_idx on task_comments
  using gin(to_tsvector('english'::regconfig, coalesce(content, '')));

-- ---------------------------------------------------------------------------
-- task_attachments
-- ---------------------------------------------------------------------------
create table task_attachments (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references tasks(id) on delete cascade,
  actor_type    text not null check (actor_type in ('human','agent')),
  actor_id      text not null,
  filename      text not null,           -- sanitised, stored name
  original_name text not null,
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  storage_path  text not null unique,
  sha256        text,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index task_attachments_task_idx on task_attachments(task_id);

-- ---------------------------------------------------------------------------
-- task_activity_events — append-only feed
-- ---------------------------------------------------------------------------
create table task_activity_events (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references tasks(id) on delete cascade,
  actor_type text not null check (actor_type in ('human','agent')),
  actor_id   text not null,
  event      text not null,              -- 'created' | 'status_changed' | 'claimed' | ...
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index task_activity_task_idx on task_activity_events(task_id, created_at desc);

-- ---------------------------------------------------------------------------
-- task_deps — untyped on purpose. `blocks(a, b)` is enough to stop an agent
-- picking up work that is not ready.
-- ---------------------------------------------------------------------------
create table task_deps (
  blocked_id  uuid not null references tasks(id) on delete cascade,
  blocking_id uuid not null references tasks(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocked_id, blocking_id),
  constraint task_deps_no_self check (blocked_id <> blocking_id)
);

create index task_deps_blocking_idx on task_deps(blocking_id);

-- ---------------------------------------------------------------------------
-- api_keys
--
-- One key per agent. The key's `agent_name` IS the actor stamped on every
-- write it makes, which is what makes the shared memory attributable.
-- Plaintext is shown once at creation and never stored.
-- ---------------------------------------------------------------------------
create table api_keys (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  agent_name      text not null,         -- 'claude-code' | 'codex' | 'openclaw' | 'cli'
  platform_source text,                  -- mirrors claude-mem's column name, for later joins
  name            text not null,         -- human-facing label
  key_prefix      text not null,         -- first 8 chars, for display only
  key_hash        text not null unique,  -- sha256 of the full key
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index api_keys_user_idx on api_keys(user_id);
create index api_keys_active_idx on api_keys(key_hash) where revoked_at is null;

-- ===========================================================================
-- Triggers
-- ===========================================================================

-- updated_at
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger user_profiles_touch  before update on user_profiles
  for each row execute function touch_updated_at();
create trigger projects_touch       before update on projects
  for each row execute function touch_updated_at();
create trigger tasks_touch          before update on tasks
  for each row execute function touch_updated_at();
create trigger task_comments_touch  before update on task_comments
  for each row execute function touch_updated_at();

-- Per-project task numbers. Incrementing the counter on `projects` row-locks
-- that project, which serialises task creation per project. That is correct
-- and cheap; a MAX(number)+1 lookup would race under concurrent inserts.
create or replace function assign_task_number() returns trigger
language plpgsql as $$
begin
  if new.number is null then
    update projects
       set task_counter = task_counter + 1
     where id = new.project_id
    returning task_counter into new.number;
  end if;
  return new;
end $$;

create trigger tasks_assign_number before insert on tasks
  for each row execute function assign_task_number();

-- ===========================================================================
-- Row Level Security
--
-- Every policy resolves to `projects.owner_user_id = auth.uid()`. The API
-- routes authenticate bearer keys and then act via the service role (which
-- bypasses RLS), so this is the boundary for the browser client and a
-- defence-in-depth layer behind the API.
--
-- Deliberately NOT the pattern of granting `FOR SELECT TO authenticated
-- USING (true)`, which would let any signed-in user read every task.
-- ===========================================================================

create or replace function owns_project(p uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from projects
     where projects.id = p and projects.owner_user_id = auth.uid()
  );
$$;

create or replace function owns_task(t uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from tasks
      join projects on projects.id = tasks.project_id
     where tasks.id = t and projects.owner_user_id = auth.uid()
  );
$$;

alter table user_profiles        enable row level security;
alter table projects             enable row level security;
alter table tasks                enable row level security;
alter table task_notes           enable row level security;
alter table task_comments        enable row level security;
alter table task_attachments     enable row level security;
alter table task_activity_events enable row level security;
alter table task_deps            enable row level security;
alter table api_keys             enable row level security;

create policy user_profiles_self on user_profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy projects_owner on projects
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

create policy tasks_owner on tasks
  for all to authenticated
  using (owns_project(project_id)) with check (owns_project(project_id));

create policy task_notes_owner on task_notes
  for all to authenticated using (owns_task(task_id)) with check (owns_task(task_id));

create policy task_comments_owner on task_comments
  for all to authenticated using (owns_task(task_id)) with check (owns_task(task_id));

create policy task_attachments_owner on task_attachments
  for all to authenticated using (owns_task(task_id)) with check (owns_task(task_id));

create policy task_activity_owner on task_activity_events
  for all to authenticated using (owns_task(task_id)) with check (owns_task(task_id));

create policy task_deps_owner on task_deps
  for all to authenticated using (owns_task(blocked_id)) with check (owns_task(blocked_id));

-- API keys: owner-scoped. `key_hash` is never returned by application code.
create policy api_keys_owner on api_keys
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
