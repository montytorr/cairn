-- A boolean the list and board can select instead of pulling resolution text.
--
-- The "answered" flag is shown on every row, but the resolution itself is only
-- read on the task detail page. Selecting the text just to test it for null
-- would ship kilobytes per row for a tick mark.
alter table tasks
  add column if not exists has_resolution boolean
    generated always as (resolution is not null) stored;

create index if not exists tasks_has_resolution_idx
  on tasks (project_id, has_resolution) where has_resolution;
