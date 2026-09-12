-- ---------------------------------------------------------------------------
-- 009: point a duplicate at what it duplicates
--
-- `resolution_kind = 'duplicate'` has recorded *that* a task was a duplicate
-- since 001, but never *of what* — so the reader had to go and search for the
-- original, which is precisely the work the resolution was supposed to save.
--
-- A column rather than a task_deps row: task_deps means "ordering", and a
-- duplicate is not an ordering. Overloading it would make "what is ready to
-- start?" answer wrongly.
-- ---------------------------------------------------------------------------

alter table tasks
  add column duplicate_of uuid references tasks(id) on delete set null;

-- Deliberately ON DELETE SET NULL, not CASCADE: deleting the original must not
-- take the duplicate's own history with it.

alter table tasks
  add constraint tasks_duplicate_not_self check (duplicate_of is null or duplicate_of <> id);

-- Only meaningful on a task closed as a duplicate. Enforced rather than
-- documented, because a stale pointer left behind by a later re-open is worse
-- than no pointer.
alter table tasks
  add constraint tasks_duplicate_needs_kind
  check (duplicate_of is null or resolution_kind = 'duplicate');

create index tasks_duplicate_of_idx on tasks(duplicate_of) where duplicate_of is not null;
