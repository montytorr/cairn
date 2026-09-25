# Cairn

[![CI](https://github.com/montytorr/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/montytorr/cairn/actions/workflows/ci.yml)
[![Licence: Sustainable Use](https://img.shields.io/badge/licence-Sustainable%20Use-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.1-blue.svg)](./CHANGELOG.md)

**The tracker your agents read before they start, and write to as they work.**

They check it for prior work, claim what they take, record what they tried — including
what failed — and close nothing without saying how. Six weeks later a different agent
asks the same question and gets the answer instead of repeating the work.

Self-hosted. A cairn is a stack of stones travellers leave to mark a path for whoever
comes next: a different agent, a different model, you in six weeks.

Three hooks make it happen without anyone being reminded — a briefing when a session
starts, what is known about a file when one is opened, and the session written down when
it ends.

> **One shared workspace.** Every active user and agent can work across the same projects,
> tasks and memory. Administrators manage membership, roles and agent keys; owner columns
> remain attribution metadata rather than visibility boundaries.
>
> **Pre-1.0.** Stable in practice and running in production, but a minor version may still
> change the schema or the API. Anything that breaks an existing install is called out in
> the [changelog](./CHANGELOG.md).

**Jump to:** [Self-hosting](#self-hosting) · [Agent setup](#agent-setup) · [The CLI](#the-cli) ·
[API](#api) · [Scheduled maintenance](#scheduled-maintenance--optional) ·
[Architecture](#architecture) · [Contributing](#contributing)

It holds **four stores**, and one verb — `cairn check` — searches all four in a single
pass:

| | answers | written |
|---|---|---|
| **tasks** | what needs doing, what was done, how it was resolved | by you and by agents |
| **notes** | what was tried on the way, including what did not work | by agents, as they work |
| **knowledge** | what we now *know* — infra, conventions, gotchas — outliving any one task | deliberately, and corrected rather than appended to |
| **sessions** | what happened in a working session, and where it was left | automatically, when a session ends |

---

## What it looks like

An agent picks up a report that migrations are timing out. First question, always: has
anybody been here before?

```console
$ cairn check "migrations time out under parallel workers"
#0
nothing found — this subject looks new
```

Nothing. So file it. `add` probes for near-duplicates before it creates anything, ORing
the distinctive words rather than ANDing the phrase, so it surfaces things `check` rightly
did not:

```console
$ cairn add "Migrations time out when workers run in parallel" --project ACME --type bug
similar existing work:
  ACME-12 [done] Make the migration runner idempotent
id	9f3c1a04-2b77-4a0e-8d51-6e0c2f1b9a44
number	57
title	Migrations time out when workers run in parallel
type	bug
status	backlog
priority	medium
created_at	2026-08-14T14:51:09.223Z
ref	ACME-57
```

Take it, so a second agent on the same backlog picks something else:

```console
$ cairn claim ACME-57
id	9f3c1a04-2b77-4a0e-8d51-6e0c2f1b9a44
number	57
status	doing
claimed_by	claude-code · Alice
claimed_at	2026-08-14T14:52:40.102Z
heartbeat_at	2026-08-14T14:52:40.102Z
attempt	1
```

`claim` is one conditional UPDATE. If somebody else holds it, it exits **9** and says who,
rather than guessing:

```console
$ cairn claim ACME-57
Held by codex · Bob, last heartbeat 3m ago. Pick different work; a lease becomes stealable
after 15m of silence.
```

Then the work log, as the work happens. The dead end goes in too — it is the half that
saves the next agent an hour:

```console
$ cairn note ACME-57 "Raised the client pool_size to 30. No change under load." --kind attempt
... (the written row, same shape as below)

$ cairn note ACME-57 "Supavisor caps at its own pool_size regardless of what the client asks for." --kind finding
id	c02b8f31-5c4d-4f2a-9a63-1f0d7e3a55b1
kind	finding
note	Supavisor caps at its own pool_size regardless of what the client asks for.
actor_type	agent
actor_id	claude-code · Alice
created_at	2026-08-14T15:41:52.006Z
```

The finding outlives the task, so promote it to knowledge — scoped to the project, because
it is not true everywhere:

```console
$ cairn learn "Supavisor caps the pool at its own setting" --project ACME \
    --body "The client's pool_size is advisory. Raise it in the pooler's own config; the client-side value never wins."
id	4a7e9b12-83cd-4d7f-b0a1-2c5f8d6e7099
slug	supavisor-caps-the-pool-at-its-own-setting
title	Supavisor caps the pool at its own setting
body	The client's pool_size is advisory. Raise it in the pooler's own config; the client-side value never wins.
actor_type	agent
actor_id	claude-code · Alice
created_at	2026-08-14T16:01:44.870Z
updated_at	2026-08-14T16:01:44.870Z
projects	ACME
```

Close it. The resolution is not optional — the API rejects a `done` or `cancelled`
transition without one:

```console
$ cairn done ACME-57 --resolution "Raised the pooler's own pool_size to 40; the client-side setting was never the cap."
id	9f3c1a04-2b77-4a0e-8d51-6e0c2f1b9a44
number	57
title	Migrations time out when workers run in parallel
type	bug
status	done
priority	medium
resolution	Raised the pooler's own pool_size to 40; the client-side setting was never the cap.
resolution_kind	fixed
updated_at	2026-08-14T16:04:18.551Z
```

**Six weeks later**, a different agent on a different machine asks the same question. It
now gets the task, the finding inside it, the knowledge that outlived it, and the session
that produced all three — ranked, with the cost of opening each:

```console
$ cairn check "supavisor pool exhaustion"
#4
kind	ref	status	type	answered	tokens	title
task	ACME-57	done	bug	yes	~30	Migrations time out when workers run in parallel
knowledge	supavisor-caps-the-pool-at-its-own-setting	current	knowledge		~32	Supavisor caps the pool at its own setting
note	ACME-57	done	bug	yes	~21	Supavisor caps at its own pool_size regardless of what the client asks…
session	2026-08-14	claude-code · Alice	session	yes	~74	migrations time out when workers run in parallel
3 precise, 1 loose
```

`show` gives the cheap read: the answer in full, the findings and decisions, a clipped
body, and an honest account of what it withheld.

```console
$ cairn show ACME-57
ref	ACME-57
number	57
title	Migrations time out when workers run in parallel
type	bug
status	done
priority	medium
resolution	Raised the pooler's own pool_size to 40; the client-side setting was never the cap.
resolutionKind	fixed
updatedAt	2026-08-14T16:04:18.551Z
findings.0.kind	finding
findings.0.note	Supavisor caps at its own pool_size regardless of what the client asks for.
findings.0.by	claude-code · Alice
findings.0.at	2026-08-14T15:41:52.006Z
omitted.descriptionBytes	0
omitted.attemptsAndNotes	1
omitted.tokensToFetchFull	118
omitted.full	?view=full
withheld: 0B of body, 1 attempt/note(s) — cairn show ACME-57 --full is ~118 tokens
```

Nobody typed `cairn session end`. The hook did it.

---

## Why

Task trackers record *intent* and throw away *knowledge*. A task closes as "done" and the
reasoning evaporates, so the next person re-debugs the same problem. That is tolerable on
a human team, where the memory lives in people. It is fatal when the workers are AI agents
with no memory between sessions.

Cairn makes the tracker the memory:

- **Check before you start.** One verb searches tasks, notes, knowledge and sessions —
  open and closed — so an agent learns what was already tried before spending a token
  on it.
- **Resolutions are mandatory.** Closing requires recording *how*. A closed task with no
  answer in it is invisible to everyone who comes after, and resolutions cannot be
  retrofitted onto months of closed work.
- **Dead ends are first-class.** "Tried X, no difference" is worth as much as the fix, and
  the append-only work log is where it goes.
- **Attributable.** Every write records which agent made it, so "who tried what, and did it
  work" is always answerable.

## Two mechanisms, so nobody has to remember

This is the part that makes the rest hold. Installed by `node scripts/install-hooks.mjs`.

| When | What happens |
|---|---|
| session start | the briefing is injected — what you hold, what is in flight, where the last session in this directory stopped, what is known here |
| session end | the session is recorded, and any task still held is checkpointed |

There used to be a third, on every file read. It had no cache and no debounce, so each
`Read` cost a node process and a fresh HTTPS request, and on Codex, which has no `Read`
tool, it never matched at all. It was removed by hand (CCS-40), and the installer now
removes its own entry wherever it finds one rather than writing it back. The hook script
still answers `PreToolUse` if you wire it yourself.

An integration can persist progress without ending a session:

```bash
cairn session checkpoint --id agent:example --platform other --agent example-agent \
  --project DEMO --cwd "$HOME/projects/demo" \
  --request 'Work on a feature' --completed 'Implementation in progress'
```

`session checkpoint` upserts on `(platform, id)`, leaves `ended_at` null, and never
checkpoints held tasks. Repeat it with updated fields as work progresses; finish with
`cairn session end --id agent:example --platform other` (and the desired summary
flags). A late checkpoint after an end is refused rather than reopening the session.
Sparse updates preserve earlier non-null prose, project, path, start time, and nonempty
file/task lists; send an empty string to clear a prose field. Empty file/task lists
cannot clear previously recorded lists.

Every hook fails silent and non-blocking. A memory system must never be the reason a
session cannot start or close. `CAIRN_HOOK_DEBUG=1` when that silence is itself the
problem.

## Features

**Tracking**

| | |
|---|---|
| Refs | `ACME-42` — project key plus per-project number, stable in a transcript |
| Types | `feature · bug · improvement · chore · spike · docs` |
| Statuses | `backlog · todo · doing · in-review · done · cancelled` |
| Structure | sub-tasks, blocked-by / blocks dependencies with cycle rejection, labels, priorities, due dates |
| Bodies | markdown in a WYSIWYG editor — syntax-highlighted code, GFM tables and task lists; bare refs like `ACME-42` become links |
| Trails | comments for humans, an append-only work log for agents, file attachments, and a full activity history |
| Views | list and board per project, a cross-project board at `/board` grouped and swim-laned by status, priority, type, project or agent, bulk edit with shift-click ranges, a cross-project home, a map of the knowledge corpus at `/knowledge/graph`, live updates over SSE |
| Multi-project tasks | a task can belong to several projects at once — the home project keeps the ref, the extra links only widen where it appears |

**Memory**

- Postgres full-text search across all four stores in one pass.
- Two arms, both always run, merged. The precise arm returns rows carrying at least half
  the distinctive terms of the question; the wide arm returns everything matching any of
  them; a row found by both appears once, in the precise head. Each row says which arm
  found it, because twenty loose word-overlaps silently read as prior work.
- That is not how it started. For years the wide arm ran *only when the precise one came
  back thin* — and the precise arm ANDed every content word of the question, so three long
  descriptions that happened to contain all of them switched off the arm that answers it.
  Demonstrated on a live store: a question missed its answer entirely, and appending one
  nonsense word — which emptied the precise arm — brought the answer back at rank 7. Same
  corpus, same question. Across a 22-query evaluation set English recall@20 went from
  **0.43 to 0.86** and the share of answers found by the precise arm from 3 to 15 — the
  second figure is all this change, the first is partly a store that grew between the two
  measurements, which is why the baseline now records what it was measured against. See [`055`](./migrations/055_search_stop_suppressing_the_fallback.sql) for
  `search_all` and [`056`](./migrations/056_search_tasks_stop_suppressing_the_fallback.sql)
  for `search_tasks`, the task-only path the web UI and `cairn check --tasks` take.
- Ranking happens in the database, by `ts_rank`. Closed work is included on purpose, and a
  row carrying a recorded answer outranks one that merely mentions the subject. Every rule
  here came out of measurement rather than taste, and so did the rejections: ranking by
  term coverage first tested worse (87% → 81%) and was reverted, and re-sorting in the
  application dropped recall from 75% to 6%. The reasoning is written into
  [`004_search_ranked.sql`](./migrations/004_search_ranked.sql) and
  [`016_search_all.sql`](./migrations/016_search_all.sql).
- The evaluation set is [`tests/fixtures/search-eval.json`](./tests/fixtures/search-eval.json):
  22 paraphrased questions with their known-good answers, each pinning the invocation it is
  scored under, because `--project` and `--kinds` reorder the same store and a case that
  does not say which it used has several correct answers. `node scripts/score-search-eval.mjs`
  scores it and records what the numbers were measured against — the server build, the CLI
  version, the size of the store — since the same file once recorded 0.73 and gave 0.82 on
  a re-run the same day, with no code change, because the store had grown.
- Results are an **index**, never bodies: each row advertises a `~tokens` cost, so an agent
  budgets what it opens instead of pulling text it will never read.
- **Knowledge is scoped narrowest-first**, to one of three widths:

  | scope | means | example |
  |---|---|---|
  | a **project** | true of this codebase | "rating caches the wizard config for 60s" |
  | an **entity** | true of a grouping the project belongs to | "Customer.io campaign ids live in the broadcast, not the template" |
  | nothing at all | true everywhere | "this Mac's Postgres is broken; use embedded-postgres" |

  An **entity is a grouping a fact can be true of** — a business, a stack, a subsystem —
  and a project belongs to several at once. It exists because the alternatives are both
  wrong: filing the same fact against twenty projects, or making it global and putting it
  in front of the other forty where it is false. A project fact outranks an entity fact
  outranks a global one, which is how "true for this business, except here" gets said.

  Knowledge is corrected rather than added to: `superseded_by` keeps the old claim
  findable and marked, because two contradictory facts with no way to tell which is
  current is how a memory store stops being worth reading.
- **Every fact has a slug**, derived from its title — lowercased, hyphenated, cut at a
  whole word. It is the name the fact keeps: what `cairn know <slug>` reads back, what the
  URL carries, and what goes inside `[[...]]` to reference it from another entry. `--slug`
  overrides it, which is worth doing when the claim is too long to make a good handle —
  entries whose slug runs past sixty characters are referenced by other entries about an
  eighth as often as short ones.
- **Entries reference each other** as `[[some-slug]]`, resolving in the browser and the
  CLI alike, with underscores read as hyphens so older spellings still work. A reference to
  an entry nobody has written is *marked* rather than quietly linked into nothing — in the
  rendered body, and on the way out of `cairn know <slug>`. On the way *in*, a write is
  refused outright when a reference resolves to nothing and the store already holds a
  near-named entry, and the refusal names that slug: at that distance it is a misspelling,
  not an entry nobody has written yet. `--allow-dangling` is for when that reading is wrong.
- **A map of the corpus** at `/knowledge/graph`, and the same findings without a screen
  through `cairn know --gaps`. It answers the question a list cannot: what is connected to
  *nothing*. Here that was a quarter of the entries, nineteen separate islands, and dozens
  of references pointing at entries nobody ever wrote — none of it visible anywhere before,
  because a list shows what is there.
- **A file index** answers the question nobody asks: opening a file surfaces the tasks and
  knowledge that concern it, with no query to write.

**Coordination**

- A claim / heartbeat / checkpoint protocol so several agents can work one backlog without
  colliding. A lease whose holder has gone quiet for 15 minutes becomes stealable — one
  conditional UPDATE, no reaper, no cron, no lease table.
- **Durable writes and integrity boundaries.** Notes, comments, heartbeats and checkpoints
  can queue locally during an outage and replay without silently losing rejected or malformed
  records. Checkpoints carry the ownership generation and a monotonic sequence, so stale,
  duplicated or concurrently replayed writes cannot resurrect a released claim or overwrite
  newer work. The server applies claim, release, checkpoint and knowledge mutations atomically.
- `cairn reconcile` releases claims an agent walked away from, leaving a note saying why —
  the backstop for runtimes with no session-end event. It never closes anything: a task
  with a resolution nobody meant is worse than one plainly still open.
- `cairn context` is the briefing a session opens with, and is worth running by hand
  whenever you have lost your place.

## Agent access

Three interfaces over **one** implementation, so behaviour cannot diverge between them —
the CLI is that implementation, and the other two shell out to it. Coverage can still
differ: the MCP server exposes the verbs worth calling as typed tools rather than all of
them, so `context`, `next`, `history` and the session verbs stay CLI-only.

| Interface | For |
|---|---|
| `cairn` CLI | anything that can run a shell command — this is the implementation |
| `SKILL.md` | Claude Code, Codex and OpenClaw; all three read skill folders |
| MCP server | native tool-calling — a thin facade over the CLI, holding no logic; a subset of its verbs |

[`AGENTS.md`](./AGENTS.md) is the contract every agent should read. It is kept under 7900
bytes, and a test enforces that, because agents read it every session.

**A flag that does nothing says so.** An unknown flag is refused outright — a parser that
ignores what it does not understand cannot be trusted by anything automated, and this
CLI's whole audience is automated. A *known* flag that the verb you ran never looks at is
reported too, which is the harder half: `cairn relearn <slug> --global` once parsed
cleanly, printed the entry, exited 0 and changed nothing. There is no per-verb table
behind this — a table rots the first time a verb grows an option, and a wrong entry breaks
a working command on every machine at once. `flags` is a proxy that records what the
running command actually read, so the reads are the registry, and the report is about this
invocation rather than about what some analysis believes the code would do. A read that
ignored a flag exits 2, because nothing has happened yet and the answer looks filtered
when it is not; a write warns and exits 0, because it already went through and an exit
code saying otherwise is how a caller ends up making it twice.

### The CLI

Output is TSV by default — a `#count` line, a header row, then rows — with `--json` to
parse and `--pretty` to read. Nulls and defaults are omitted rather than printed. `--body -`
and `--resolution -` read from stdin, so long markdown stays off argv.

| | |
|---|---|
| `cairn check "<subject>"` | **Start here.** Prior work across all four stores, with a `~tokens` cost per row |
| `cairn context [--scope project\|all] [--project K]` | The briefing: what you hold, what is in flight, where the last session here stopped. `--scope project` limits held work, stale claims, and the last session to the resolved project; the default `all` keeps cross-project awareness. An unresolved project is an error in project scope; an unknown explicit key returns 404. |
| `cairn next` | **What to pick up, and why.** Finishing beats starting, so work you hold ranks above work dropped with a checkpoint, which ranks above anything not begun. Blocked, waiting, or actively held by another agent is never offered |
| `cairn show <ref>` · `cairn list --project K` · `cairn projects` | Read one, many, or the project index |
| `cairn add "<title>" --project K` | File work. Warns if something similar already exists |
| `cairn update <ref> --status S --priority P` | Change fields; `--project` moves it, `--also-project` widens it |
| `cairn done <ref> --resolution "…"` | Close. The resolution is required. `--kind verified` when you closed it because somebody else's fix was already there — `fixed` would claim their work |
| `cairn update <ref> --status in-review` | Written but not landed: merged and undeployed, or done and unmerged |
| `cairn cancel <ref> --resolution "…"` | Drop it, and say why |
| `cairn note <ref> "…" --kind attempt` | Append to the work log — `note · attempt · finding · decision · handoff` |
| `cairn commit <ref> <sha>` · `cairn push <ref> <sha>` | Record delivery evidence in the task history |
| `cairn run <ref> "<command>" --status passed\|failed\|skipped` | Record a command result in the task history |
| `cairn log <ref>` · `cairn history <ref>` | The work log, and what changed when and by whom |
| `cairn comment <ref> "…"` | Leave something for the human |
| `cairn attach <ref> <file>` · `cairn files <ref>` | Attachments |
| `cairn children <ref>` · `cairn add … --parent <ref>` | Sub-tasks |
| `cairn deps <ref>` · `cairn blockedby <ref> <other>` · `cairn unblockedby` | Dependencies |
| `cairn labels [rename\|remove]` | Every label in use; renaming onto an existing label merges them |
| `cairn claim <ref>` | Take it. **Exit code 9** means another agent holds it |
| `cairn beat <ref>` · `cairn release <ref>` | Keep a claim alive, or drop it |
| `cairn checkpoint <ref> --summary "…"` | Where work stopped, for whoever resumes |
| `cairn block <ref> --reason "…"` · `cairn unblock <ref>` | Stuck on something outside Cairn |
| `cairn learn "<title>" --body -` | Record what we now know. Scoped to this directory's project unless `--project`, `--entity` or `--global`, and refused where there is no project to infer — global is a claim about every project you have, so it is chosen rather than arrived at |
| `cairn add ... --start` | File it and claim it, for work you are starting now |
| `cairn verify <slug>` | This fact is still true. Clears the stale mark without rewriting it |
| `cairn task delete <ref> --confirm <ref>` | For junk that should never have existed. Refused if the task has children, notes, comments or dependencies — cancel keeps the record |
| `cairn know [<slug>\|<query>]` | Read it back, or list what applies here |
| `cairn know --gaps` · `--orphans` · `--dangling` | Where the memory has holes: entries joined to nothing, and references pointing at entries nobody wrote |
| `cairn relearn <slug>` · `cairn unlearn <slug> --superseded-by <slug>` | Correct it, or mark it replaced |
| `cairn relearn <slug> --project K` · `--entity E` · `--global` | Re-scope a fact filed too narrowly. `--global` clears both and refuses to be combined with either |
| `--allow-dangling` (on `learn` and `relearn`) | Keep a `[[reference]]` the store cannot resolve. A write is otherwise refused when a reference names nothing and a near-named entry exists; the refusal names that slug, so retrying with it is the usual answer, and this flag is for when it gets that wrong |
| `cairn entities` · `cairn entities assign <key> --project A,B` | Groupings a fact can be true of |
| `cairn session list` · `cairn session end --id <id>` | The episodic record |
| `cairn reconcile` | Release your own claims that went quiet |
| `cairn vitals [--all]` | Is the memory still being written — counts against the week before, and what looks wrong. `--all` adds whether it is being *read*: searches, how many widened or came back empty, tasks filed without checking first, and `asked for, not held: <slug>` for each recent miss |
| `cairn project rename\|archive\|restore\|delete <KEY>` | Deleting takes every task with it, and demands `--confirm <KEY>` |
| `cairn project rekey <KEY> <NEW>` · `cairn project rename <KEY> --key <NEW>` | Change the key. Every ref is renumbered under the new key, the old refs keep resolving, and the old key cannot be given to another project. Anything reached through a retired key says so — `AC-113 is now HOL-113`, `note: project AC is now HOL` — on stderr, and as `requested_ref` / `renamed_from` in the JSON. `cairn projects` lists former keys in a trailing `was` column |
| `cairn replay` | Send writes put aside while the server was unreachable. Rarely needed by hand — any successful write drains the queue |
| `cairn map <KEY>` | Tell Cairn which project this checkout is. Validates the key, and claims the repository so every other clone and worktree resolves too. `cairn map none` releases both |

`cairn --help` is the full reference.

## API

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 document generated from the same Zod
schemas the routes validate against, so it cannot drift. Browsable at `/api-docs`.

```
/health                         unauthenticated probe; reports the commit it was built from
/vitals?hours=24                whether the memory is still being written and read, and what looks wrong
/search                         the read half of Cairn-as-memory
/projects  /projects/{id}       list, create, read, rename, delete
/projects/{id}/tasks            list and create within a project
/tasks/{ref}                    read, update, close
/tasks/{ref}/notes              the work log
/tasks/{ref}/comments           for the human
/tasks/{ref}/activity           read history; POST git/run delivery evidence
/tasks/{ref}/children           sub-tasks
/tasks/{ref}/attachments        upload; /attachments/{id} to fetch
/tasks/{ref}/dependencies       blocked-by / blocks
/tasks/{ref}/claim  /beat  /release  /checkpoint  /block
/knowledge  /knowledge/{slug}   what we know, and correcting it
/entities                       groupings a fact can be true of
/labels                         every label in use; rename and remove
/sessions                       the episodic record
/context                        the briefing a session opens with
/reconcile                      release claims that went quiet
/events                         change stream (SSE)
/keys  /keys/{id}               issue and revoke agent keys
/users  /users/{id}             administrator-only membership and role management
/users/{id}/keys                administrator-only agent identity management
```

A test walks `src/app/api/v1` and asserts every route on disk appears in the spec, so the
docs cannot fall behind the surface — which they had, by six routes, before that existed.

Authenticate with `Authorization: Bearer sk_live_…`. Keys are stored as a sha256 hash: the
plaintext is shown once, at creation, and never again. Issue **one key per agent**, so
writes are attributable and any single agent can be revoked without disturbing the others.
This is not a convention — the key is the only thing that says who is writing, so agents
sharing one are indistinguishable in every count and every history afterwards.

Every response is enveloped: `{"success":true,"data":…}` or
`{"success":false,"error":"…","code":"…"}`.

Every response also carries **`x-cairn-version`**, the release that served it, and
**`x-cairn-cli`**, a 16-hex content hash of the `cli/cairn.mjs` that deployment was built
from — on success and failure alike. `cairn --version` already compared the versions, but
that is the one command an agent has no reason to run, so a copied CLI that has drifted
goes on working, just not the way the docs say. Putting both on the ordinary path means
the CLI notices on the next call it makes: it compares once per process and warns on
**stderr**, never stdout, because callers parse stdout.

The hash is there because the version is a coarse clock. Releases are cut by hand and 133
commits fitted inside v0.5.1, so nearly all real drift is *intra*-version and a check
comparing release numbers cannot see it — which is exactly the state a laptop copy was
found in, two features behind while both sides reported 0.5.1. A content hash is also the
only identifier a copied CLI can compute about itself: there is no repository behind
`~/.local/bin/cairn`, but a file can always read itself. It is the same digest
`scripts/sync-agent-files.mjs` prints, so the installer's log line and the server's header
are the same string for the same file. If the server sends neither header, the CLI says
nothing: the check is an improvement on silence, never a dependency.

The warning says **which side is newer** when anything can tell. Releases compare as
numbers. Within a release the image records when it was built, in **`x-cairn-built-at`**,
and the CLI compares that with its own file's mtime, which is when the sync wrote it. That
matters because drift runs both ways: a server's sync pulls `main` on its own clock, so for
a few minutes after a merge its CLI is ahead of its own deploy, and telling it to update
was advice to fetch the file it already had. When the CLI is behind, the warning prints
the exact command that updates this machine: the scheduled job if there is one, the sync
script otherwise. When nothing can order the two, it says only that they differ.

Requests also carry **`x-cairn-host`**, the machine's hostname (`CAIRN_HOST` overrides
it). Key names are per runtime, not per machine, so a laptop and a server write the same
actor string. The actor is left alone, because it is what the whole history joins on, and
the host is recorded beside it in each activity event's `data`. It is self-reported: a
diagnostic, never an authorization input.

## Keyboard

| | |
|---|---|
| `⌘K` | Search and jump |
| `C` | New task |
| `/` | Focus the list filter |
| `1` `2` `3` `4` | Active · Backlog · All · Recent |
| `?` | Every shortcut |
| `Esc` | Close, or leave a field |

## Self-hosting

Requires Node 22+, Docker, and PostgreSQL 17+.

```bash
git clone https://github.com/<you>/cairn.git && cd cairn
cp .env.example .env.local        # fill in the private PostgreSQL URL and signing key
npm install
npm run db:migrate                # applies migrations/*.sql in order
npm run dev
```

To deploy behind a reverse proxy:

```bash
cp docker-compose.example.yml docker-compose.yml
# set CAIRN_DOMAIN and CAIRN_PROXY_NETWORK in your environment

# The attachments directory is the one thing the container writes to, and it
# runs as uid 1001. Create it owned by that uid before the first start, or
# `cairn attach` fails with EACCES the first time someone uses it — the app
# starts, serves, and reports healthy regardless.
sudo mkdir -p /srv/cairn/attachments
sudo chown -R 1001:1001 /srv/cairn/attachments

docker compose up -d --build
```

The example assumes a Traefik instance already running on an external Docker network with
a Let's Encrypt resolver; adapt the labels for nginx or Caddy. The container runs
read-only, as a non-root user, with all capabilities dropped — which is why the bind mount
above has to be writable by that user rather than by root.

### The first administrator

There is no public sign-up page. Bootstrap the first administrator after migrating:

```bash
CAIRN_OPERATOR_EMAIL=you@example.com \
CAIRN_OPERATOR_PASSWORD='a-long-password' \
npm run operator:create
```

Then add members and issue per-user agent keys from **Users**. All active identities share
the workspace; administrator privileges are required only for membership, roles, password
resets and key management.

### Secrets

`.env*` is gitignored except `.env.example`, and `docker-compose.override.yml` /
`docker-compose.prod.yml` are gitignored so host-specific configuration stays out of the
repository. Keep `DATABASE_URL` and `CAIRN_ATTACHMENT_SIGNING_KEY` server-side only.

## Agent setup

```bash
# credentials — or export CAIRN_BASE_URL / CAIRN_API_KEY
mkdir -p ~/.cairn && cat > ~/.cairn/env <<'ENV'
CAIRN_BASE_URL=https://cairn.example.com
CAIRN_API_KEY=sk_live_...
ENV
chmod 600 ~/.cairn/env

install -m 755 cli/cairn.mjs /usr/local/bin/cairn
```

**One key per runtime, where a machine runs more than one.** The key *is* the identity —
`actor_id` comes from the key, never from what the caller claims — so a single key shared
by Claude Code, Codex, OpenClaw and Hermes Agent by Nous Research files all of their work
under one name, and no agent can be held to its own behaviour. Add a key per runtime and the
CLI picks the right one:

```bash
CAIRN_API_KEY=sk_live_...              # the fallback, when nothing else matches
CAIRN_API_KEY_CODEX=sk_live_...
CAIRN_API_KEY_CLAUDE_CODE=sk_live_...
CAIRN_API_KEY_HERMES=sk_live_...        # Hermes Agent by Nous Research
```

It works out which runtime it is in from the environment, in this order, and
`CAIRN_AGENT=<name>` says so explicitly when that is not enough:

| | |
|---|---|
| Claude Code | `CLAUDECODE=1`, or `CLAUDE_CODE_ENTRYPOINT` |
| OpenClaw | a `CODEX_HOME` with `openclaw` in it, or **any** `OPENCLAW_*` variable |
| Codex | `CODEX_HOME`, `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CODEX_MANAGED_BY_NPM`, `CODEX_MANAGED_PACKAGE_ROOT` |

**The order is the point.** OpenClaw *is* Codex with a `CODEX_HOME` of its own, so it sets
every Codex marker; testing for Codex first would file all of OpenClaw's work as Codex —
the same misattribution, pointing the other way.

Detection used to rest on `CODEX_HOME` alone, which Codex reads but does not export, so
[`scripts/codex-wrapper.sh`](./scripts/codex-wrapper.sh) was installed to set it. A live
session was then found running with the wrapper bypassed and no `CODEX_HOME` at all:
detection returned nothing, the CLI fell back to the machine's default key, and every
Codex write was filed as whichever agent owned that key. Hence the `CODEX_MANAGED_*`
markers, which Codex does export. The wrapper still helps; nothing depends on it.

**Nesting is settled by the process tree, not the environment.** A Codex started from a
Claude Code shell inherits `CLAUDECODE=1`, so by environment alone every write it made was
filed as claude-code. When Claude Code's marker and a Codex marker are both present, the CLI
walks up its parent processes and takes the nearest one named `codex` or `claude`. If `ps`
cannot answer, the old order stands. Nothing is spawned when the environment is unambiguous.

The CLI is deliberately dependency-free — Node 22's built-in `fetch` is enough — so it can
be dropped onto a box and run with no install step.

**Skill** (Claude Code, Codex and OpenClaw all read skill folders):

```bash
cp -r skills/cairn ~/.claude/skills/     # Claude Code
cp -r skills/cairn ~/.codex/skills/      # Codex
cp -r skills/cairn "$CLAWD_HOME"/skills/ # OpenClaw — its own tree, not a dotfile dir
```

**Hooks** — the two mechanisms above:

```bash
node scripts/install-hooks.mjs        # --dry-run to see what it would write
# For a classified local router instead of a global `cairn` executable:
CAIRN_HOOK_CLI=/absolute/path/to/cairn-router node scripts/install-hooks.mjs
```

It is idempotent: every entry it writes is tagged, so re-running after an upgrade replaces
its own and touches nobody else's. Coverage differs by runtime:

| Runtime | Session start | Session recorded |
|---|---|---|
| Claude Code | `SessionStart` | `SessionEnd` **and** `PreCompact` |
| Codex | `SessionStart` | `Stop` — there is no `SessionEnd` |
| Hermes Agent by Nous Research | `pre_llm_call` on the first turn only | — session recording is deliberately not installed |
| OpenClaw | manual — push `cairn context` output into the existing `agent:bootstrap` hook | swept from disk on a schedule — it has no session event of any kind |

On Codex the installer also lists every hook in `hooks.json` that is not Cairn's, and marks
the ones on `Stop`: Codex has no `SessionEnd`, so a session-end script written for Claude
Code runs after **every turn** there, and one that makes a model call bills once per turn.
It only says so. Removing another tool's hook is that tool's decision.

Hermes Agent by Nous Research **v0.21.3 or newer** requires hook consent on first use. The installer
uses `hermes config get hooks --json` and `hermes config set --force hooks <json>` to preserve existing
hooks and **never** auto-approves one; unattended environments must explicitly opt in through Hermes's
own hook policy. If an installed Hermes Agent cannot provide those commands, the installer exits with
an actionable error instead of claiming the runtime was merely skipped. Its `on_session_start` event
cannot inject context, so the installer uses `pre_llm_call` and the Cairn hook emits a briefing only
when `extra.is_first_turn` (or the compatible top-level `is_first_turn`) is true. It intentionally does
not record transcripts or sessions.

**Why Claude Code needs `PreCompact` as well as `SessionEnd`.** A session is recorded when
it ends, and a session that runs for days does not end — it compacts. On the machine this
was found on, four transcripts had been open since the same morning, one of them 39 MB,
and the last session recorded from that host was the minute those four began, 54 hours
earlier. Nothing was broken: the hooks fired, the key authenticated, the parser worked on
a real transcript. The trigger never came. Compaction is the event that is guaranteed to
happen to a session too long to end, because it is what happens *instead* of ending.

Codex hook entries must also be trusted in `~/.codex/config.toml` before they run; the
installer prints what to add.

**How a session gets written up.** The session-end hook records what a session touched by
itself, but the prose on a session row — what was asked, what was learned, what landed,
what is next — is written by a model. The hook pipes up to 24 KB of transcript to
`claude -p` and parses the JSON that comes back. So a session row has prose only where
Claude Code is installed **and logged in as the identity running the hook**.

```bash
CAIRN_SUMMARY_CLI=claude                            # or a wrapper, see below
CAIRN_SUMMARY_MODEL=claude-haiku-4-5-20251001
CAIRN_SUMMARY_TIMEOUT_MS=60000
CAIRN_SUMMARY_MIN_INTERVAL_MS=600000                # see below
```

**How often that call happens.** Not once per session, because not every runtime has a
session-end event to hang it on. Claude Code records at `SessionEnd` *and* `PreCompact`,
and Codex has no `SessionEnd` at all so it records on `Stop` — the end of every assistant
turn. Left alone that is one model call per turn.

So the hook reuses the last summary it wrote for a session when the digest is byte-for-byte
what it already summarised, or when the previous call was under
`CAIRN_SUMMARY_MIN_INTERVAL_MS` ago. The deterministic half — files, task refs, counts — is
written fresh every time regardless; only the prose is reused, and reused rather than
omitted, so a row never loses prose it already had. The stamps live in
`~/.cairn/summaries.json`, fifty sessions deep. Set the interval to `0` to summarise every
time.

The hook keeps the row when the summariser cannot be reached, because losing the record of
a session over a missing summary would be the worse trade. The cost of that choice is that
the failure is silent: rows keep appearing, with their files and task refs and no prose,
and nothing says why. It is worth checking once that a session you know about has prose —
`cairn session list` — rather than assuming. `cairn vitals` reports it daily.

Two cases where the summariser needs help:

- **The transcripts are root's and the login is not.** A swept runtime whose sessions live
  under a `0700` home has to be swept as root, and `claude -p` as root is not logged in.
  Point `CAIRN_SUMMARY_CLI` at a wrapper that drops to the account that is:
  `sudo -n -u <user> -H env HOME=/home/<user> claude "$@"`.
- **The summariser is itself a Claude Code session.** It would trigger the hook again, so
  the hook sets `CAIRN_SUMMARISER=1` in the child and exits immediately when it sees it.
  Anything wrapping the summariser must pass that through.

**When a runtime has no session-end event**, nothing hands the transcript over, so sweep
instead of waiting:

```bash
node ~/.cairn/hooks/cairn-session-end.mjs --scan <sessions dir> --window-hours 2
node ~/.cairn/hooks/cairn-session-end.mjs --dry-run <transcript>   # parse it, write nothing
```

`--dry-run` is the thing to reach for when a runtime is recording nothing: it prints what
would be written from one transcript, which separates "the hook never ran" from "the hook
ran and understood nothing".

**What the CLI keeps on disk.** All under `~/.cairn/`, none of it precious except `env`:

| | |
|---|---|
| `env` | credentials, `0600` |
| `acted.jsonl` | a breadcrumb per accepted write, which is how a session knows which tasks it touched on a runtime whose session names the CLI cannot see |
| `outbox.jsonl` | notes, comments and checkpoints made while the server was unreachable, replayed later; `outbox.jsonl.rejected` keeps what the server refused rather than discarding it |
| `projects.json` | directory → project key, from `cairn map` |
| `ownership/` | which tasks this machine holds |
| `recorded-rollouts` | which swept transcripts have already been turned into sessions, so a sweep on a timer is idempotent |
| `hooks/`, `maintenance/` | where the installers put the copies they manage |

**MCP** (optional — native tool-calling for Claude Code and Codex; OpenClaw reaches it
through `mcporter`). The server lives in [`mcp/`](./mcp), holds no logic of its own, and
exposes 20 of the CLI's verbs as typed tools — `context`, `next`, `history` and the session
verbs stay CLI-only.

Unlike the CLI it is not dependency-free: it imports the MCP SDK and needs a `node_modules`
beside it, so it is installed rather than copied.

```bash
node scripts/install-mcp.mjs              # print what it would do, change nothing
sudo -E node scripts/install-mcp.mjs --install
sudo node scripts/install-mcp.mjs --remove
```

It installs into `CAIRN_MCP_DIR` (default `/opt/cairn-mcp`), writes the `cairn-mcp` wrapper
to `CAIRN_MCP_BIN` (default `/usr/local/bin/cairn-mcp`), and then **checks that an account
other than the installer's can traverse and read what it wrote**. That check is the reason
the script exists: point a wrapper at a checkout under a `0700` home and every runtime that
is not root gets `MODULE_NOT_FOUND`, which from inside an agent is indistinguishable from a
server that was never registered.

Then register it. Claude Code:

```bash
claude mcp add cairn -- cairn-mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.cairn]
command = "cairn-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Codex rejects a literal `bearer_token`; for an HTTP transport it wants
`bearer_token_env_var`.

**Existing memory.** If you already keep curated agent memory as one markdown file per
fact, `node scripts/import-memory-files.mjs --dry-run` shows what it would bring in as
knowledge. It reads `~/.claude/projects/*/memory/` unless `--root` says otherwise, and
needs `--map <file>` — JSON of `{ "<directory>": "KEY" | null }` — to know which project
each directory belongs to. Anything unmapped is refused rather than filed globally, since
knowledge in the wrong scope is read by every project that should not see it; `--global`
says you meant it.

### Integrating a runtime that is not listed above

The three above are the ones this is used with. Nothing here is specific to them, and a
fourth runtime is mostly a question of which of these it gives you.

**A skill folder and a CLI on PATH is the whole minimum.** Every interface here shells out
to the same binary, so a runtime that can run a shell command and read a markdown file is
already integrated. The hooks, the MCP facade and the rest are how it gets better, not how
it starts.

**One key per runtime, always.** `actor_id` comes from the key, never from what the caller
claims to be, so a key shared between two runtimes files their work under one name and
neither can be held to its own behaviour. This is the only item on this list that is not
optional.

**Test for the wrapping runtime before the wrapped one.** A runtime built on top of
another sets everything the inner one sets. Detection that checks the inner first
attributes all of the outer's work to it — the same misattribution as a shared key, just
harder to see. Ordering is the fix, and it is worth a test, because nothing about the
symptom points at it.

**No session-end event is normal.** Plenty of runtimes have no way to tell you a session
finished. Sweep what they leave behind on a timer instead — `--scan`, above — and make the
write idempotent so a sweep that overlaps itself costs nothing. A ledger of what has
already been recorded is enough.

**No hook surface does not mean no integration path.** A runtime driven by a system prompt
can be told to use the CLI in that prompt; one with a bootstrap step can have the briefing
pushed into it. Both reach the same place as a session-start hook by a different road, and
neither leaves a trace in any hooks file — so an audit that looks only for hooks will
report an integration that works as absent.

**Whatever writes the session prose may not be able to run as the account doing the
sweep.** Transcripts under a `0700` home have to be read by root; a summariser CLI is
usually logged in as somebody else. Point `CAIRN_SUMMARY_CLI` at a wrapper that drops
privilege rather than moving the transcripts.

**A copy in a directory nothing reads is worse than no copy.** Agent-facing files live in
a directory per runtime and drift silently. Repair copies where a runtime already lives;
never install one because a plausible directory exists.

## Scheduled maintenance — optional

Cairn works with none of these. They are the difference between a tracker that notices its
own problems and one that waits to be asked, and each is independent: install none, some,
or all.

```bash
node scripts/install-cron.mjs              # print what would be installed, change nothing
node scripts/install-cron.mjs --install    # install it
node scripts/install-cron.mjs --only vitals --install
node scripts/install-cron.mjs --remove
```

**cron on Linux, launchd on macOS**, chosen by platform and overridable with `--cron` or
`--launchd`. The jobs are defined once — a schedule, an environment and a command — and
each backend renders that, so the two cannot drift apart. macOS gets LaunchAgents in
`~/Library/LaunchAgents` rather than a crontab: cron still exists there but is deprecated
and runs outside the user session, where a job cannot reach a per-user PATH and nobody is
present to answer a privacy prompt.

Printing is the default on purpose. On Linux the lines live between two markers and the
installer only ever touches what is between them, so it can be re-run without duplicating
and without disturbing anything else in the crontab — it backs the whole thing up first
regardless. On macOS each job is its own agent, torn down before being rewritten, because
launchd does not notice a plist that changed underneath a loaded agent.

Any job whose prerequisites are missing on that machine is skipped rather than installed
broken, and `--install` places the maintenance script itself if it is not there yet.

A laptop has no deploy to trigger its sync, and it sleeps through slots, so under launchd
`agent-files` runs every 15 minutes and at load. launchd runs a slot that was missed during
sleep as soon as the machine wakes, which is usually before the network is up, so the sync
retries a network failure for about a minute and a half before it gives up. The job runs as
`CAIRN_AGENT=maintenance`, and that identity refuses to fall back to another runtime's key:
give the machine a `CAIRN_API_KEY_MAINTENANCE`, or its reports are refused. The sync warns
about a missing key on every run.

Install only what that machine is for. A laptop beside a server usually wants
`--only agent-files`: `reconcile` and `vitals` are about the instance rather than the
machine, and running `vitals` in two places reports the same findings twice.

| Job | What it is for |
|---|---|
| `reconcile` (30 min) | Releases a claim an agent stopped working on, and moves the task back to todo so `doing` keeps meaning somebody is on it |
| `vitals` (daily) | Asks whether the memory is still being written and read, and reports **only** when something looks wrong |
| `agent-files` (hourly on Linux, and on every deploy; on macOS every 15 minutes and at load) | Repairs the skill, CLI and hooks wherever a runtime is reading a stale copy |
| `openclaw-sessions` (30 min) | OpenClaw has no session-end event, so its transcripts are swept instead of waiting to be handed over |

Host-specific paths come from the environment, because a machine's layout does not belong
in this repository: `CAIRN_CLI_PATH`, `CAIRN_NODE_PATH`, `CAIRN_LOG_DIR`,
`CAIRN_SYNC_SCRIPT`, `CAIRN_RAW_BASE`, `CAIRN_HOOKS_DIR`, `CAIRN_OPENCLAW_SESSIONS`,
`CAIRN_SUMMARY_CLI` for a sweep that has to reach a summariser it cannot run as itself, and
`CAIRN_SYNC_ALSO` for copies outside the running user's home. The defaults describe the
machine rather than one host: on macOS the CLI is looked for in `~/.local/bin`, logs go to
`~/Library/Logs`, and node is the one running the installer. `CAIRN_NOTIFY_VITALS` and
`CAIRN_NOTIFY_FILES` name a task to report into; leave them unset and the jobs stay quiet.

Run the jobs under an identity of their own: `CAIRN_AGENT=maintenance` with a matching
`CAIRN_API_KEY_MAINTENANCE`. On a machine whose `~/.cairn/env` holds per-runtime keys, the
CLI refuses to send a maintenance write under the default key (exit 3), because that key
belongs to some other agent and a scheduled job's warning is read by nobody.

### Keeping the copies honest

The skill, the CLI and both hooks are read from a directory per runtime, so the same file
exists five or six times on a busy host. They drift silently. The two maintenance scripts
are repaired too, including the one that installs the schedule: a repairer that cannot
repair its own installer leaves exactly one file stale on a host where everything else
matches, which is the state that makes drift look impossible. So is the MCP facade, where
one already exists — it arrives by an installer rather than a copy, which is precisely why
it was missed, and it spent a day a version behind the CLI it is a facade of.

```bash
node scripts/sync-agent-files.mjs --check   # report drift, write nothing
node scripts/sync-agent-files.mjs           # repair every reachable copy
```

`--source <url>` takes the canonical files from the repository rather than a checkout,
which is what lets it run on a host that has none. A CLI is only ever updated where one is
already installed — `/usr/local/bin` existing is not consent to install into it.

The built-in targets are the running user's own `~/.claude`, `~/.codex` and `~/.cairn`.
Every other copy is named with `--also <artefact>=<path>`, repeatable — another user's
home, when the schedule runs as root and the runtimes do not, or a runtime that keeps its
skills in a tree of its own. `CAIRN_SYNC_ALSO` renders those into the scheduled job, so
which copies a machine has stays with that machine.

### Running the repair on merge, not only on the hour

An hourly repair against a deploy that happens on merge is two clocks, and the slower one
is the one agents read from. Measured: merged at 16:14 with the previous sync at 15:23, so
for 51 minutes every agent on every machine read a `SKILL.md` that contradicted the code
already live — up to 59 minutes in general, and on the day it was measured the contradicted
sentence was the one that merge had just fixed.

So the deploy asks for the job the moment it is finished:

```bash
node scripts/install-cron.mjs --run agent-files                       # exactly as scheduled
node scripts/install-cron.mjs --run agent-files --source . --no-notify   # as a deploy runs it
```

`--run` reads the command back out of the installed schedule — the managed crontab block on
Linux, the LaunchAgent on macOS — rather than rendering it again. Which copies a machine has
is a fact about that machine and already lives in the line the installer wrote; restating
that list in a workflow file would be the next thing to drift. If the job is not installed
`--run` refuses rather than inventing one, because a job invented on a host that was never
configured reaches none of the copies the real one reaches, and reports success for it.

Two overrides, and deliberately only two. `--source` because a deploy has the tree it just
deployed sitting on disk, which beats the schedule's `raw.githubusercontent.com` URL: that
is CDN-cached, so a fetch seconds after a merge can be handed the previous `main` and write
it back as current. `--no-notify` because a repair is the *expected* outcome of this path —
the schedule's note means "a runtime was reading a stale copy until now", and one of those
per merge would bury the notes that mean something.

**The hourly job stays.** It is the fallback for a machine that was powered off, a host the
deploy cannot reach, and a merge that for any reason never got there. It is a trigger added,
not a schedule replaced — and its notes now say something sharper than before, because a
repair on the hourly path means the trigger did not arrive.

Cairn's own deploy runs on a self-hosted runner on the box those copies live on, so the
trigger is a step in the deploy job rather than a webhook: nothing inbound, no secret in
transit. The step cannot fail the deploy — a stale skill is a problem, a failed deploy is a
bigger one — so every outcome is a warning and the run continues. The sync writes into other
users' homes, so it goes through `sudo`, which needs one sudoers line naming that exact
command:

```
<runner-user> ALL=(root) NOPASSWD: /usr/bin/node /opt/cairn-maintenance/install-cron.mjs --run agent-files --source <workspace> --no-notify
```

`<runner-user>` is the account in `CAIRN_RUNNER_USER`, and `<workspace>` is that runner's
`$GITHUB_WORKSPACE`, which the deploy log prints and which does not change between runs.
Pinned whole rather than with a wildcard: `--source` tells root which tree to copy files out
of, and a wildcard there would grant "write any content you like into every agent's skill".
Without the entry the step warns and the hourly job covers it — which is also what happens
on a host that deploys some other way, or does not run the schedule at all.

## Self-hosted runner — optional

Only relevant if you deploy Cairn onto the same machine a GitHub Actions runner lives on.
Nothing here is required: a hosted runner, or deploying by hand, works fine.

```bash
node scripts/install-runner-service.mjs          # print the unit, change nothing
sudo -E CAIRN_RUNNER_DIR=/path/to/actions-runner \
  node scripts/install-runner-service.mjs --install
sudo node scripts/install-runner-service.mjs --remove
```

Printing is the default, for the same reason it is elsewhere: a script that writes into
`/etc/systemd/system` the moment it runs is a script nobody should run. Host-specific
values come from `CAIRN_RUNNER_DIR`, `CAIRN_RUNNER_USER` and `CAIRN_RUNNER_SERVICE`, so a
machine's layout stays out of the repository. `sudo -E` matters — plain `sudo` drops those.

**The unit sets `KillMode=control-group`, and that is the point of the file.** GitHub's
documented unit uses `KillMode=process`, which signals only the main process on stop so a
job in flight can finish. The cost is that `systemctl stop` returns while `run-helper.sh`
and `Runner.Listener` are still alive, orphaned in the cgroup — systemd reports it as
`Found left-over process <pid> (Runner.Listener) in control group while starting unit`.
With `Restart=always`, every restart then adds a listener rather than replacing one. Since
GitHub permits one session per registered runner, the extras loop forever on `A session for
this runner already exists` while sharing a single `_diag` and `_work`, and jobs begin
failing in checkout on collided files and ending as `Abandoned` — a symptom that points
nowhere near the cause.

The trade-off is real and worth taking: a job interrupted by an explicit `systemctl stop`
can be re-run, whereas a runner quietly accumulating listeners announces nothing.
`TimeoutStopSec` still lets the tree exit on its own before systemd escalates.

If a unit already exists that this installer did not write, it writes a drop-in overriding
`KillMode` alone and leaves the rest of that unit untouched. `KillMode` is read at stop
time, so applying it needs only a `daemon-reload` — the runner does not have to be
restarted, and restarting it would interrupt any job in flight.

## Architecture

- **Next.js 16** (App Router) · React 19 · TypeScript · Tailwind v4
- **PostgreSQL 17+** over the native protocol; local filesystem storage for attachments
- **Auth**: opaque, revocable application sessions for the UI; hashed
  bearer API keys for agents, one key per agent
- **Authorization**: active users and valid agent keys share workspace data; human
  administrators alone manage users, roles, passwords and agent keys. PostgreSQL is
  reachable only from the private application network.

**The data model**, in five groups: `projects` / `tasks` / `task_notes` / `task_comments`
/ `task_attachments` / `task_deps` / `task_activity_events` for the tracker;
`knowledge` + `knowledge_projects` + `knowledge_entities` for what we know; `sessions` and
`file_touches` for what happened and where; `entities` + `project_entities` for the
groupings that sit between one project and everything; and `search_events` +
`knowledge_reads` for whether any of it is read back. Those last two are the only record of
*recall* rather than volume: `search_events` keeps the query text, whether the search
widened, and — since `returned_slugs` — which entries actually came back; `knowledge_reads`
records every direct read by slug with a `hit` flag, and `false` is the row worth having,
because it says the memory was asked for a named fact and did not have it.

The migrations are the best description of it — each one is commented with *why*, not
what. [`001_initial.sql`](./migrations/001_initial.sql) is the tracker;
[`013_knowledge.sql`](./migrations/013_knowledge.sql) onward is the memory layer.

## Backups

Cairn holds real work, so back up **both** halves — a database dump without the storage
tree loses every attachment, and the storage tree without the dump loses every reference
to those files.

```bash
export CAIRN_BACKUP_DIR=/srv/backups/cairn
export CAIRN_DB_CONTAINER=cairn-postgres
export CAIRN_DB_USER=postgres            # the role pg_dump connects as
export CAIRN_ATTACHMENT_DIR=/srv/cairn/attachments

./scripts/backup.sh          # nightly, from cron — 7 daily, 4 weekly
./scripts/restore-drill.sh   # weekly — actually restores and verifies
```

`CAIRN_DB_USER` defaults to `postgres`, which is not the role `.env.example` gives you —
that is `cairn_app`. The default is kept for the deployments already running on it, and a
backup that stops working is the worst thing to break quietly, so set this to whatever role
actually owns your database. Reported by [jgiffard](https://github.com/jgiffard), who found
it by reading the script rather than by losing a backup.

`restore-drill.sh` restores the newest dump into a throwaway database, asserts the data is
really there — including that the generated `search_vector` survived, which would otherwise
break prior-work discovery silently while everything else looked fine — then drops it. An
untested backup is not a backup.

## Contributing

Cairn is a personal tool published in the open; issues and PRs are welcome, but the
maintainer's own use drives the roadmap. If you are thinking of something large, open an
issue before building it — not to gatekeep, but because this is a small codebase with
strong opinions and it would be a shame to waste your evening.

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — the traps worth knowing before you change
  something: Zod's `.partial()` and defaults, IMMUTABLE generated columns, the markdown
  round-trip in the editor, and how releases are cut.
- [`CHANGELOG.md`](./CHANGELOG.md) — what changed, and what breaks.
- [`SECURITY.md`](./SECURITY.md) — the threat model, and how to report a vulnerability
  privately.
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — short, and the usual.

One habit worth borrowing if you send a patch: the comments here explain **why**, not
what. The code says what it does; the comment exists for the next person who wonders why
it does it that way, and half of them are a bug someone already paid for.

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run db:migrate && npm run test:integration   # needs a real PostgreSQL
```

CI runs every one of those, the integration suite in a job of its own because it migrates a
clean database first — see [`CONTRIBUTING.md`](./CONTRIBUTING.md#before-opening-a-pr). The
domain vocabulary lives in
[`src/schemas/task.ts`](./src/schemas/task.ts) — types, statuses, priorities, note kinds
and resolution kinds are defined there once and flow into the API, the OpenAPI document,
the CLI and the UI.

## Thanks

Cairn is a personal tool, so every contribution from outside it is worth naming.

- **[@webcoder31](https://github.com/webcoder31)** — found that project identity was keyed
  on a filesystem path, so the briefing went silent in a `git worktree` or a second clone,
  and sent the fix ([#2](https://github.com/montytorr/cairn/issues/2),
  [#3](https://github.com/montytorr/cairn/pull/3)); that a key rename orphaned every task
  ref already written into commits and notes
  ([#4](https://github.com/montytorr/cairn/issues/4)); and that `next dev` was quietly
  eating the agent guide's byte budget
  ([#1](https://github.com/montytorr/cairn/issues/1)).

A report that leads to a fix is credited here the same way a patch is. Finding the problem
is most of the work — all three of the above were invisible from the inside, because the
machine that wrote the code had already been set up in a way that hid them.

## Licence

[Sustainable Use License](./LICENSE) — the licence n8n publishes, for the reason they
publish it. Read the source, run it yourself for your own business or personally, modify
it, fork it, share your changes. The one thing it does not permit is selling Cairn itself
as a service.

Releases up to and including v0.5.1 were MIT and stay MIT for anyone who has them; a
licence change is not retroactive. [`LICENSE-MIT-HISTORY`](./LICENSE-MIT-HISTORY) says
exactly what moved and what did not.
