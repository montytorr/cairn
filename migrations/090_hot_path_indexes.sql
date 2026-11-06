-- ===========================================================================
-- 090: index the two hot reads that scanned whole tables
--
-- Measured on the Lab instance (cairn_lab, 2026-11-06): 6.8 billion rows read
-- since 2026-10-18 at ~19 transactions a second. Two statements did most of it,
-- and the personal instance shows the same shape.
--
-- 1. cairn_pulse (037/048/074), run every 4 s for every open tab by the SSE
--    stream, takes `max(created_at)` over task_activity_events. Its only
--    created_at indexes lead with task_id, owner, project or subject, so every
--    tick read the whole table: 58k rows in 48 ms on the Lab, 12 times a minute
--    per tab, ~11,600 rows/s from one browser. The function's own comment says
--    it "must stay index-cheap". An index leading with created_at makes that arm
--    one index probe.
--
-- 2. Knowledge staleness (src/lib/api/staleness.ts), run inside every search
--    (`cairn check`), recall (`cairn claim`), briefing and knowledge page, reads
--    file_touches by `path in (...)` and by `session_id in (...)`.
--    015 indexed `(owner_user_id, path, created_at)`, but the shared workspace
--    (047-049) stopped filtering on the owner, so that index has never been used
--    (idx_scan 0 on both instances) and each lookup was a sequential scan of the
--    whole table: 440k rows / 129 MB on the Lab, 62% of every row it ever read.
--    The exact-path lookup in contextForFile (files.ts) and 060's
--    knowledge_files trigger read the same columns, and so do the cascades when
--    a session is deleted.
--
-- The owner-led path index is dropped: no query filters file_touches by owner,
-- and an index nothing reads still costs every insert (46 MB on the Lab).
--
-- SAFE ON ANY INSTANCE. The runner wraps each file in a transaction
-- (scripts/migrate.mjs), so CREATE INDEX CONCURRENTLY is not available; these
-- are plain builds, which block writes to that one table (never reads) while
-- they run. That is a few seconds even at millions of rows. Each index is
-- skipped when the table already has a valid index with the same leading
-- column, whatever it is called, so an instance that added its own by hand does
-- not get a duplicate.
-- ===========================================================================

do $migration$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('task_activity_events', 'created_at', false,
       'create index if not exists task_activity_events_created_idx on task_activity_events (created_at desc)'),
      ('file_touches', 'path', false,
       'create index if not exists file_touches_path_created_idx on file_touches (path, created_at desc)'),
      ('file_touches', 'session_id', true,
       'create index if not exists file_touches_session_idx on file_touches (session_id) where session_id is not null')
    ) as w(tbl, col, partial_ok, ddl)
  loop
    if exists (
      select 1
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
       where i.indrelid = to_regclass('public.' || wanted.tbl)
         and i.indisvalid
         and a.attname = wanted.col
         and (i.indpred is null or wanted.partial_ok)
    ) then
      raise notice '090: % already has an index leading with %; not adding another', wanted.tbl, wanted.col;
    else
      execute wanted.ddl;
    end if;
  end loop;
end
$migration$;

drop index if exists file_touches_path_idx;
