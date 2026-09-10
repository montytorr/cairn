-- ===========================================================================
-- Fold comment text into a task's search vector.
--
-- 2,406 imported tasks are closed with no `resolution`, because the tracker
-- they came from had no such field and inventing one would have been worse
-- than leaving it empty. But the answer is very often there — in the 3,679
-- comments that came across with them. Those were searchable only on their
-- own, never from the task, so "has this been solved?" could not find them.
--
-- Comments are weighted 'C': below the title and a recorded resolution, above
-- nothing. A discussion that mentions a subject is weaker evidence than a task
-- about it, and the ranking should say so.
-- ===========================================================================

alter table tasks add column if not exists comments_text text;

create or replace function refresh_task_comments_text() returns trigger
language plpgsql as $$
declare
  target uuid := coalesce(new.task_id, old.task_id);
begin
  update tasks t
     set comments_text = (
       select string_agg(c.content, E'\n' order by c.created_at)
       from task_comments c
       where c.task_id = target
     )
   where t.id = target;
  return null;
end $$;

drop trigger if exists task_comments_reindex on task_comments;
create trigger task_comments_reindex
  after insert or update of content or delete on task_comments
  for each row execute function refresh_task_comments_text();

-- Backfill everything that came across in the import.
update tasks t
   set comments_text = sub.body
  from (
    select task_id, string_agg(content, E'\n' order by created_at) as body
    from task_comments group by task_id
  ) sub
 where sub.task_id = t.id;

-- Rebuild the generated column to include it. A generated column cannot be
-- altered in place, so it is dropped and recreated.
alter table tasks drop column if exists search_vector;

alter table tasks add column search_vector tsvector generated always as (
  setweight(to_tsvector('english'::regconfig, coalesce(title, '')),         'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(resolution, '')),    'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(external_ref, '')),  'A') ||
  setweight(to_tsvector('english'::regconfig, coalesce(description, '')),   'B') ||
  setweight(to_tsvector('english'::regconfig, coalesce(comments_text, '')), 'C')
) stored;

create index if not exists tasks_search_idx on tasks using gin (search_vector);
