-- ---------------------------------------------------------------------------
-- 011: label maintenance
--
-- Labels are free text on each task, and nothing has ever listed, renamed or
-- merged them. Left alone, `db`, `database` and `postgres` accumulate as three
-- separate things and filtering by any one of them is quietly wrong.
--
-- Both functions run owner-scoped in a single statement. Doing this from the
-- API would mean reading every task, rewriting its array and writing it back,
-- one row at a time.
-- ---------------------------------------------------------------------------

create or replace function list_labels(p_owner uuid)
returns table (label text, task_count bigint)
language sql
stable
as $$
  select l as label, count(*) as task_count
    from tasks t
    join projects p on p.id = t.project_id
   cross join lateral unnest(t.labels) as l
   where p.owner_user_id = p_owner
   group by l
   order by count(*) desc, l;
$$;

comment on function list_labels is
  'Every label in use by this owner, with how many tasks carry it.';

-- ---------------------------------------------------------------------------
-- Rename, merge and delete are one operation.
--
-- A rename onto an existing label IS a merge, and the only thing that makes it
-- work is deduplicating afterwards — otherwise a task carrying both ends up
-- with the survivor twice. Passing p_to as null deletes instead.
-- ---------------------------------------------------------------------------
create or replace function rename_label(p_owner uuid, p_from text, p_to text)
returns integer
language plpgsql
as $$
declare
  affected integer;
begin
  if p_from is null or p_from = '' then
    raise exception 'a label to rename is required';
  end if;

  update tasks t
     set labels = case
           when p_to is null or p_to = ''
             then array_remove(t.labels, p_from)
           else (
             select coalesce(array_agg(distinct x order by x), '{}'::text[])
               from unnest(array_replace(t.labels, p_from, p_to)) as x
           )
         end
    from projects p
   where t.project_id = p.id
     and p.owner_user_id = p_owner
     and p_from = any (t.labels);

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function rename_label is
  'Rename a label across every task, merging into the target if it already '
  'exists. A null or empty p_to deletes the label instead. Returns the number '
  'of tasks changed.';
