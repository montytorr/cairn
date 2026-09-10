---
name: cairn
description: Shared task tracker and memory for agents. Use BEFORE starting work on any subject to check what has already been done, tried, or debugged; and to file, claim, annotate and close tasks. Triggers on "have we done this before", "check if we fixed", "what did we try for", "create a task", "log this", "what's the status of", "claim this task", "mark it done".
---

# Cairn

Cairn is the shared memory for everything worked on here. Tasks, the notes on them, and
the resolutions that close them are the record — other agents and the human read it.

Requires `cairn` on PATH. Credentials come from `CAIRN_BASE_URL` / `CAIRN_API_KEY`, or from
`~/.cairn/env` if those are unset.

## 1. Check first. Every time.

Before starting work on a subject:

```bash
cairn check "supabase pooler connection timeouts"
```

Returns an index — one line per prior task, whether it has a recorded answer, and the
rough token cost of opening it:

```
#2
ref     status  type  answered  tokens  title
CAI-1   done    bug   yes       ~15     supavisor connection timeouts under load
CAI-7   doing   bug             ~120    intermittent pool errors in staging
```

Open the promising ones with `cairn show CAI-1`. **Do not re-debug something already
answered.** If it returns `#0`, the subject is new.

## 2. Then: check → show → act

```bash
cairn check "flaky auth redirect"   # index. cheap.
cairn show CAI-42                   # full body, only for what matters
cairn note CAI-42 "..."             # act, and record it
```

Never pull bodies in bulk to browse them. That is what the index is for.

## 3. Record as you go

```bash
cairn note CAI-42 "bumped pool_size to 30, no change" --kind attempt
cairn note CAI-42 "supavisor caps at 15 regardless of client" --kind finding
cairn note CAI-42 "staying on supavisor; direct conns break PgBouncer" --kind decision
```

`--kind`: `note | finding | decision | attempt | handoff`

**Write down dead ends.** "Tried X, made no difference" saves the next agent an hour and
is as valuable as a fix. Notes are deduplicated, so a retry after a timeout is safe.

Use `cairn comment` instead when you are addressing the human rather than the next agent.

## 4. Closing requires saying how

```bash
cairn done CAI-42 --resolution "raised supavisor pool_size to 40; default 15 was the cap"
```

The API refuses `done` without a resolution, and will suggest one from your last
checkpoint. `--kind fixed | wont-fix | duplicate | not-reproducible | superseded | answered`.

A closed task with no recorded answer is invisible to everyone who comes later.

## 5. Claiming, so agents don't collide

```bash
cairn claim CAI-42        # exit code 9 means another agent holds it
cairn beat CAI-42         # keep it alive during long work
cairn checkpoint CAI-42 --summary "migration written, tests not run"
cairn release CAI-42
```

- **Exit 9 means pick different work.** Do not force it.
- A claim is independent of `status` — a task can be `doing` and unclaimed.
- A lease goes stale after 15 minutes of silence and can then be taken over.
- Leave a checkpoint before you stop; it is how another agent resumes without your
  transcript.

## 6. Filing work

```bash
cairn add "title" --project CAI --type bug --priority high
cairn add "title" --project CAI --body -     # long markdown body from stdin
```

`--type`: `feature | bug | improvement | chore | spike | docs`
`--status`: `backlog | todo | doing | in-review | done | cancelled`
`--priority`: `urgent | high | medium | low`

`add` warns if similar work already exists — read the warning before continuing.

## 7. Dependencies

Before claiming, check whether something has to land first. A task with open blockers
is not ready to start, no matter what its status says.

```bash
cairn deps CAI-42                    # what blocks this, and what it blocks
cairn blockedby CAI-42 CAI-40        # CAI-40 must finish before CAI-42
cairn unblockedby CAI-42 CAI-40
```

Use this instead of writing "waiting on CAI-40" in a note: a note is prose nobody
queries, a dependency shows up on both tasks and in `cairn deps`.

`cairn block CAI-42 "reason"` is a different thing — it flags a task as stuck on
something outside Cairn (an unavailable credential, a third party). Reach for
`blockedby` when the blocker is another task.

## Output

TSV by default: a `#count` line, one header row, then rows; nulls omitted. `--json` to
parse, `--pretty` for a human. `cairn --help` is the full reference.

## Scope

Cairn holds open loops and durable answers. It is not a session log — for "what did I do
in that conversation last Tuesday", use your own host's memory.
