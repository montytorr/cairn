# Cairn — agent guide

Cairn is a self-hosted task tracker whose tasks **are** the shared memory for the agents
working on a codebase. Anything you learn, try, or fix belongs here, because the next
agent — or the human, six weeks from now — will look here first.

Read this whole file. It is short on purpose. The detail is in `skills/cairn/SKILL.md`
(the lifecycle) and `skills/cairn/reference.md` (read on demand).

---

## 1. Check before you start: check → show → act

```bash
cairn check "flaky auth redirect"     # 1. index of ids + one-liners, open and closed. Cheap.
cairn show ACME-42                     # 2. digest of the ones that matter (--full: all).
cairn note ACME-42 "..."               # 3. act, and record what you did.
```

**Do not re-debug something that has already been answered.** Never fetch bodies in bulk
to browse them: the index exists so you can decide what is worth reading. `cairn add` runs
the same query and warns before you file a near-duplicate. Write bodies as markdown — `##`
headings, lists, code in backticks: the API refuses an agent's wall of text.
An unknown flag or value is refused with the valid ones named: read the error, don't guess.

## 2. Claim what you work

```bash
cairn claim ACME-42        # sets `doing`; exit 9 if another agent holds it
cairn checkpoint ACME-42 --summary "migration written, tests not yet run"
```

**Exit 9 means someone holds it: pick different work.** From an agent runtime `cairn add`
claims by default (`--no-start` only files). Sweeping a backlog: one claimed task per
sweep; `note`, re-status and close the rest without claiming them. A claim is not
ownership: every task has a human assignee, and `--assignee` gives it to someone else.
Leases, liveness and what the sweep releases: `reference.md`, claims and liveness.

## 3. Record as you go

| Write a… | When | Audience |
|---|---|---|
| **note** | You tried, found or decided something | The next agent |
| **comment** | You need the human to read it | The human |
| **resolution** | The task is finished — required on close | Everyone, later |

```bash
cairn note ACME-42 --kind attempt  "Bumped pool_size to 30; no change under load."
cairn note ACME-42 --kind finding  "supavisor caps at default 15 regardless of client."
cairn note ACME-42 --kind decision "Sticking with supavisor; direct connections break PgBouncer."
```

**A recorded dead end is as valuable as a fix.** "Tried X, no difference" saves the next
agent an hour — write it down *especially* because it failed.

**Never paste secrets.** Credentials and keys are refused on every write that is read
back: notes, comments, knowledge, bodies.

## 4. Status, and closing with a resolution

- **Checkpoint before you yield.** It survives a release and is the only part that tells
  whoever picks the task up where you got to.
- **Written but not landed** (unmerged, or merged and undeployed):
  `cairn update ACME-42 --status in-review`. Never `done` for that.

```bash
cairn done ACME-42 --resolution "Raised supavisor pool_size to 40; the default 15 was the cap."
```

The API rejects `done` or `cancelled` with no resolution. Say what kind of close it was:
with no `--kind` it records `fixed`, and `--kind verified` is the honest one when
somebody else's fix was already there and you checked. The others: `answered`, `wont-fix`,
`duplicate`, `not-reproducible`, `superseded`.

## 5. Before you stop

The session record is written for you. These are the things nothing can do for you:

- **Close what you finished**, with a resolution.
- **Say what did not work** — `--kind attempt`. The next agent tries it again otherwise.
- **Record what you learned**, scoped: `cairn learn` (`reference.md`, knowledge).
- **Checkpoint what you still hold**; `release` only what you hand back unfinished.

Refer to tasks as `ACME-42` in prose. Types, statuses, priorities, the briefing
(`cairn context`, `cairn next`) and output conventions (TSV; `--json` to parse): `reference.md`.

## 6. What Cairn is not

Cairn holds **open loops, durable answers, and what was learned getting to them**.

It is not a transcript: it records what a session concluded, never what was said turn by
turn. "What did we decide and why" is a Cairn question; "what did I type at 11:04" is not.

## Setup

```bash
cairn setup --url https://cairn.example.com   # a person, once per machine
```

It pairs a key per runtime — `CAIRN_API_KEY_CODEX`, `CAIRN_API_KEY_CLAUDE_CODE` — because
the key *is* the identity.

Full verb reference: `cairn --help`. Machine-readable API: `GET /api/v1/openapi.json`.
The Lab and hand-off: `skills/cairn/lab.md`, `docs/lab.md`.
