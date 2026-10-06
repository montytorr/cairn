-- ===========================================================================
-- 070: vitals stops reporting the claude-mem import as a runtime that stopped
--
-- CAIRN-354. `runtime-absent` read "claude@other sessions (last 583h ago)".
-- No runtime called that ever ran: they are the 4,937 claude-mem summaries
-- CAIRN-73 bulk-loaded into `sessions` on 2026-09-11, marked
-- `external_id = 'cmem-<id>'` (and `agent_id = 'claude-mem'`) so provenance
-- stays visible. They carry the platform `claude` and mostly no cwd, so 065's
-- per-runtime split filed them as one host, which then fell silent the day
-- the import finished — and will stay "gone" for good. They are history, not
-- activity, so every count that reads `sess` leaves them out: the per-runtime
-- rows and the session totals alike.
--
-- The other half of that warning — `claude-code` writes, a label renamed to
-- `claude-code · <owner>` and active under it — is decided in
-- src/lib/api/vitals.ts (absentAgentsStillGone), where the list of who is
-- writing already is.
--
-- TRANSFORMED, NOT RE-COPIED, and asserted rather than trusted — the pattern
-- 051 and 054 set for cairn_vitals. 065 is the only migration that has
-- defined cairn_vitals_signals so far, but copying its body here would make
-- this file the next one to silently revert whatever amends it in between.
-- This edits the definition actually installed, matches the exact text 065
-- left behind, and raises if that text is not there.
-- ===========================================================================

do $migration$
declare
  fn oid;
  definition text;
  updated text;
  old_where text;
  new_where text;
begin
  select p.oid into fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cairn_vitals_signals';

  if fn is null then
    raise exception 'cairn_vitals_signals is not installed';
  end if;

  definition := pg_get_functiondef(fn);

  if definition like '%cmem-%' then
    raise notice 'cairn_vitals_signals already leaves the claude-mem import out; nothing to do';
    return;
  end if;

  -- Byte for byte the end of 065's `sess` CTE.
  old_where :=
    E'    from sessions s, bounds b\n'
    '    where s.created_at >= b.history_start\n'
    '  ),';

  new_where :=
    E'    from sessions s, bounds b\n'
    '    where s.created_at >= b.history_start\n'
    '      -- The claude-mem import (CAIRN-73): history loaded in bulk, not a\n'
    '      -- runtime that ran. See 070.\n'
    '      and s.external_id not like ''cmem-%''\n'
    '  ),';

  if strpos(definition, old_where) = 0 then
    raise exception 'cairn_vitals_signals: the sess CTE installed by 065 is not in this definition; refusing to guess what to replace';
  end if;

  updated := replace(definition, old_where, new_where);

  -- Once, and only once: 065 has one `sess` CTE, and a second match would
  -- mean something else has been written in its shape since.
  if updated = definition
     or strpos(updated, new_where) = 0
     or strpos(substr(updated, strpos(updated, new_where) + 1), new_where) <> 0 then
    raise exception 'cairn_vitals_signals: the sess CTE was found and not replaced exactly once';
  end if;

  execute updated;
end
$migration$;
