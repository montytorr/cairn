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
cairn show CAI-42                     # 2. full body of the ones that matter.
cairn note CAI-42 "..."               # 3. act, and record what you did.
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
cairn note CAI-42 --kind attempt  "Bumped pool_size to 30; no change under load."
cairn note CAI-42 --kind finding  "supavisor caps at default 15 regardless of client."
cairn note CAI-42 --kind decision "Sticking with supavisor; direct connections break PgBouncer."
```

**A recorded dead end is as valuable as a fix.** "Tried X, made no difference" saves the
next agent an hour. Write it down even though it failed — *especially* because it failed.

## 4. Closing a task requires a resolution

```bash
cairn done CAI-42 --resolution "Raised supavisor pool_size to 40; the default 15 was the cap."
```

The API rejects a `done` or `cancelled` transition with no resolution. This is deliberate:
a closed task with no record of *how* is invisible to everyone who comes after, and
retrofitting resolutions onto months of closed work is not possible. If it genuinely is
not fixed, say so — `--resolution-kind wont-fix` with a one-line reason is fine.

## 5. Claiming work, so three agents don't collide

```bash
cairn claim CAI-42        # exits non-zero if another agent holds it
cairn beat CAI-42         # keep the claim alive during long work
cairn checkpoint CAI-42 --summary "migration written, tests not yet run"
cairn release CAI-42      # or: cairn done CAI-42 --resolution "..."
```

- A claim is **execution state** and is independent of `status`. A task can be `doing` and
  unclaimed (a human is on it), or `todo` and claimed.
- If `claim` fails, another agent holds it — **pick different work**, do not force it.
- A claim whose heartbeat has stopped for 15 minutes is stale and can be taken over.
- Leave a `checkpoint` before you stop. It is what lets a different agent resume without
  reading your transcript.

## 6. Vocabulary

- **type** — `feature | bug | improvement | chore | spike | docs`
- **status** — `backlog | todo | doing | in-review | done | cancelled`
- **priority** — `urgent | high | medium | low`
- **note kind** — `note | finding | decision | attempt | handoff`
- **resolution kind** — `fixed | wont-fix | duplicate | not-reproducible | superseded | answered`

Tasks are referred to as `CAI-42` (project key + number). Use that form in prose; it stays
resolvable in a transcript long after the fact.

## 7. Knowledge, sessions and the briefing

Tasks are what should happen. Three other things live alongside them and `cairn check`
searches all four at once.

**Knowledge** — what we now know, outliving the task it was learned in.

```bash
cairn know                          # what applies here
cairn know <slug>                   # read it
cairn learn "<title>" --body -      # global unless you pass --project
cairn relearn <slug> --body -       # it changed
cairn unlearn <slug> --superseded-by <new-slug>
```

Three scopes, narrowest first: `--project HM` is true of that project, `--entity dispofi`
is true of that grouping (`cairn entities` lists them — a business, a stack, a subsystem),
and neither is true everywhere. A project belongs to several entities at once, so pick the
one the fact is actually about. When a fact exists at two scopes the narrower is shown
first, which is how "true for Dispofi, except here" gets said.

Correct knowledge rather than adding to it — two contradictory claims, equally findable,
with no way to tell which is current, is the failure mode every memory store reaches
eventually.

**Sessions** are written for you when a session ends: what was asked, what was learned,
what landed, where it was left. Any task you were still holding gets checkpointed at the
same time, so nothing depends on you remembering.

**The briefing** is `cairn context` — what you hold, what is in flight around you, where
the last session in this directory stopped, what is known here. A hook runs it at session
start; run it by hand when you have lost your place. `cairn map <KEY>` tells Cairn which
project a checkout belongs to.

## 8. Before you stop

The session record and the checkpoint are written for you when a session ends. These are
the things nothing can do on your behalf:

- **Close what you finished** — the API refuses a close without a resolution, so an open
  task is one you did not close, not one you closed badly.
- **Say what did not work** — `--kind attempt`. The next agent tries it again otherwise,
  and the trying is the expensive part.
- **Record what you learned**, and scope it: `--project` for one codebase, `--entity` for
  a business or a stack, neither for true everywhere. Unscoped is what you get by
  forgetting; the CLI says so when it happens.
- **Release or checkpoint anything you still hold.**

## 9. Output conventions

- Lists are TSV by default: a count line, one header row, then rows. Use `--json` if you
  are parsing programmatically, `--pretty` for a human.
- Nulls and defaults are omitted rather than printed.
- Errors tell you the valid values instead of just failing.

## 10. What Cairn is not

Cairn holds **open loops, durable answers, and what was learned getting to them**: what
should happen, who holds it, what was tried, how it ended, and what is now known.

It is not a transcript. It records what a session concluded, never what was said turn by
turn — so "what did we decide and why" is a Cairn question, and "what exactly did I type at
11:04" is not.

## Setup

```bash
export CAIRN_BASE_URL=https://cairn.example.com
export CAIRN_API_KEY=sk_live_...          # one key per agent, so writes are attributable
```

Full verb reference: `cairn --help`. Machine-readable API: `GET /api/v1/openapi.json`.
