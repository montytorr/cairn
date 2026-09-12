-- ===========================================================================
-- A note should count as touching its task.
--
-- Found by testing the live-update stream: adding a note produced no event,
-- because the fingerprint watches tasks.updated_at and a note only writes to
-- task_notes. Comments already bump it, but incidentally — via the
-- comments_text trigger from 005 — rather than by intent.
--
-- Making this explicit is right beyond the stream: updated_at should mean
-- "anything about this task changed", so a task with a fresh finding on it
-- also sorts as recently touched in every list.
-- ===========================================================================

create or replace function touch_task_from_note() returns trigger
language plpgsql as $$
begin
  update tasks set updated_at = now()
   where id = coalesce(new.task_id, old.task_id);
  return null;
end $$;

drop trigger if exists task_notes_touch_task on task_notes;
create trigger task_notes_touch_task
  after insert or update or delete on task_notes
  for each row execute function touch_task_from_note();

-- Attachments too, for the same reason.
drop trigger if exists task_attachments_touch_task on task_attachments;
create trigger task_attachments_touch_task
  after insert or delete on task_attachments
  for each row execute function touch_task_from_note();
