-- Whether the memory is ever actually consulted.
--
-- Cairn's whole premise is `cairn check` before starting work, and nothing
-- recorded whether that happened. Every other number here describes what was
-- written; none described whether any of it was read. A store nobody queries is
-- an expensive way to write into a drawer.
--
-- The query text is kept on purpose. A search that returns nothing is the most
-- informative row in this table: it says what the memory was asked for and did
-- not have.

create table search_events (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references app_users(id) on delete cascade,
  actor_id       text not null,
  query          text not null,
  kinds          text[],
  result_count   int not null,
  created_at     timestamptz not null default now()
);

create index search_events_owner_idx on search_events (owner_user_id, created_at desc);
-- The discipline question — "was anything checked before this task was filed" —
-- looks up by actor within a short window either side of a creation.
create index search_events_actor_idx on search_events (owner_user_id, actor_id, created_at desc);
