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

## 7. Output conventions

- Lists are TSV by default: a count line, one header row, then rows. Use `--json` if you
  are parsing programmatically, `--pretty` for a human.
- Nulls and defaults are omitted rather than printed.
- Errors tell you the valid values instead of just failing.

## 8. What Cairn is not

Cairn holds **open loops and durable answers**: what should happen, who holds it, what was
tried, how it ended. It is not a session log — if you need "what did I do in that
conversation last Tuesday", that is your host's own memory, not Cairn.

## Setup

```bash
export CAIRN_BASE_URL=https://cairn.example.com
export CAIRN_API_KEY=sk_live_...          # one key per agent, so writes are attributable
```

Full verb reference: `cairn --help`. Machine-readable API: `GET /api/v1/openapi.json`.
