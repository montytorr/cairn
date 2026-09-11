-- ===========================================================================
-- 014: sessions — the episodic record, written without being asked
--
-- Cairn holds open loops and durable answers. What it has never held is "what
-- happened in that conversation last Tuesday", and until now the honest answer
-- was to send people to claude-mem for it.
--
-- Of everything that store produced, the session summary is the piece worth
-- keeping: a request/learned/completed/next_steps quartet, one per session.
-- The rest of it -- 29,090 observations generated one per tool call -- cost
-- ~1,114 billed turns a day and was consulted 103 times in seventeen days.
-- This table takes the good half at one model call per session, which measured
-- against real usage is 30-120 a day.
--
-- `external_id` plus `platform_source` is the idempotency key. A session-end
-- hook that fires twice, or a reconciler that sweeps up a session the hook
-- missed, must not produce two rows.
-- ===========================================================================

create table sessions (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,

  external_id     text not null,
  platform_source text not null check (platform_source in ('claude', 'codex', 'openclaw', 'other')),
  agent_id        text,

  cwd             text,
  project_id      uuid references projects(id) on delete set null,

  started_at      timestamptz,
  ended_at        timestamptz,

  -- the four prose fields; the only part that costs a model call
  request         text,
  learned         text,
  completed       text,
  next_steps      text,

  -- extracted deterministically from the transcript, no model involved
  files           jsonb not null default '[]'::jsonb,
  task_refs       text[] not null default '{}',
  tool_calls      int,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index sessions_external_idx on sessions (platform_source, external_id);
create index sessions_owner_ended_idx on sessions (owner_user_id, ended_at desc nulls last);
create index sessions_project_idx on sessions (project_id, ended_at desc nulls last);

alter table sessions add column search_vector tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, coalesce(request,    '')), 'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(learned,    '')), 'B') ||
  setweight(to_tsvector('english'::regconfig, coalesce(completed,  '')), 'B') ||
  setweight(to_tsvector('english'::regconfig, coalesce(next_steps, '')), 'B')
) stored;

create index sessions_search_idx on sessions using gin (search_vector);

create trigger sessions_touch before update on sessions
  for each row execute function touch_updated_at();

comment on table sessions is
  'One row per agent session, written at session end. Episodic: what was asked, '
  'what was learned, where it was left. Idempotent on (platform_source, external_id).';
comment on column sessions.next_steps is
  'Read back verbatim by `cairn context` when the next session opens in the same '
  'directory. This is the handoff between two sessions that never met.';

alter table sessions enable row level security;

create policy sessions_owner on sessions
  for all to authenticated
  using (owner_user_id = auth.uid()) with check (owner_user_id = auth.uid());

-- knowledge.source_session_id was declared in 013 without a reference, because
-- this table did not exist yet. Wire it up now.
alter table knowledge
  add constraint knowledge_source_session_fk
  foreign key (source_session_id) references sessions(id) on delete set null;
