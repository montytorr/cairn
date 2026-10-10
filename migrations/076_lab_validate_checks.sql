-- ===========================================================================
-- 076: validate what 071 and 072 added NOT VALID (CAIRN-366)
--
-- A constraint added validated scans its table under ACCESS EXCLUSIVE, which
-- stops every write for the length of the scan, and the runner holds that lock
-- until the file's transaction commits. An instance that migrates on start
-- (Dispofi's, on App Runner against Aurora) would stall its writes for it.
-- So 071 and 072 added them NOT VALID (enforced for new rows at once, a
-- metadata-only change), and this file, its own transaction, validates the
-- existing rows under SHARE UPDATE EXCLUSIVE, which lets reads and writes
-- through. Validating a constraint that is already valid is a no-op, so this
-- can run again.
-- ===========================================================================

alter table task_activity_events validate constraint task_activity_events_event_check;

alter table tasks validate constraint tasks_subject_id_fkey;
alter table tasks validate constraint tasks_handoff_pair_check;
alter table tasks validate constraint tasks_handoff_tracker_shape_check;
alter table tasks validate constraint tasks_handoff_ref_shape_check;
alter table tasks validate constraint tasks_handoff_url_shape_check;
alter table tasks validate constraint tasks_handoff_cairn_url_check;

alter table projects validate constraint projects_handoff_pair_check;
alter table projects validate constraint projects_handoff_tracker_shape_check;
alter table projects validate constraint projects_handoff_target_shape_check;
