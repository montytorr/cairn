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

You get back an index of prior work — open *and* closed — with whether each has a
recorded answer, and roughly what it costs to read. Open the one or two that look
relevant. **Do not re-debug something that has already been answered.** `cairn add` runs
the same query and warns before you file a near-duplicate.

## 2. The retrieval contract: check → show → act

```bash
cairn check "flaky auth redirect"     # 1. index of ids + one-liners. Cheap.
cairn show ACME-42                     # 2. full body of the ones that matter.
cairn note ACME-42 "..."               # 3. act, and record what you did.
```

Never fetch bodies in bulk to browse them: the index exists so you can decide what is
worth reading.

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

The API rejects `done` or `cancelled` with no resolution: a closed task with no record of
*how* is invisible to everyone who comes after. Say what kind of close it was — with no
`--kind` it records `fixed`, and `--kind verified` is the honest one when somebody else's
fix was already there and you checked.

## 5. Claiming work, so three agents don't collide

```bash
cairn claim ACME-42        # exits non-zero if another agent holds it
cairn beat ACME-42         # keep the claim alive during long work
cairn checkpoint ACME-42 --summary "migration written, tests not yet run"
cairn release ACME-42      # or: cairn done ACME-42 --resolution "..."
```

- **`claim` sets the status to `doing`.** From an agent runtime `cairn add` claims by
  default (`--no-start` only files); it holds back, and says why, when similar open work
  exists or you already hold a task in that project.
- **Sweeping a backlog: one claimed task per sweep.** Claim the triage task; `note`,
  re-status and close the rest without claiming them.
- **A checkpoint claims an unheld task for you**; a note does not, so annotating a
  backlog stays annotation. It never steals a live claim, never reopens closed work.
- `in-review` is for written-but-not-landed: unmerged, or merged and undeployed.
- `cairn commit|push|run` record what you shipped or ran; they execute nothing.
- A claim is execution state: a task can be `doing` and unclaimed (a human is on it).
- Exit 9 from `claim` means someone holds it: pick different work. A lease goes stale
  after 15 silent minutes and can be taken over. After two hours with no beat, note,
  checkpoint, edit or commit/push/run, the maintenance sweep releases it (`doing` → `todo`;
  `in-review` keeps its status).
- Checkpoint before you yield. It survives a release and is the only part that tells
  whoever picks the task up where you got to.

## 6. Vocabulary

- **type** — `feature | bug | improvement | chore | spike | docs`
- **status** — `backlog | todo | doing | in-review | done | cancelled`
- **priority** — `urgent | high | medium | low`
- **note kind** — `note | finding | decision | attempt | handoff`
- **resolution kind** — `fixed | verified | answered | wont-fix | duplicate | not-reproducible | superseded`

Tasks are referred to as `ACME-42` (project key + number). Use that form in prose; it stays
resolvable in a transcript long after the fact.

## 7. Knowledge, sessions and the briefing

**Knowledge** — what we now know, outliving the task it was learned in.

```bash
cairn know                          # what applies here
cairn know <slug>                   # read it
cairn learn "<title>" --body -      # scoped to this dir's project by default
cairn relearn <slug> --body -       # it changed
cairn unlearn <slug> --superseded-by <new-slug>
```

Three scopes, narrowest first: `--project ACME`, `--entity acme` (a business, a stack, a
subsystem — `cairn entities`), and `--global`. With none, `learn` takes this directory's
project and refuses where there is none. Correct knowledge (`relearn`, `unlearn`, `verify`)
rather than adding a second, contradictory claim. Secrets are refused on every write.

**Sessions** are written for you when a session ends. The runtime also checkpoints tasks
the session worked on, but never over a checkpoint you wrote on a claim it cannot prove is
its own — your own checkpoint is the handoff that counts.

**The briefing** is `cairn context` — what you hold, what is in flight around you, where
the last session in this directory stopped, what is known here. A hook runs it at session
start. `cairn next` says what to pick up and why. `cairn map <KEY>` tells Cairn which
project a checkout is — once per repository; clones and worktrees follow.

## 8. Before you stop

The session record is written for you. These are the things nothing can do for you:

- **Close what you finished** — the API refuses a close without a resolution, so an open
  task is one you did not close, not one you closed badly.
- **Say what did not work** — `--kind attempt`. The next agent tries it again otherwise,
  and the trying is the expensive part.
- **Record what you learned**, scoped.
- **Checkpoint what you still hold**; `release` only what you are handing back unfinished.

## 9. Output conventions

- Lists are TSV by default: a count line, one header row, then rows; nulls omitted.
  `--json` to parse, `--pretty` for a human. Errors name the valid values.

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
`CAIRN_API_KEY_CODEX`, `CAIRN_API_KEY_CLAUDE_CODE`.

Full verb reference: `cairn --help`. Machine-readable API: `GET /api/v1/openapi.json`.
