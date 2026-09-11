---
name: cairn
description: Shared task tracker and memory for agents. Use BEFORE starting work on any subject to check what has already been done, tried, or debugged; and to file, claim, annotate, learn, checkpoint, and close tasks. Triggers on "have we done this before", "check if we fixed", "what did we try for", "create a task", "log this", "learn this", "checkpoint this", "what's the status of", "claim this task", "mark it done", "end the session".
---

# Cairn

Cairn is the shared memory for everything worked on here. It holds four things, and
`cairn check` searches all of them at once:

| | what it answers |
|---|---|
| **tasks** | what needs doing, what was done, how it was resolved |
| **notes** | what was tried along the way, including what did not work |
| **knowledge** | what we now *know* — infra, conventions, gotchas — outliving any task |
| **sessions** | what happened in a working session, and where it was left |

Examples below use `ACME-42`; refs are your own project key plus a number, like `HM-700`.

Requires `cairn` on PATH. Credentials come from `CAIRN_BASE_URL` / `CAIRN_API_KEY`, or from
`~/.cairn/env` if those are unset.

## 0. Mandatory lifecycle — do not skip a gate

For every non-trivial request, follow this sequence and leave evidence at each boundary:

1. **Orient:** run `cairn context --cwd "$PWD"`, then `cairn check "<subject>"` before
   reading deeply, changing anything, or delegating. Inspect relevant hits with `show`.
2. **Own:** reuse an open task when one exists; otherwise `cairn add` one in the correct
   project, then `cairn claim <ref>`. A task is required for durable work, investigations,
   fixes, deployments, migrations, and delegated work; trivial read-only answers may use
   only `check`.
3. **Record:** write `note` entries for attempts, findings, decisions, and handoffs as
   they happen. When a fact should survive task closure, write it with `learn` (or correct
   it with `relearn`) instead of leaving it only in a task note.
4. **Checkpoint:** after each meaningful milestone and before pausing, delegating, or
   yielding, run `cairn checkpoint <ref> --summary "..."`; use `beat` during long work.
5. **Close:** when the work is actually complete, run `cairn done <ref> --resolution
   "..." --kind fixed` (or the accurate non-fixed kind), then verify with `show` or
   `history`. Release a claim only when handing work back unfinished.

Do not finish a durable task with only a chat reply, a dashboard update, or a vague note.
If work is incomplete, leave the task doing with a checkpoint and explicit handoff; never
claim done merely because the current turn is ending.

Sessions are created and recorded by the runtime lifecycle; there is deliberately no
`cairn session create` command. At session start, use `context` and `check`; at session
end, the runtime/Stop hook writes the episodic record and auto-checkpoints held tasks.
If a manual handoff is required and a real session id is available, use `cairn session
end --id <id>`; never fabricate a session or substitute a second memory/task system.

## 1. Check first. Every time.

Before starting work on a subject:

```bash
cairn check "supabase pooler connection timeouts"
```

Returns an index — one line per prior task, whether it has a recorded answer, and the
rough token cost of opening it:

```
#3
kind       ref                       status  type         answered  tokens  title
task       ACME-1                     done    bug          yes       ~15     supavisor timeouts under load
knowledge  supavisor-pool-sizing     current knowledge     yes      ~90     Supavisor pools are per-tenant
note       ACME-7                     doing   bug          yes       ~40     Tried raising pool_size, no change
```

Open a task with `cairn show ACME-1`, a piece of knowledge with `cairn know <slug>`, a
task's notes with `cairn log ACME-7`. **Do not re-debug something already answered.** If it
returns `#0`, the subject is new.

`--kinds task,note,knowledge,session` narrows it; the default searches everything, because
you do not know in advance which one holds the answer.

## 2. Then: check → show → act

```bash
cairn check "flaky auth redirect"   # index. cheap.
cairn show ACME-42                   # digest: the answer, findings, a clipped body
cairn show ACME-42 --full            # everything, when the digest is not enough
cairn note ACME-42 "..."             # act, and record it
```

Never pull bodies in bulk to browse them. That is what the index is for.

## 3. Record as you go

```bash
cairn note ACME-42 "bumped pool_size to 30, no change" --kind attempt
cairn note ACME-42 "supavisor caps at 15 regardless of client" --kind finding
cairn note ACME-42 "staying on supavisor; direct conns break PgBouncer" --kind decision
```

`--kind`: `note | finding | decision | attempt | handoff`

**Write down dead ends.** "Tried X, made no difference" saves the next agent an hour and
is as valuable as a fix. Notes are deduplicated, so a retry after a timeout is safe.

Use `cairn comment` instead when you are addressing the human rather than the next agent.

## 4. Closing requires saying how

```bash
cairn done ACME-42 --resolution "raised supavisor pool_size to 40; default 15 was the cap"
```

The API refuses `done` without a resolution, and will suggest one from your last
checkpoint. `--kind fixed | wont-fix | duplicate | not-reproducible | superseded | answered`.

A closed task with no recorded answer is invisible to everyone who comes later.

## 5. Claiming, so agents don't collide

```bash
cairn claim ACME-42        # exit code 9 means another agent holds it
cairn beat ACME-42         # keep it alive during long work
cairn checkpoint ACME-42 --summary "migration written, tests not run"
cairn release ACME-42
```

- **Exit 9 means pick different work.** Do not force it.
- A claim is independent of `status` — a task can be `doing` and unclaimed.
- A lease goes stale after 15 minutes of silence and can then be taken over.
- Leave a checkpoint before you stop; it is how another agent resumes without your
  transcript.

## 6. Filing work

```bash
cairn add "title" --project ACME --type bug --priority high
cairn add "title" --project ACME --body -     # long markdown body from stdin
```

`--type`: `feature | bug | improvement | chore | spike | docs`
`--status`: `backlog | todo | doing | in-review | done | cancelled`
`--priority`: `urgent | high | medium | low`

`add` warns if similar work already exists — read the warning before continuing.

## 7. Knowledge: what we know, not what we did

A task is a piece of work. Knowledge is what survives it — the thing the *next* person
needs whether or not they ever find the task it was learned in.

```bash
cairn know                              # what applies here
cairn know "postgrest ambiguous embed"  # search it
cairn know postgrest-embeds-go-ambiguous-when-a-second-fk-path-appears   # read it
```

Write it the moment you learn something that will be true next month:

```bash
cairn learn "Supavisor pools are per-tenant, not per-connection-string" \
  --label supabase,postgres --body -
```

### Where does it apply?

Three scopes, narrowest first:

```bash
cairn learn "..." --project HM        # true of that project
cairn learn "..." --entity dispofi    # true of that grouping — see `cairn entities`
cairn learn "..."                     # true everywhere
```

An **entity** is any grouping a fact can be true of: a business, a stack, a subsystem. A
project belongs to several at once, so reach for the one the fact is actually about —
"Customer.io campaign ids" is true of Dispofi, not of one repo in it, and not of the
trading work.

Scope narrowly only when it is genuinely narrow. A fact filed under one project is
invisible from the other four where it also applies — which is the mistake that made five
Dispofi facts get filed as global, because global was the only thing left that was not
also wrong.

When a fact exists at two scopes, the narrower one is shown first: a project fact beats an
entity fact beats a global one. That is how "true for Dispofi, except here" gets said.

**Correct it rather than adding to it.** The failure mode of every memory store is
accumulation without correction — two contradictory claims, equally findable, and no way to
tell which one is current.

```bash
cairn relearn <slug> --body -                        # it changed
cairn unlearn <old-slug> --superseded-by <new-slug>  # it was wrong
```

A superseded row stays findable and is marked as superseded, so someone holding the old
belief can discover it was replaced.

### Knowledge or a note?

A note is bound to a task and to a moment: *"tried raising pool_size on ACME-7, no change"*.
Knowledge is bound to nothing: *"Supavisor pools are per-tenant"*. If you would want it
surfaced while working on an unrelated project, it is knowledge.

## 8. Before you stop

The session record and the checkpoint are written for you when a session ends, so nothing
is lost if you forget. These are the things nothing can do on your behalf:

- [ ] **Close what you finished** — `cairn done <ref> --resolution "…"`. The API refuses a
      close without one, so a task left open is a task you did not close, not one you
      closed badly.
- [ ] **Say what did not work** — `cairn note <ref> --kind attempt`. The next agent will
      otherwise try it again, and the trying is the expensive part.
- [ ] **Record what you learned** — `cairn learn`, if it will still be true next month.
      Scope it: `--project` if it is about one codebase, `--entity` if it is about a
      business or a stack, neither if it is true everywhere. Unscoped is the default you
      get by forgetting, and the CLI will say so.
- [ ] **Release or checkpoint anything you are still holding** — `cairn release`, or
      `cairn checkpoint --summary` if the work continues.

`cairn context` shows what you are holding and flags anything that has gone quiet, so run
it if you are unsure what you left open.

## 9. The briefing

```bash
cairn context          # what you hold, what is in flight, where the last session stopped
```

Usually you will not run this: a hook runs it when a session starts and puts the result in
front of you. Run it by hand when you have lost your place, or after a long stretch of work.

`cairn map CAIRN` tells Cairn that this directory is that project, which is what makes the
briefing project-aware. Do it once per checkout.

## 10. Dependencies

Before claiming, check whether something has to land first. A task with open blockers
is not ready to start, no matter what its status says.

```bash
cairn deps ACME-42                    # what blocks this, and what it blocks
cairn blockedby ACME-42 ACME-40        # ACME-40 must finish before ACME-42
cairn unblockedby ACME-42 ACME-40   # remove it again
```

Use this instead of writing "waiting on ACME-40" in a note: a note is prose nobody
queries, a dependency shows up on both tasks and in `cairn deps`.

`cairn block ACME-42 "reason"` is a different thing — it flags a task as stuck on
something outside Cairn (an unavailable credential, a third party). Reach for
`blockedby` when the blocker is another task.

## 11. Closing as a duplicate

```bash
cairn done ACME-42 --duplicate-of ACME-31 --resolution "same cause as ACME-31; fixed there"
```

Naming the original is the point. `--kind duplicate` on its own records *that* it was a
duplicate and leaves the reader to go and find *what* — which is the work the resolution
was supposed to save.

## 12. Splitting work up

```bash
cairn add "write the migration" --project ACME --parent ACME-42
cairn children ACME-42                 # the split, and how much of it is closed
cairn update ACME-7 --no-parent        # lift it back to the top level
```

Sub-tasks are *containment*; `blockedby` is *ordering*. Use a parent when one task is
too big for a single resolution, and a blocker when two separate things have to happen
in an order.

## 13. What already happened

```bash
cairn history ACME-42     # status moves, claims, renames, resolutions — with who and when
```

Different from `cairn log`, which is what an agent *said*. `history` is what actually
happened, recorded whether anyone narrated it or not. Reach for it when a task is in a
state nobody explained.

## Output

TSV by default: a `#count` line, one header row, then rows; nulls omitted. `--json` to
parse, `--pretty` for a human. `cairn --help` is the full reference.

## Scope

Cairn holds open loops, durable answers, and what was learned getting to them. Sessions are
recorded automatically when they end and knowledge is written by hand, so "what did I do in
that conversation last Tuesday" and "what do we know about this" are both `cairn check`.

What it is still not: a transcript. It holds what a session concluded, never what was said
turn by turn.
