-- ===========================================================================
-- 077: a project's description change is recorded (CAIRN-374)
--
-- `cairn project describe` replaces a project's description, and the route
-- records who did it as `project_described`. The event kind has to be in
-- task_activity_events_event_check, whose list is rebuilt here with every kind
-- 071 had plus the new one.
--
-- NOT VALID, as in 071: adding a validated check scans the table under ACCESS
-- EXCLUSIVE, and the runner holds that lock until this file's transaction
-- commits. Every existing row already passes (the list only grew), so 078
-- validates it in its own transaction without stopping writes.
--
-- Dropping and re-adding the one name makes a second run a no-op in effect.
-- ===========================================================================

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
    'project_described',
    'task_deleted', 'knowledge_deleted',
    'subject_created', 'subject_stage_changed', 'subject_archived', 'subject_restored',
    'subject_deleted', 'handed_off', 'handoff_taken_back'
  )) not valid;
