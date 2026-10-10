-- ===========================================================================
-- 071: the Lab (CAIRN-366, contract in docs/lab.md)
--
-- Croft, the lab product forked from Cairn 0.12.1, folds back in. Its unit is
-- a SUBJECT (`LAB-12`): something to explore or prove. It moves through
-- curated STAGES, carries a write-up, an append-only log, people's notes,
-- files and curated TAGS, and — once it lands in a completed or dropped
-- stage — a CONCLUSION. Its todos are ordinary tasks pointed at it by
-- `tasks.subject_id`.
--
-- Ported from Croft's 070, 071, 074 (only the subject side), 075 and 078,
-- without 076's visibility half: an instance is the sharing boundary, and
-- every subject is visible to every user of it.
--
-- Off by default. `lab_settings.enabled` switches the Lab on per instance; an
-- instance that upgrades gets these tables, empty, and nothing lab-shaped.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The switch, and where todos of a subject without a project are filed. One
-- row, like instance_branding (066).
-- ---------------------------------------------------------------------------
create table if not exists lab_settings (
  id               boolean primary key default true check (id),
  enabled          boolean not null default false,
  home_project_id  uuid references projects(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references app_users(id) on delete set null
);

insert into lab_settings (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- `LAB` is the subjects' key, so no project may hold it, live or retired.
--
-- The check is the floor beneath the API's refusal. An instance that already
-- has a project keyed LAB still migrates — a deploy that migrates on start
-- must never be blocked by a key — so the check is only added when it can
-- be; enabling the Lab there is refused until the project is rekeyed, and the
-- settings route adds the check once the key is free (cairn_lab_reserve_key).
--
-- The route calls this at run time, as the application's role, so it runs as
-- its owner (the role that migrates) with a pinned search_path, and it never
-- raises: it answers what happened, and the route enables the Lab regardless
-- (the API's reservation holds either way) with a warning. Two settings
-- writes at once take turns on the advisory lock; the second finds the
-- check already there.
--
-- Returns 'reserved', 'key_in_use', or 'failed: <reason>'.
-- ---------------------------------------------------------------------------
drop function if exists cairn_lab_reserve_key();
create function cairn_lab_reserve_key() returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext('cairn_lab_reserve_key'));
  if exists (select 1 from projects where key = 'LAB')
     or exists (select 1 from project_former_keys where key = 'LAB') then
    return 'key_in_use';
  end if;
  begin
    if not exists (select 1 from pg_constraint where conname = 'projects_key_not_lab') then
      alter table projects add constraint projects_key_not_lab check (key <> 'LAB');
    end if;
    if not exists (select 1 from pg_constraint where conname = 'project_former_keys_not_lab') then
      alter table project_former_keys add constraint project_former_keys_not_lab check (key <> 'LAB');
    end if;
  exception
    when duplicate_object then
      null;
    when others then
      return 'failed: ' || sqlerrm;
  end;
  return 'reserved';
end
$$;

-- Callable by the application's role, which may not be its owner. It only
-- ever adds the reservation, so it is safe for anyone to call.
do $$
declare
  outcome text := cairn_lab_reserve_key();
begin
  if outcome <> 'reserved' then
    raise notice 'the LAB reservation check is not added (%): the API reservation holds', outcome;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Stages: the board's lanes, in order. The category is what the product
-- reasons about; the name is what the instance calls it.
-- ---------------------------------------------------------------------------
create table if not exists lab_stages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  category    text not null check (category in ('planned', 'active', 'completed', 'dropped')),
  -- Written into styles, so the table refuses anything that is not a colour.
  color       text not null default '#8a8792' check (color ~ '^#[0-9a-f]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists lab_stages_name_unique on lab_stages (lower(name));

drop trigger if exists lab_stages_touch on lab_stages;
create trigger lab_stages_touch
  before update on lab_stages
  for each row execute function touch_updated_at();

insert into lab_stages (name, category, color, position) values
  ('to explore',        'planned',   '#8a8792', 0),
  ('exploring',         'active',    '#6b7fa6', 1),
  ('done',              'completed', '#5f8a63', 2),
  ('rejected',          'dropped',   '#a0685f', 3),
  ('to implement',      'planned',   '#8f8a74', 4),
  ('implementing',      'active',    '#a88a4e', 5),
  ('internal testing',  'active',    '#86709e', 6),
  ('ready for rollout', 'active',    '#4f8c86', 7),
  ('rolled out',        'completed', '#4e7f5a', 8)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Tags: curated, not free-typed, and for subjects only. Task labels stay as
-- they are.
-- ---------------------------------------------------------------------------
create table if not exists lab_tags (
  id          uuid primary key default gen_random_uuid(),
  -- Stored lower-cased, so uniqueness is case-insensitive without citext.
  name        text not null check (name = lower(btrim(name)) and char_length(name) between 1 and 40),
  color       text not null default '#8a8792' check (color ~ '^#[0-9a-f]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists lab_tags_name_unique on lab_tags (name);

drop trigger if exists lab_tags_touch on lab_tags;
create trigger lab_tags_touch
  before update on lab_tags
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Subjects.
-- ---------------------------------------------------------------------------
create table if not exists subjects (
  id             uuid primary key default gen_random_uuid(),
  -- `LAB-12`. One counter for the instance: a subject has no project to be
  -- numbered within. Assigned by trigger, below.
  number         integer not null,
  title          text not null check (char_length(btrim(title)) between 1 and 300),
  body           text check (body is null or char_length(body) <= 200000),
  -- Restrict: deleting a lane must never delete what is in it. The API
  -- refuses first with a readable `stage_in_use`.
  stage_id       uuid not null references lab_stages(id) on delete restrict,
  owner_user_id  uuid references app_users(id) on delete set null,
  -- A real Cairn project. Deleting the project leaves the subject.
  project_id     uuid references projects(id) on delete set null,
  conclusion     text check (conclusion is null or char_length(conclusion) <= 20000),
  concluded_at   timestamptz,
  position       integer not null default 0,
  actor_type     text not null check (actor_type in ('human', 'agent')),
  actor_id       text not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  archived_at    timestamptz,
  -- The conclusion is the recorded answer, the reason a task's resolution
  -- weighs A (002).
  search_vector  tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(conclusion, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) stored,
  constraint subjects_number_unique unique (number),
  constraint subjects_number_positive check (number > 0)
);

create index if not exists subjects_stage_idx   on subjects (stage_id, position);
create index if not exists subjects_owner_idx   on subjects (owner_user_id) where owner_user_id is not null;
create index if not exists subjects_project_idx on subjects (project_id) where project_id is not null;
create index if not exists subjects_search_idx  on subjects using gin (search_vector);

-- A number is never handed out twice (Croft 078): deleting LAB-15 must not
-- let an unrelated subject become LAB-15 while notes elsewhere still cite it.
-- The counter only goes up; its update rolls back with a failed insert, so
-- the only holes are deletions. Its row lock serialises concurrent inserts.
create table if not exists subject_number_counter (
  singleton    boolean primary key default true check (singleton),
  last_number  integer not null check (last_number >= 0)
);

insert into subject_number_counter (singleton, last_number)
select true, coalesce(max(number), 0) from subjects
on conflict (singleton) do update
  set last_number = greatest(subject_number_counter.last_number, excluded.last_number);

create or replace function assign_subject_number() returns trigger
language plpgsql
as $$
begin
  if new.number is null then
    update subject_number_counter
       set last_number = last_number + 1
     where singleton
    returning last_number into new.number;
  else
    -- An explicit number (the importer) moves the counter past it.
    update subject_number_counter
       set last_number = greatest(last_number, new.number)
     where singleton;
  end if;
  return new;
end
$$;

drop trigger if exists subjects_assign_number on subjects;
create trigger subjects_assign_number
  before insert on subjects
  for each row execute function assign_subject_number();

drop trigger if exists subjects_touch on subjects;
create trigger subjects_touch
  before update on subjects
  for each row execute function touch_updated_at();

-- Anything written on a subject is activity on it, so "recently touched" and
-- the live-update pulse see it — 008's reason for touching a noted task.
create or replace function touch_subject_from_child() returns trigger
language plpgsql
as $$
begin
  -- On a cascade from a deleted subject the row is already gone; the update
  -- then matches nothing, which is right.
  update subjects set updated_at = now()
   where id = case when tg_op = 'DELETE' then old.subject_id else new.subject_id end;
  return null;
end
$$;

create table if not exists subject_tags (
  subject_id  uuid not null references subjects(id) on delete cascade,
  tag_id      uuid not null references lab_tags(id) on delete cascade,
  primary key (subject_id, tag_id)
);
create index if not exists subject_tags_tag_idx on subject_tags (tag_id);

drop trigger if exists subject_tags_touch_subject on subject_tags;
create trigger subject_tags_touch_subject
  after insert or delete on subject_tags
  for each row execute function touch_subject_from_child();

-- ---------------------------------------------------------------------------
-- The log. Append-only and idempotent like task notes: a retry carries the
-- same content hash and writes nothing. `stage` notes are the server's,
-- written with every stage move, so the log is the subject's history.
-- ---------------------------------------------------------------------------
create table if not exists subject_notes (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references subjects(id) on delete cascade,
  kind          text not null default 'note'
                check (kind in ('note', 'finding', 'decision', 'attempt', 'handoff', 'stage')),
  note          text not null check (char_length(btrim(note)) between 1 and 100000),
  actor_type    text not null check (actor_type in ('human', 'agent')),
  actor_id      text not null,
  -- The human behind the actor: actor_id is a frozen label.
  user_id       uuid references app_users(id) on delete set null,
  content_hash  text,
  created_at    timestamptz not null default now(),
  constraint subject_notes_dedupe unique (subject_id, content_hash)
);
create index if not exists subject_notes_subject_idx on subject_notes (subject_id, created_at desc);
create index if not exists subject_notes_created_idx on subject_notes (created_at desc);

drop trigger if exists subject_notes_touch_subject on subject_notes;
create trigger subject_notes_touch_subject
  after insert on subject_notes
  for each row execute function touch_subject_from_child();

-- ---------------------------------------------------------------------------
-- People's notes: editable markdown cards, the author's to change.
-- ---------------------------------------------------------------------------
create table if not exists subject_human_notes (
  id          uuid primary key default gen_random_uuid(),
  subject_id  uuid not null references subjects(id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 100000),
  -- The author. A person leaving must not take what they wrote with them.
  user_id     uuid references app_users(id) on delete set null,
  -- Who carried the write: the human, or one of their agents. Provenance only.
  actor_type  text not null check (actor_type in ('human', 'agent')),
  actor_id    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists subject_human_notes_subject_idx
  on subject_human_notes (subject_id, created_at desc);

drop trigger if exists subject_human_notes_touch on subject_human_notes;
create trigger subject_human_notes_touch
  before update on subject_human_notes
  for each row execute function touch_updated_at();

drop trigger if exists subject_human_notes_touch_subject on subject_human_notes;
create trigger subject_human_notes_touch_subject
  after insert on subject_human_notes
  for each row execute function touch_subject_from_child();

-- ---------------------------------------------------------------------------
-- Files on the subject itself, in the attachment store tasks use.
-- ---------------------------------------------------------------------------
create table if not exists subject_attachments (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references subjects(id) on delete cascade,
  filename      text not null check (char_length(filename) between 1 and 255),
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  storage_path  text not null unique,
  sha256        text,
  -- The actor label, frozen at upload.
  uploaded_by   text not null,
  user_id       uuid references app_users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists subject_attachments_subject_idx on subject_attachments (subject_id, created_at);

drop trigger if exists subject_attachments_touch_subject on subject_attachments;
create trigger subject_attachments_touch_subject
  after insert or delete on subject_attachments
  for each row execute function touch_subject_from_child();

-- ---------------------------------------------------------------------------
-- Todos are tasks. Set null is the floor, never the path: the API refuses to
-- delete a subject with todos unless they are detached, each with a note.
-- ---------------------------------------------------------------------------
--
-- The column first, the foreign key NOT VALID: adding it validated would scan
-- `tasks` under a lock that stops writes, and an instance that migrates on
-- start (Dispofi's, on App Runner) would stall for the scan. New rows are
-- checked at once; 076 validates the old ones, all null, under a lock that
-- lets writes through.
alter table tasks add column if not exists subject_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_subject_id_fkey') then
    alter table tasks add constraint tasks_subject_id_fkey
      foreign key (subject_id) references subjects(id) on delete set null not valid;
  end if;
end $$;
create index if not exists tasks_subject_idx on tasks (subject_id) where subject_id is not null;

-- ---------------------------------------------------------------------------
-- Activity: subject events live with every other event. No foreign key, so a
-- deleted subject's history stays, as a task's outlives the task (040).
-- ---------------------------------------------------------------------------
alter table task_activity_events add column if not exists subject_id uuid;
create index if not exists task_activity_events_subject_idx
  on task_activity_events (subject_id, created_at desc) where subject_id is not null;

-- NOT VALID, for the reason the foreign key above is: the list only grows, so
-- every existing row already passes, and 076 validates it without stopping
-- writes.
alter table task_activity_events
  drop constraint if exists task_activity_events_event_check;

alter table task_activity_events
  add constraint task_activity_events_event_check
  check (event in (
    'created', 'status_changed', 'priority_changed', 'type_changed',
    'renamed', 'labels_changed', 'due_date_changed', 'body_edited',
    'assignee_changed',
    'resolved', 'resolution_revised', 'resolution_withdrawn',
    'marked_duplicate', 'duplicate_cleared',
    'claimed', 'released', 'blocked', 'unblocked',
    'git_commit', 'git_push', 'run_result',
    'checkpointed', 'auto_checkpointed', 'attachment_added', 'attachment_removed',
    'dependency_added', 'dependency_removed',
    'project_created', 'project_renamed', 'project_key_changed',
    'project_archived', 'project_restored', 'project_deleted',
    'task_deleted', 'knowledge_deleted',
    'subject_created', 'subject_stage_changed', 'subject_archived', 'subject_restored',
    'subject_deleted', 'handed_off', 'handoff_taken_back'
  )) not valid;

comment on table subjects is
  'Lab subjects (LAB-n): things to explore or prove, on a board of curated stages. See docs/lab.md.';
