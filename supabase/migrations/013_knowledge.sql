-- ===========================================================================
-- 013: knowledge — what we know, as opposed to what we did
--
-- Every row in Cairn so far hangs off a task, and a task hangs off exactly one
-- project. That leaves nowhere to put the thing an agent most often needs:
-- "one overflow axis set to auto forces the other from visible to auto", or
-- "the Mac cannot reach clawdius' public IP, and it is WireGuard, not
-- Tailscale". Those belong to no task, and usually to no single project.
--
-- Two design decisions worth stating, because both are reactions to measured
-- failures in the store this replaces:
--
--   * Zero project links means global. There is no `scope` column to drift out
--     of agreement with the join table.
--
--   * `superseded_by` exists because the failure mode of every memory store we
--     have looked at is accumulation without correction. claude-mem holds
--     29,090 append-only rows and offers no way to say "that is no longer
--     true" — so the WireGuard correction above would have sat alongside the
--     Tailscale claim it replaced, both equally findable.
-- ===========================================================================

create table knowledge (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references app_users(id) on delete cascade,

  slug              text not null,
  title             text not null,
  body              text not null default '',
  labels            text[] not null default '{}',

  -- where it was learned; both nullable, both survive their source's deletion
  source_task_id    uuid references tasks(id) on delete set null,
  source_session_id uuid,

  actor_type        text not null default 'agent' check (actor_type in ('human', 'agent')),
  actor_id          text,

  superseded_by     uuid references knowledge(id) on delete set null,
  verified_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint knowledge_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint knowledge_not_self_superseded check (superseded_by is null or superseded_by <> id)
);

create unique index knowledge_owner_slug_idx on knowledge (owner_user_id, slug);

alter table knowledge add column search_vector tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(body,  '')), 'B')
) stored;

create index knowledge_search_idx on knowledge using gin (search_vector);
create index knowledge_owner_updated_idx on knowledge (owner_user_id, updated_at desc);

create trigger knowledge_touch before update on knowledge
  for each row execute function touch_updated_at();

comment on table knowledge is
  'Durable, curated, correctable knowledge. Not time-ordered and not owned by a '
  'task. Zero rows in knowledge_projects means it applies everywhere.';
comment on column knowledge.superseded_by is
  'Points at what replaced this. Superseded rows stay findable but are ranked '
  'below and marked, so a correction beats the claim it corrects.';

-- ---------------------------------------------------------------------------
-- Which projects a piece of knowledge applies to. None = all of them.
--
-- The owner check lives here rather than in RLS alone: a knowledge row and a
-- project row can only be linked when the same person owns both, and that is
-- cheaper to enforce once at write time than to reason about later.
-- ---------------------------------------------------------------------------
create table knowledge_projects (
  knowledge_id uuid not null references knowledge(id) on delete cascade,
  project_id   uuid not null references projects(id)  on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (knowledge_id, project_id)
);

create index knowledge_projects_project_idx on knowledge_projects (project_id);

comment on table knowledge_projects is
  'Scopes a knowledge row to one or more projects. No rows at all means global '
  '-- infra, conventions, anything that is not project-specific.';
