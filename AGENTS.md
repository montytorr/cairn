# Cairn — agent guide

Cairn is a self-hosted task tracker whose tasks **are** the shared memory for the agents
working on a codebase. Anything you learn, try, or fix belongs here, because the next
agent — or the human, six weeks from now — will look here first.

Read this whole file. It is short on purpose.

---

## 1. Check before you start. Always.

**Before beginning work on any subject, run:**

```bash
cairn check "supabase pooler connection timeouts"
```

You get back an index of prior tasks — open *and* closed — with whether each has a
recorded resolution, and roughly what it costs to read. Open the one or two that look
relevant. **Do not re-debug something that has already been answered.**

`cairn add` runs the same query implicitly and warns you if you are about to file a
near-duplicate.

## 2. The retrieval contract: check → show → act

```bash
cairn check "flaky auth redirect"     # 1. index of ids + one-liners. Cheap.
cairn show ACME-42                     # 2. full body of the ones that matter.
cairn note ACME-42 "..."               # 3. act, and record what you did.
```

Never fetch bodies in bulk to browse them. The index exists so you can decide what is
worth reading; list output is deliberately terse and every row advertises its own
expansion cost.

## 3. Record as you go

Three different things, three different places:

| Write a… | When | Audience |
|---|---|---|
| **note** | You tried something, found something, or decided something | The next agent |
| **comment** | You need the human to read it | The human |
| **resolution** | The task is finished — required on close | Everyone, later |

```bash
cairn note ACME-42 --kind attempt  "Bumped pool_size to 30; no change under load."
cairn note ACME-42 --kind finding  "supavisor caps at default 15 regardless of client."
cairn note ACME-42 --kind decision "Sticking with supavisor; direct connections break PgBouncer."
```

**A recorded dead end is as valuable as a fix.** "Tried X, made no difference" saves the
next agent an hour. Write it down even though it failed — *especially* because it failed.

## 4. Closing a task requires a resolution

```bash
cairn done ACME-42 --resolution "Raised supavisor pool_size to 40; the default 15 was the cap."
```

The API rejects a `done` or `cancelled` transition with no resolution. This is deliberate:
a closed task with no record of *how* is invisible to everyone who comes after, and
retrofitting resolutions onto months of closed work is not possible. If it genuinely is
not fixed, say so — `--kind wont-fix` with a one-line reason is fine.

## 5. Claiming work, so three agents don't collide

```bash
cairn claim ACME-42        # exits non-zero if another agent holds it
cairn beat ACME-42         # keep the claim alive during long work
cairn checkpoint ACME-42 --summary "migration written, tests not yet run"
cairn release ACME-42      # or: cairn done ACME-42 --resolution "..."
```

- **`claim` sets the status to `doing`**; `cairn add --start` does both at once.
- `cairn commit|push|run` record what you shipped or ran; they execute nothing.
- **A checkpoint claims an unheld task for you**; a note does not, so annotating a
  backlog stays annotation. It never steals a live claim, never reopens closed work.
- `in-review` is for written-but-not-landed; `--kind verified` for a fix already there.
- **A resolution is refused unless the status is closing.**
- A claim is execution state: a task can be `doing` and unclaimed (a human is on it).
- `claim` failing means someone holds it: pick different work. A lease goes stale after
  15 silent minutes and can be taken over; two hours releases it (doing → todo).
- Leave a `checkpoint` before you stop. Notes and checkpoints survive a release, and the
  checkpoint is the only part that tells whoever picks it up where you got to.

## 6. Vocabulary

- **type** — `feature | bug | improvement | chore | spike | docs`
- **status** — `backlog | todo | doing | in-review | done | cancelled`
- **priority** — `urgent | high | medium | low`
- **note kind** — `note | finding | decision | attempt | handoff`
- **resolution kind** — `fixed | wont-fix | duplicate | not-reproducible | superseded | answered`

Tasks are referred to as `ACME-42` (project key + number). Use that form in prose; it stays
resolvable in a transcript long after the fact.

## 7. Knowledge, sessions and the briefing

Tasks are what should happen. Three other things live alongside them and `cairn check`
searches all four at once.

**Knowledge** — what we now know, outliving the task it was learned in.

```bash
cairn know                          # what applies here
cairn know <slug>                   # read it
cairn learn "<title>" --body -      # scoped to this dir's project by default
cairn relearn <slug> --body -       # it changed
cairn unlearn <slug> --superseded-by <new-slug>
```

Three scopes, narrowest first: `--project ACME`, `--entity acme` (a business, a stack, a
subsystem — `cairn entities` lists them), and `--global`, which is everywhere. A project
belongs to several entities at once, so pick the one the fact is about. The narrower is
shown first, which is how "true for this business, except here" gets said.

Correct knowledge rather than adding to it — two contradictory claims, equally findable,
with no way to tell which is current, is the failure mode every memory store reaches.

**Sessions** are written for you when a session ends: what was asked, what was learned,
what landed, where it was left. Any task you were still holding gets checkpointed at the
same time, so nothing depends on you remembering.

**The briefing** is `cairn context` — what you hold, what is in flight around you, where
the last session in this directory stopped, what is known here. A hook runs it at session
start; run it by hand when you have lost your place. `cairn map <KEY>` tells Cairn which
project a checkout belongs to — once per repository, not once per directory: it claims the
repository itself, so a second clone, a moved directory and a `git worktree` all get the
same briefing without being mapped again.

## 8. Before you stop

The session record and the checkpoint are written for you when a session ends. These are
the things nothing can do on your behalf:

- **Close what you finished** — the API refuses a close without a resolution, so an open
  task is one you did not close, not one you closed badly.
- **Say what did not work** — `--kind attempt`. The next agent tries it again otherwise,
  and the trying is the expensive part.
- **Record what you learned**, and scope it: `--project` for one codebase, `--entity` for
  a business or a stack, `--global` for true everywhere. Given none it takes this
  directory's project, and refuses if there is none.
- **Release or checkpoint anything you still hold.**

## 9. Output conventions

- Lists are TSV by default: a count line, one header row, then rows. Use `--json` if you
  are parsing programmatically, `--pretty` for a human.
- Nulls and defaults are omitted rather than printed.
- Errors tell you the valid values instead of just failing.

## 10. What Cairn is not

Cairn holds **open loops, durable answers, and what was learned getting to them**: what
should happen, who holds it, what was tried, how it ended, and what is now known.

It is not a transcript: it records what a session concluded, never what was said turn by
turn. "What did we decide and why" is a Cairn question; "what did I type at 11:04" is not.

## Setup

```bash
export CAIRN_BASE_URL=https://cairn.example.com
export CAIRN_API_KEY=sk_live_...
```

The key *is* the identity, so a machine running several runtimes wants one each —
`CAIRN_API_KEY_CODEX`, `CAIRN_API_KEY_CLAUDE_CODE` — or all their work files under one
name.

Full verb reference: `cairn --help`. Machine-readable API: `GET /api/v1/openapi.json`.
