# Cairn

[![CI](https://github.com/montytorr/cairn/actions/workflows/ci.yml/badge.svg)](https://github.com/montytorr/cairn/actions/workflows/ci.yml)
[![Licence: Sustainable Use](https://img.shields.io/badge/licence-Sustainable%20Use-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/github/v/release/montytorr/cairn?label=version)](./CHANGELOG.md)

**The tracker your agents read before they start, and write to as they work.**

They check it for prior work, claim what they take, record what they tried — including
what failed — and close nothing without saying how. Six weeks later a different agent
asks the same question and gets the answer instead of repeating the work.

Self-hosted. A cairn is a stack of stones travellers leave to mark a path for whoever
comes next: a different agent, a different model, you in six weeks.

Two hooks make it happen without anyone being reminded: a briefing when a session starts,
and the session written down when it ends.

> **One shared workspace.** Every active user and agent can work across the same projects,
> tasks and memory. Administrators manage membership and roles; each person pairs their own
> agents' keys and can revoke them on **Your agent keys**, and administrators can issue or
> revoke anyone's. Owner columns remain
> attribution metadata rather than visibility boundaries. Every task is **assigned
> to a person** — by default the human behind the agent's key that filed it — who owns it,
> while the agent's claim only says who is executing it right now.
>
> Separate data — a personal and a work Cairn, say — means separate instances, and one
> machine can use several ([below](#several-instances-on-one-machine)).
>
> **Pre-1.0.** Stable in practice and running in production, but a minor version may still
> change the schema or the API. Anything that breaks an existing install is called out in
> the [changelog](./CHANGELOG.md).

**Jump to:** [Self-hosting](#self-hosting) · [Connect a machine](#connect-a-machine) · [The CLI](#the-cli) ·
[Several instances](#several-instances-on-one-machine) · [API](#api) ·
[Scheduled maintenance](#scheduled-maintenance--optional) · [Architecture](#architecture) ·
[Contributing](#contributing)

Deploy the server once ([Self-hosting](#self-hosting)); then each machine that runs agents
connects with one command, which pairs its keys in your browser and installs the CLI, skill
and hooks:

```bash
curl -fsSL https://raw.githubusercontent.com/montytorr/cairn/main/install.sh | sh -s -- --url https://your-cairn
```

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

Nothing. So file it, with a body — a bug or a spike without one is refused. `add` probes
for near-duplicates before it creates anything, ORing the distinctive words rather than
ANDing the phrase, so it surfaces things `check` rightly did not. From an agent it also
claims the task, so a second agent on the same backlog picks something else:

```console
$ cairn add "Migrations time out when workers run in parallel" --project ACME --type bug --body -
similar existing work:
  ACME-12 [done] Make the migration runner idempotent
claimed ACME-57 (agents' adds start the work; --no-start to only file it)
id	9f3c1a04-2b77-4a0e-8d51-6e0c2f1b9a44
number	57
title	Migrations time out when workers run in parallel
type	bug
status	doing
priority	medium
created_at	2026-08-14T14:51:09.223Z
ref	ACME-57
assignee	Alice
claimed_by	claude-code · Alice
```

Alice owns it because it was her agent's key that filed it; `--assignee bob@acme.io` would
have made it Bob's, with Alice's agent still the one on it.

A claim is one conditional UPDATE. If somebody else holds it, `claim` exits **9** and says
who, rather than guessing:

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
assignee	Alice
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
assignee	Alice
createdBy	claude-code · Alice
updatedAt	2026-08-14T16:04:18.551Z
resolution	Raised the pooler's own pool_size to 40; the client-side setting was never the cap.
resolutionKind	fixed
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

This is the part that makes the rest hold. Installed by `cairn setup`, or on its own by
`node scripts/install-hooks.mjs`.

| When | What happens |
|---|---|
| session start | the briefing is injected — what you hold, what is in flight, where the last session in this directory stopped, what is known here |
| session end | the session is recorded, and a task it worked on and still holds is checkpointed — never over a checkpoint the agent wrote |

A third hook, on every file read, cost a process and a request per `Read` and never matched
on Codex, so the installer now removes it wherever it finds it. The hook script still
answers `PreToolUse` if you wire it yourself.

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
| Structure | a human assignee on every task, apart from the agent holding it; sub-tasks, blocked-by / blocks dependencies with cycle rejection, labels, priorities, due dates |
| Bodies | markdown in a WYSIWYG editor — syntax-highlighted code, GFM tables and task lists; bare refs like `ACME-42` become links. An agent's body has to read as markdown: a wall of text is refused, with what to fix |
| Trails | comments for humans, an append-only work log for agents, file attachments, and a full activity history |
| Views | list and board per project, a cross-project board at `/board` grouped and swim-laned by status, priority, type, project, agent or assignee, bulk edit with shift-click ranges, a cross-project home, a map of the knowledge corpus at `/knowledge/graph`, live updates over SSE |
| Multi-project tasks | a task can belong to several projects at once — the home project keeps the ref, the extra links only widen where it appears |

**Memory**

- Postgres full-text search across all four stores in one pass.
- Two arms, both always run, merged. The precise arm returns rows carrying at least half
  the distinctive terms of the question; the wide arm returns everything matching any of
  them; a row found by both appears once, in the precise head. Each row says which arm
  found it, because twenty loose word-overlaps silently read as prior work.
- The wide arm used to run only when the precise one came back thin, so a few long rows
  containing every word of a question could switch off the arm that answered it. Running
  both lifted English recall@20 on the evaluation set from **0.43 to 0.86**
  ([`055`](./migrations/055_search_stop_suppressing_the_fallback.sql) for `search_all`,
  [`056`](./migrations/056_search_tasks_stop_suppressing_the_fallback.sql) for
  `search_tasks`, the task-only path the web UI and `cairn check --tasks` take).
- Ranking happens in the database, by `ts_rank`. Closed work is included on purpose, and a
  row carrying a recorded answer outranks one that merely mentions the subject. Every rule
  here came out of measurement rather than taste, and so did the rejections: ranking by
  term coverage first tested worse (87% → 81%) and was reverted, and re-sorting in the
  application dropped recall from 75% to 6%. The reasoning is written into
  [`004_search_ranked.sql`](./migrations/004_search_ranked.sql) and
  [`016_search_all.sql`](./migrations/016_search_all.sql).
- The evaluation set is [`tests/fixtures/search-eval.json`](./tests/fixtures/search-eval.json):
  22 paraphrased questions with their known-good answers, each pinning the invocation it is
  scored under, because `--project` and `--kinds` reorder the same store.
  `node scripts/score-search-eval.mjs` scores it and records what the numbers were measured
  against — the server build, the CLI version, the size of the store — because a growing
  store moves the score with no code change.
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
  A reference to a superseded entry is accepted with a warning naming its successor. An
  edit is checked only for the references it adds, so a typo fix is never refused over one
  the entry already carried. And a hard delete (`cairn unlearn` with no successor) is
  refused while live entries still reference the entry, naming them — supersede it
  instead, fix the referrers, or pass `--allow-dangling` to delete anyway.
- **A map of the corpus** at `/knowledge/graph`, and the same findings without a screen
  through `cairn know --gaps`. It answers the question a list cannot: what is connected to
  *nothing*. Here that was a quarter of the entries, nineteen separate islands, and dozens
  of references pointing at entries nobody ever wrote — none of it visible anywhere before,
  because a list shows what is there.
- **A file index** answers the question nobody asks: `cairn context --file <path>` returns
  the tasks and knowledge that concern a file, with no query to write. `learn --files`
  names the files a fact is about beyond those its body mentions.
- **Knowledge has a history.** Every correction keeps the version it replaced
  (`cairn know <slug> --history`), and `cairn know --unused` finds facts no search or read
  has returned lately.
- **Refs link themselves.** A task ref written in a note, comment, description or
  resolution shows up on that task's `show` under `mentionedIn`, decisions and findings
  first.
- **Credentials are refused on the way in.** A write carrying a secret-shaped string — an
  API key, a token, a password assignment — is rejected with `secret_detected`, because
  everything written here is read back into agents' contexts.

**Coordination**

- A claim / heartbeat / checkpoint protocol so several agents can work one backlog without
  colliding. A lease whose holder has gone quiet for 15 minutes becomes stealable — one
  conditional UPDATE, no lease table. Releasing a claim nobody is on is a separate, slower
  job (two hours; `reconcile`, below).
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
the CLI is that implementation, and the other two shell out to it.

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
| **Connect a machine** | |
| `cairn setup --url <instance>` | Pairs this machine's keys in the browser, installs the CLI, skill, hooks and the `agent-files` job (`--maintenance` adds `reconcile` and `vitals`; setting up OpenClaw adds `openclaw-sessions` where its sessions directory can be found) — [more](#connect-a-machine). `--dry-run` to preview, safe to re-run |
| **Find and read** | |
| `cairn check "<subject>" [--assignee me\|<who>]` | **Start here.** Prior work across all four stores, with a `~tokens` cost per row. `--kinds task,note,knowledge,session` narrows the stores; `--assignee` narrows to that person's tasks |
| `cairn context [--scope project\|all] [--project K]` | The briefing: what you hold, what is in flight (naming the owner when it is not your human), your human's open work here that nobody is on (five, most urgent first, then a count), where the last session here stopped. `--scope project` limits held work, stale claims, and the last session to the resolved project; the default `all` keeps cross-project awareness. An unresolved project is an error in project scope; an unknown explicit key returns 404. |
| `cairn next [--assignee me\|<who>]` | **What to pick up, and why.** Finishing beats starting, so work you hold ranks above work dropped with a checkpoint, which ranks above anything not begun. Blocked, waiting, or actively held by another agent is never offered. Within a tier your human's work comes first; someone else's is still offered, with whose it is in the reason |
| `cairn show <ref>` · `cairn list --project K` · `cairn projects` | Read one (a digest; `--full` for everything), many, or the project index. `list` filters by `--status`, `--type`, `--label`; `--assignee me\|<who>` is what a person owns; `--mine` is what this agent holds right now. `projects --archived` includes retired ones |
| `cairn people` | Who work can be assigned to: name and email |
| `cairn log <ref>` · `cairn history <ref>` | The work log, and what changed when and by whom |
| `cairn recall <ref>` | Picking a task up: the decisions, findings and knowledge that bear on it, each with why it was picked. `claim` prints the top of it |
| **File and change** | |
| `cairn add "<title>" --project K --body -` | File work; a bug or spike needs a body of 40 characters or more (`--force-empty` when the title really is the whole story). From an agent, `add` and `update --body` also refuse a body that would be a wall of text — capitals standing in for headings, one long paragraph, paths and calls outside backticks — and list what to fix. Warns if something similar already exists. From an agent runtime it also claims the task, unless similar open work exists or you already hold a task in that project (it says which); `--no-start` only files it. Assigned to the human behind your key; `--assignee <email\|name\|id>` gives it to someone else |
| `cairn add ... --external-ref KEY --external-url URL` | Record where the task came from in another tool. The ref is unique across the instance, so filing the same one again returns the existing task (`duplicate: true` with `--json`) and claims nothing. `cairn update <ref> --external-ref KEY\|'' --external-url URL\|''` sets or clears it; `cairn show` prints both and `cairn list --project K --external-ref KEY` filters on it exactly |
| `cairn add ... --start` | File it and claim it, always — for a person, or to override the agent default's hold-backs |
| `cairn update <ref> --status S --priority P` | Change fields; `--assignee <who>` reassigns it, `--project` moves it, `--also-project` widens it. `--status in-review` is written but not landed: unmerged, or merged and undeployed |
| `cairn done <ref> --resolution "…"` | Close. The resolution is required; `--duplicate-of <ref>` closes it as a copy of another. `--kind verified` when you closed it because somebody else's fix was already there — `fixed` would claim their work |
| `cairn cancel <ref> --resolution "…"` | Drop it, and say why |
| `cairn children <ref>` · `cairn add … --parent <ref>` | Sub-tasks |
| `cairn deps <ref>` · `cairn blockedby <ref> <other>` · `cairn unblockedby <ref> <other>` | Dependencies |
| `cairn labels [rename\|remove]` | Every label in use; renaming onto an existing label merges them |
| `cairn block <ref> --reason "…"` · `cairn unblock <ref>` | Stuck on something outside Cairn |
| `cairn task delete <ref> --confirm <ref>` | For junk that should never have existed. Refused if the task has children or dependencies, or notes or comments from anyone but you — cancel keeps the record |
| **Work log and evidence** | |
| `cairn note <ref> "…" --kind attempt` | Append to the work log — `note · attempt · finding · decision · handoff` |
| `cairn commit <ref> <sha>` · `cairn push <ref> <sha>` | Record delivery evidence in the task history |
| `cairn run <ref> "<command>" --status passed\|failed\|skipped` | Record a command result in the task history |
| `cairn comment <ref> "…"` | Leave something for the human |
| `cairn attach <ref> <file>` · `cairn files <ref>` | Attachments |
| **Claims** | |
| `cairn claim <ref>` | Take it. **Exit code 9** means another agent holds it |
| `cairn beat <ref>` · `cairn release <ref> [--force]` | Keep a claim alive, or drop it |
| `cairn checkpoint <ref> --summary "…"` | Where work stopped, for whoever resumes |
| **Knowledge** | |
| `cairn learn "<title>" --body -` | Record what we now know. Scoped to this directory's project unless `--project`, `--entity` or `--global`, and refused where there is no project to infer — global is a claim about every project you have, so it is chosen rather than arrived at |
| `cairn know [<slug>\|<query>]` | Read it back, or list what applies here. `--sweep` (or `CAIRN_SWEEP=1`) keeps a scripted read out of the recall counts |
| `cairn know <slug> --history [--full]` · `cairn know --unused [--days N]` | Every version and who changed it; facts nothing has returned lately |
| `cairn know --gaps` · `--orphans` · `--dangling` | Where the memory has holes: entries joined to nothing, and references pointing at entries nobody wrote |
| `cairn relearn <slug> [--reason "…"]` · `cairn unlearn <slug> --superseded-by <slug>` | Correct it, or mark it replaced |
| `cairn relearn <slug> --project K` · `--entity E` · `--global` | Re-scope it. Each flag replaces its own side, and `none` clears one: `--entity E --project none` moves a fact from a project to an entity. `--global` clears both and refuses to be combined with either |
| `cairn verify <slug>` | This fact is still true. Clears the stale mark without rewriting it |
| `--related a,b` (on `learn` and `relearn`) · `cairn link <slug> <other>… [--reason "…"]` | Name the entries it relates to. Appended to the body's trailing `Related: [[a]], [[b]]` line (deduped, case and underscores normalised) and checked like any `[[reference]]`; `link` does it to an existing entry as a versioned edit, and writes nothing when they are already linked. `learn` prints a ready-to-run `cairn link` for the same-subject entries it finds |
| `--allow-dangling` (on `learn` and `relearn`) | Keep a `[[reference]]` the store cannot resolve. A write is otherwise refused when a reference names nothing and a near-named entry exists; the refusal names that slug, so retrying with it is the usual answer, and this flag is for when it gets that wrong |
| `--allow-dangling` (on `unlearn` without `--superseded-by`) | Delete an entry other live entries still `[[reference]]`. The delete is otherwise refused, naming the referrers; superseding it instead keeps their references landing somewhere |
| `cairn entities` · `cairn entities assign\|unassign <key> --project A,B` · `cairn entities rename <key>` | Groupings a fact can be true of |
| **Sessions and upkeep** | |
| `cairn session list` · `cairn session checkpoint\|end --id <id>` | The episodic record; `checkpoint` records progress without ending it |
| `cairn reconcile` | Release claims that went quiet for two hours (`doing` goes back to `todo`): your own, or the whole workspace under the `maintenance` key (the scheduled job) |
| `cairn vitals [--all]` | Is the memory still being written, against the week before, and what looks wrong: claims with no genuine activity past 2h and 24h, whether the reaper released anything in 7 days, sessions and their summarised share per runtime and host, knowledge never verified. `--all` adds whether it is being *read*: searches, how many widened or came back empty, tasks filed without checking first, and each recent `asked for, not held: <slug>`. `--notify <ref>` posts the findings as a note on that task, and stays silent when there are none |
| `cairn --version` | This CLI, the server, and whether they match |
| `cairn replay` | Send writes put aside while the server was unreachable. Rarely needed by hand — any successful write drains the queue; a write another runtime queued waits for that runtime |
| **Projects** | |
| `cairn map <KEY>` | Tell Cairn which project this checkout is. Validates the key, and claims the repository so every other clone and worktree resolves too. `cairn map none` releases both |
| `cairn project create <KEY> "<title>"` · `cairn project rename\|archive\|restore\|delete <KEY>` | Deleting takes every task with it, and demands `--confirm <KEY>` |
| `cairn project rekey <KEY> <NEW>` · `cairn project rename <KEY> --key <NEW>` | Change the key. Every ref is renumbered under the new key, the old refs keep resolving, and the old key cannot be given to another project. Anything reached through a retired key says so — `AC-113 is now HOL-113`, `note: project AC is now HOL` — on stderr, and as `requested_ref` / `renamed_from` in the JSON. `cairn projects` lists former keys in a trailing `was` column |
| **The Lab** (where an administrator has switched it on) | |
| `cairn idea "<title>"` · `cairn ideas` | File an idea (a subject in the first planned stage), and list the planned ones |
| `cairn subject add\|list\|show\|edit\|stage\|note\|notes\|tag\|attach\|files\|todo\|archive\|restore\|delete\|mentions` | A subject (`LAB-12`) is something being explored or proved: a stage, a write-up, a log, tags and a conclusion. `stage … --conclusion -` is required to enter a completed or dropped stage; `todo` files an ordinary task that belongs to it; `show` is a digest (`cairn show LAB-12` goes there too); `delete` needs `--confirm` and refuses while it has todos, and never deletes one |
| `cairn add … --subject LAB-12` · `cairn update <ref> --subject LAB-12\|none` · `cairn list --subject LAB-12` | Link a task to a subject, unlink it, or list a subject's todos across projects |
| `cairn lab` · `cairn lab stages\|tags [add\|edit\|remove\|order]` · `cairn lab on\|off\|home <KEY>` | The settings and the curated stages and tags. Switching it on or off and choosing its home project are a human administrator's; an agent key is refused |
| **Hand-off** | |
| `cairn handoff <ref> [--to <instance>:<KEY>\|github:<owner>/<repo>]` | The work leaves this instance: files it in another configured instance (through that instance's own CLI) or as a GitHub issue (through `gh`), and records the link here with the destination's absolute https URL. `--to` is optional when the project has a hand-off default. From then on the other tracker owns the status, and claiming, closing or moving the task here is refused (`handed_off`). `--link <REF> [--url URL]` records a task made by hand; `--undo` takes it back |
| `cairn project handoff <KEY> [--to <instance>:<KEY>\|github:<owner>/<repo> \| --clear]` | The project's default for `--to`; bare shows it. A Cairn's target is stored as `KEY`, or `<instance>/KEY` (instance names are this machine's own) |
| `cairn sync [--project K] [--all-instances]` | Read every handed-off task's status back; one that ended there is closed here once, with their resolution |
| **Several instances** | |
| `cairn instance [list]` · `cairn instance add <name> --url U [--default] [--adopt]` · `cairn instance policy ask\|default <name>` | Several Cairn instances on one machine: which one a command uses, adding one, and what a directory with no route does ([more](#several-instances-on-one-machine)) |
| `cairn route` · `cairn route add <instance> [--folder\|--session]` · `cairn route list\|pending\|remove` | Which instance this directory belongs to, saving the answer, and the sessions waiting for one |
| `--instance <name>` (any command) · `--all-instances` (`reconcile`, `vitals`, `sync`) | Send this one command to that instance, or run the job once per instance |

`cairn --help` is the full reference.

## API

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 document generated from the same Zod
schemas the routes validate against, so it cannot drift. Browsable at `/api-docs`.

```
/health                         unauthenticated probe; reports the commit it was built from
/vitals?hours=24                whether the memory is still being written and read, and what looks wrong
/search                         the read half of Cairn-as-memory; ?assignee= keeps one person's tasks
/context  /next                 the briefing a session opens with; what to pick up (?assignee= narrows it)
/activity                       recent activity across the workspace
/projects  /projects/{id}       list, create, read, rename, rekey, delete
/projects/{id}/tasks            list and create within a project; ?assignee= / assignee filters and sets the owner
/projects/{id}/repos            the repositories a project claims
/tasks/{ref}                    read (?view=digest), update (incl. assignee), close, delete
/tasks/{ref}/notes  /notes/{id} the work log
/tasks/{ref}/comments           for the human
/tasks/{ref}/activity           read history; POST git/run delivery evidence
/tasks/{ref}/mentions  /recall  where it is named; what bears on it
/tasks/{ref}/children           sub-tasks
/tasks/{ref}/attachments        upload; /attachments/{id} to fetch
/tasks/{ref}/dependencies       blocked-by / blocks
/tasks/{ref}/claim  /beat  /release  /checkpoint  /block
/knowledge  /knowledge/{slug}   what we know, and correcting it
/knowledge/{slug}/history       every version of an entry
/knowledge/gaps                 entries joined to nothing, and references to entries nobody wrote
/entities                       groupings a fact can be true of
/labels                         every label in use; rename and remove
/sessions                       the episodic record
/reconcile                      release claims that went quiet
/events                         change stream (SSE)
/people                         active users, for naming an assignee; open to agents too
/branding                       the instance's name and accent; administrators set them
/users  /users/{id}             administrator-only membership, roles, /password and /restore;
                                disabling someone who owns open tasks needs ?reassignTo=
/users/{id}/keys  /keys/{keyId} administrator-only agent keys: issue and revoke
/me/keys  /me/keys/{keyId}      your own agent keys: list and revoke; a signed-in person only, agent keys get 403
/connect  /connect/poll         unauthenticated, rate-limited: a machine asks to pair, then
                                polls until it is handed its keys, once
/connect/{code}/approve  /deny  a signed-in person answers it; agent keys get 403
```

A test walks `src/app/api/v1` and asserts every route on disk appears in the spec, so the
docs cannot fall behind the surface — which they had, by six routes, before that existed.

Authenticate with `Authorization: Bearer sk_live_…`. Keys are stored as a sha256 hash: the
plaintext is shown once — on **Users** when an administrator issues it, or handed to
`cairn setup` when a pairing is redeemed — and never again. Issue **one key per agent**, so
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
| `1` … `7` | Doing · Todo · Active · Backlog · All · Recent · Closed |
| `?` | Every shortcut |
| `Esc` | Close, leave a field, or clear the selection |

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

Then add members from **Users**. Each of them connects their own machines with
[`cairn setup`](#connect-a-machine), which pairs keys for their own agents in the browser; anyone can list and revoke their own keys under **Your agent keys** in the user menu; an
administrator can also issue or revoke anyone's keys there. All active identities share the
workspace; administrator privileges are required only for membership, roles, password
resets, other people's keys, and approving a `maintenance` key. Disabling someone who is
still the assignee of open tasks asks
who takes them over, and the tasks move with the disable rather than being orphaned.

### Without a disk or a shell: App Runner and similar

A platform that runs the container and nothing else — no volume, no one-off task, a request
time limit — needs five settings instead of the compose file's extra services:

| Setting | Replaces |
|---|---|
| `CAIRN_ATTACHMENT_S3_BUCKET` (and optional `CAIRN_ATTACHMENT_S3_PREFIX`, `CAIRN_ATTACHMENT_S3_REGION` where the platform sets no `AWS_REGION`) | the attachments directory. Files go to a private S3 bucket through the platform's role; the app still serves them through signed links, so the bucket never needs to be public |
| `CAIRN_MIGRATE_ON_START=1` | the `migrate` service. The container applies migrations before it serves, under an advisory lock, so several starting at once apply each file once |
| `CAIRN_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` / `_NAME` | `npm run operator:create`. The first administrator is created on start only while there is none, and a later start never resets its password; remove them after the first deploy |
| `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem` with `?sslmode=verify-full` | trusting the database. The image carries Amazon RDS's certificate authorities |
| `CAIRN_SSE_MAX_SECONDS=100` | nothing — App Runner ends every request at 120s, so live-update streams close first and reconnect cleanly |
| `HOSTNAME=0.0.0.0` | nothing — the image sets it, but App Runner overrides `HOSTNAME` with the instance's name, so Next listens on one interface and the health check fails. Set it again on the service |

Behind a proxy, rate limits key on the address the nearest proxy appended to
`X-Forwarded-For` — never the first entry, which the client writes. Set
`CAIRN_TRUSTED_PROXY_HOPS` if more than one proxy appends. Failed logins are also capped per
account (30 in 15 minutes, looser than the per-address 8 so a known email cannot be locked
out cheaply), which no address can get around. With a pooler in front of Postgres, use session
mode (RDS Proxy pins automatically): migrations hold an advisory lock and a transaction per
file, which transaction pooling would split. Keep a single replica, or accept that those limits
and a few caches are per replica.

### Secrets

`.env*` is gitignored except `.env.example`, and `docker-compose.override.yml` /
`docker-compose.prod.yml` are gitignored so host-specific configuration stays out of the
repository. Keep `DATABASE_URL` and `CAIRN_ATTACHMENT_SIGNING_KEY` server-side only.

## Agent setup

### Connect a machine

One command does what the rest of this section used to require by hand:
pairs a key per runtime with your identity, installs the CLI on PATH, copies the
skill, wires the hooks, and installs the `agent-files` job that keeps those copies
current. Any member can run it; no administrator is needed for their own agents.

```bash
curl -fsSL https://raw.githubusercontent.com/montytorr/cairn/main/install.sh | sh -s -- --url https://your-cairn
```

`install.sh` only checks for Node 22+, puts the latest release's `cli/cairn.mjs` in
`~/.local/bin`, and runs `cairn setup` with the same arguments; the work happens in
`cairn setup` itself, so re-running either one is the upgrade path — keys that still work
are kept, files are replaced only where they differ. It detects Claude Code (`~/.claude`),
Codex (`~/.codex`) and OpenClaw (only where this account's OpenClaw config runs a gateway),
pairs a key for each one that lacks a working one, and installs the files of the release
matching its own version. Only those runtimes get keys, hooks and skills. Hermes Agent is
never detected: `hermes` on PATH gets a line saying how to add it
(`--runtimes claude-code,hermes`), not a hook.

#### What `cairn setup` does

| Step | What it writes | Where | Skip | Undo |
|---|---|---|---|---|
| instance, keys | `CAIRN_BASE_URL` and one `CAIRN_API_KEY_<RUNTIME>` per runtime, paired in the browser | `~/.cairn/env` (mode 600), or `~/.cairn/instances/<name>/env` | — | remove the lines; revoke the keys at `<instance>/settings/keys` |
| release | the release matching the CLI's version (or `CAIRN_SETUP_SOURCE`) | `~/.cairn/releases/<version>` | — | `rm -r` it |
| cli | `cairn` | `~/.local/bin/cairn` | — | `rm ~/.local/bin/cairn` |
| skill | the Cairn skill, per runtime set up | `~/.claude/skills/cairn`, `~/.codex/skills/cairn`, `$CLAWD_HOME/skills/cairn` | `--no-skill` | `rm -r` the folder |
| hooks | tagged hook entries, per runtime set up; the Herdr pane-title plugin when `herdr` is on PATH | `~/.claude/settings.json`, `~/.codex/hooks.json`, OpenClaw's hook link, `hermes config` if named; `~/.cairn/hooks` | `--no-hooks`, `--no-herdr` | delete the entries naming `~/.cairn/hooks`; `herdr plugin unlink cairn.pane-title` |
| jobs | `agent-files` (below); `reconcile` and `vitals` with `--maintenance`; `openclaw-sessions` with OpenClaw | a LaunchAgent on macOS, root's or your crontab on Linux | `--no-jobs` | `node ~/.cairn/releases/<version>/scripts/install-cron.mjs --remove --only agent-files` |

What it never does: wire a runtime it did not set up (Hermes included), edit Herdr's
`config.toml`, follow a branch (the job syncs the release your instance runs), or replace the
job's own scripts from the network. Every line it prints starts with `✓` (done), `–`
(unchanged or skipped, with the reason and how to change it) or `!` (needs you), and it
ends with the next step and the undo commands above.

**What the `agent-files` job does, and where from.** It is installed by default (skip it
with `--no-jobs`) and `cairn setup` says so before installing it. Every 15 minutes and at
login on macOS, hourly on Linux, it overwrites the CLI (`~/.local/bin/cairn`), the hooks in
`~/.cairn/hooks` and the skill with the copies from its source, wherever they differ. Its
source is **the release your instance runs**: each run asks the instance's
`/api/v1/health` for its version and syncs that tag (`v<version>`), never a branch. If the
version cannot be read (the server is down, no instance is configured, the answer is not a
release number) or any file of that release is missing, the run writes nothing and exits
non-zero. It never replaces its own two scripts from the network; `cairn setup` updates
them when it runs again. On a machine with several instances it follows the newest release
any of them reports, default or not, since one CLI serves them all and a CLI ahead of a
server is the direction it already expects. An instance that cannot be asked (a company
instance behind a VPN, from home) is left out; the run refuses only when none answers.

- `CAIRN_SETUP_SOURCE=<checkout> cairn setup …` installs from that checkout and schedules the
  job to sync from it too, so a private mirror stays the only source.
- `CAIRN_REPO=<owner>/<name>` (read by `install.sh` and `cairn setup`) takes the release, and
  the job's tags, from a fork on GitHub; `CAIRN_RAW_REPO=<https base>` from any mirror that
  serves the same paths under `v<version>/`.
- `CAIRN_RAW_BASE=<url>` makes the job follow exactly that URL (for example a branch). It is
  a deliberate opt-in, and the job line says `--unpinned`.

```
$ cairn setup --url https://cairn.acme.io
cairn setup: connects this machine to Cairn — keys, the CLI, the skill, the hooks and the agent-files job.
  (cairn setup --dry-run shows the plan without changing anything.)
✓ instance  https://cairn.acme.io -> ~/.cairn/env
✓ server    https://cairn.acme.io (0.11.0)
Open this link to connect this machine:
  https://cairn.acme.io/connect/K7QX-M2RD (code K7QX-M2RD)
✓ runtimes  claude-code, codex (detected) — only these get keys, hooks and skills
– hermes    found on PATH, not set up — setup wires only the runtimes it pairs keys for.
   To add it: cairn setup --url <instance> --runtimes claude-code,codex,hermes
waiting for approval… ✓ approved by Julien
✓ keys      claude-code, codex -> ~/.cairn/env
✓ release   v0.11.0 -> ~/.cairn/releases/0.11.0
✓ cli       ~/.local/bin/cairn (0.11.0)
✓ skill     ~/.claude/skills/cairn, ~/.codex/skills/cairn
✓ hooks     installed:
     claude: SessionStart, SessionEnd, PreCompact, Stop (asks once per session to cairn learn)
     codex: SessionStart, Stop (live checkpoint; asks once per session to cairn learn), SessionEnd
     …
✓ jobs      agent-files:
     …
✓ cairn 0.11.0 ↔ server 0.11.0

Next: restart your agent sessions so they load the hooks.
Re-run `cairn setup` any time: it is the upgrade path, and it changes only what differs.
To undo:
  job     node ~/.cairn/releases/0.11.0/scripts/install-cron.mjs --remove --only agent-files
  …
```

The link opens a page on your instance; sign in if asked, and it comes back to the request.
The approval page shows the host as the device reported it, where the request came from and
who the keys will belong to, and lets you untick runtimes. Approve a link only if you just
ran `cairn setup` yourself: the keys are yours, so a link someone sends you would hand them
your agents. Each key is named `<runtime> on <host>` and is delivered once. You can revoke it
yourself on **Your agent keys** (user menu → `/settings/keys`), one key or a whole host at once;
an administrator can also revoke it on **Users**. Unapproved, the request expires in ten minutes.

| Flag | |
|---|---|
| `--url <instance>` | required the first time, and whenever the machine has several instances; otherwise the configured one |
| `--name <instance-name>` | names the instance when this `--url` is a second (or later) one on the machine (default: derived from the url, `cairn.acme.io` → `acme`). A first instance needs no name |
| `--runtimes a,b` | which agent runtimes to pair and install for (default: detected — `~/.claude`, `~/.codex`, and OpenClaw where this account runs its gateway). Detected or named, only these get keys, hooks and the job's skill copies. Hermes Agent is never detected: name it (`--runtimes claude-code,hermes`) to pair its key and wire its `pre_llm_call` hook |
| `--no-skill` / `--no-hooks` / `--no-jobs` / `--no-herdr` | skip that step (`--no-herdr`: the Herdr pane-title plugin). Without `--maintenance` the only jobs are `agent-files` and, when OpenClaw is among the runtimes and its sessions directory can be found, `openclaw-sessions` — otherwise it prints which `CAIRN_OPENCLAW_SESSIONS` to set and [the manual command](#scheduled-maintenance--optional) |
| `--maintenance` | also install `reconcile` and `vitals`, and pair a `maintenance` key for them — separately, because only an administrator can approve one: it releases anyone's claims |
| `--dry-run` | print the plan, change nothing |

Where a server predates pairing (`/api/v1/connect` answers 404), `cairn setup`
says so and prints where to get a key by hand instead of stopping dead — see
[the manual path](#the-manual-path) below.

### The manual path

The individual pieces `cairn setup` automates, for a machine that needs only
one of them, or a server old enough that pairing is not available yet. Without
pairing, keys come from an administrator on **Users**:

```bash
# credentials — or export CAIRN_BASE_URL / CAIRN_API_KEY
mkdir -p ~/.cairn && cat > ~/.cairn/env <<'ENV'
CAIRN_BASE_URL=https://cairn.example.com
CAIRN_API_KEY=sk_live_...
ENV
chmod 600 ~/.cairn/env

install -m 755 cli/cairn.mjs /usr/local/bin/cairn
```

### Keys and identity

**One key per runtime, where a machine runs more than one.** The key *is* the identity —
`actor_id` comes from the key, never from what the caller claims — so a single key shared
by Claude Code, Codex, OpenClaw and Hermes Agent by Nous Research files all of their work
under one name, and no agent can be held to its own behaviour. Add a key per runtime and the
CLI picks the right one. `cairn setup` writes these for you, one per runtime it pairs:

```bash
CAIRN_API_KEY=sk_live_...              # the fallback, when nothing else matches
CAIRN_API_KEY_CODEX=sk_live_...
CAIRN_API_KEY_CLAUDE_CODE=sk_live_...
CAIRN_API_KEY_HERMES=sk_live_...        # Hermes Agent by Nous Research
```

**Retiring or losing a machine?** Open **Your agent keys** from the user menu. Keys are grouped
by the host they were paired on; revoke one, or **Revoke all on this host**. A revoked key is
refused on its next request, and nothing else is disturbed. New keys only arrive through
`cairn setup`, which pairs them.

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

`CODEX_HOME` alone is not enough — Codex reads it but does not export it — which is why the
`CODEX_MANAGED_*` markers, which it does export, are on the list.
[`scripts/codex-wrapper.sh`](./scripts/codex-wrapper.sh) sets `CODEX_HOME` too; nothing
depends on it.

**Nesting is settled by the process tree, not the environment.** A Codex started from a
Claude Code shell inherits `CLAUDECODE=1`, so by environment alone every write it made was
filed as claude-code. When Claude Code's marker and a Codex marker are both present, the CLI
walks up its parent processes and takes the nearest one named `codex` or `claude`. If `ps`
cannot answer, the old order stands. Nothing is spawned when the environment is unambiguous.

**A key also names a human: the user it was issued to** — for a paired key, whoever
approved it. A task an agent files is assigned
to that person unless `--assignee` names someone else (`cairn people` lists who can be
named), and `--assignee me` means them. The
agent label stays on the claim and on the history; the human is who the work belongs to.

The CLI is deliberately dependency-free — Node 22's built-in `fetch` is enough — so it can
be dropped onto a box and run with no install step.

### Skill and hooks

`cairn setup` installs both; this is what it does, for doing it by hand.

**Skill** (Claude Code, Codex and OpenClaw all read skill folders):

```bash
cp -r skills/cairn ~/.claude/skills/     # Claude Code
cp -r skills/cairn ~/.codex/skills/      # Codex
cp -r skills/cairn "$CLAWD_HOME"/skills/ # OpenClaw — its own tree, not a dotfile dir
```

**Hooks** — the two mechanisms described under [Two mechanisms](#two-mechanisms-so-nobody-has-to-remember):

```bash
node scripts/install-hooks.mjs        # --dry-run to see what it would write
# By hand it wires every runtime it finds, Hermes included; `cairn setup` always passes
# --runtimes, and so can you: node scripts/install-hooks.mjs --runtimes claude-code,codex
# Hermes only, for an external router instead of the `cairn` on PATH (choosing between
# several instances is built in; see "Several instances on one machine"):
CAIRN_HOOK_CLI=/absolute/path/to/cairn-router node scripts/install-hooks.mjs
```

It is idempotent: every entry it writes is tagged, so re-running after an upgrade replaces
its own and touches nobody else's. Coverage differs by runtime:

| Runtime | Session start | Session recorded |
|---|---|---|
| Claude Code | `SessionStart` | `SessionEnd` **and** `PreCompact`; `Stop` asks once per session to `cairn learn` |
| Codex | `SessionStart` | `SessionEnd`, with a live checkpoint on every `Stop` that never ends the session or touches held tasks; `Stop` also asks once per session to `cairn learn` |
| Hermes Agent by Nous Research | `pre_llm_call` on the first turn only | — session recording is deliberately not installed |
| OpenClaw | `agent:bootstrap`, via the `cairn-briefing` hook package the installer links with `openclaw hooks install --link` (restart the gateway after) | swept from disk on a schedule — it has no session event of any kind |

**Asking the agent to `cairn learn`** (CAIRN-323). Agents can record what the work taught,
but nothing used to ask them. Two questions, neither of which calls a model:

- `cairn done` ends, for an agent, by asking whether the task established anything the next
  agent should know, with the `cairn learn … --task <ref>` command to run. It stays quiet for
  a duplicate, or when something was already learned on that task.
- On Claude Code and Codex, `Stop` runs `cairn-learn-nudge.mjs`, which covers the sessions
  that close no task. It blocks the hand-back with the same question, **once per session**,
  and only after a turn that edited a file or made a commit. It never asks on the
  continuation its own block caused, in a session that already ran `cairn learn`, or inside
  a summariser. `CAIRN_LEARN_NUDGE=0` turns it off.

On Codex the installer also lists every hook in `hooks.json` that is not Cairn's, and marks
the ones on `Stop`: `Stop` fires after **every turn**, so a session-end script written for
Claude Code and wired there by another tool runs once per turn, and one that makes a model
call bills once per turn.
It only says so. Removing another tool's hook is that tool's decision.

On OpenClaw the installer copies `hooks/openclaw/cairn-briefing` to
`~/.cairn/hooks/openclaw/cairn-briefing` and runs `openclaw hooks install --link <that dir>
--force` (`--dry-run` prints the command instead); the gateway needs a restart to load it.
It links only for an account whose OpenClaw config (`OPENCLAW_CONFIG_PATH`, or
`~/.openclaw/openclaw.json`) configures a gateway, because another account may hold a
client-only config; `--openclaw` links anyway.
OpenClaw discovers hooks only in the current workspace's `hooks/`, `~/.openclaw/hooks`,
`hooks.internal.load.extraDirs`, plugins and its bundle — `hooks.path` is the webhook URL
path, not a hook directory. [`docs/openclaw.md`](./docs/openclaw.md) has the recommended
`AGENTS.md` block and the rest of the setup.

Where `herdr` is on PATH the installer also links the `cairn.pane-title` plugin, which shows
each agent pane's claimed task in Herdr (`--no-herdr` skips it); see [`docs/herdr.md`](./docs/herdr.md).

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

### How a session gets written up

The session-end hook records what a session touched by
itself, but the prose on a session row — what was asked, what was learned, what landed,
what is next — is written by a model. The hook pipes up to 24 KB of transcript to a
summariser CLI and parses the JSON that comes back: `claude -p` for a Claude Code
session, `codex exec` for a Codex or OpenClaw one, since the runtime that produced a
session is the one certainly installed and logged in where it ran. When that one is not on
`PATH` the other is used. With neither, the row keeps its files, task refs and counts, the
log says so once a day, and nothing is queued for retry — `install-hooks` says so too.

```bash
CAIRN_SUMMARY_BACKEND=                              # claude | codex; unset: by runtime
CAIRN_SUMMARY_CLI=claude                            # or a wrapper, see below; alone it means claude
CAIRN_SUMMARY_MODEL=claude-haiku-4-5-20251001       # the claude backend's model
CAIRN_SUMMARY_CODEX_MODEL=gpt-6-luna                # the codex backend's model
CAIRN_SUMMARY_TIMEOUT_MS=60000
CAIRN_SUMMARY_MIN_INTERVAL_MS=600000                # see below
CAIRN_SUMMARY_LANGUAGE=                             # unset: the language of the person's prompts
```

The summary is written in the language the person wrote in, whatever language the
instructions are in; set `CAIRN_SUMMARY_LANGUAGE` (say `English`) to fix one for everyone.
The child starts with `--strict-mcp-config` and an empty `--mcp-config`, so none of your MCP
servers start for it: a server behind `op run` no longer asks for 1Password every time a
session ends. It also starts with `--tools ""`: it is given the transcript as data, and has
no tool to act on anything a transcript tells it to do.

The codex child is held to the same standard, which takes more flags: `--ephemeral`,
`--ignore-user-config`, `--sandbox read-only`, `mcp_servers={}`, and `--disable` for every
feature that carries a tool — the shell, `unified_exec`, apps, plugins, browser and computer
use, multi-agent — and for `hooks`, since `hooks.json` loads even without the config. The
read-only sandbox alone is not enough: it still lets the shell read any file. A Codex that
refuses an unknown flag is asked again without it, except the shell, `unified_exec` and
`hooks`: a Codex that will not turn those off is not asked at all.

For the OpenClaw sweep, `install-cron.mjs` carries `CAIRN_SUMMARY_BACKEND`, both models and
`CAIRN_SUMMARY_LANGUAGE` into the crontab when they are set where it runs.

**How often that call happens.** Not once per session, because not every runtime has a
session-end event to hang it on. Claude Code records at `SessionEnd` *and* `PreCompact`,
and Codex writes a live checkpoint on `Stop` — the end of every assistant turn — so a
session left open still shows what it did. Left alone that is one model call per turn.

So the hook reuses the last summary it wrote for a session when the digest is byte-for-byte
what it already summarised, or when the previous call was under
`CAIRN_SUMMARY_MIN_INTERVAL_MS` ago. The deterministic half — files, task refs, counts — is
written fresh every time regardless; only the prose is reused, and reused rather than
omitted, so a row never loses prose it already had. The stamps live in
`~/.cairn/summaries.json`, fifty sessions deep. Set the interval to `0` to summarise every
time.

The hook keeps the row when the summariser cannot be reached, because losing the record of
a session over a missing summary would be the worse trade. It no longer does so silently:
every failure is appended to `~/.cairn/summariser.log` with what the summariser said (its
stderr, the exit code, a timeout), and the session is queued in `~/.cairn/unsummarised.json`.
The next run of the hook that reaches a working summariser re-summarises up to two queued
sessions and posts the prose onto the existing row — at most four retries per session, 15
minutes apart, for 48 hours (`CAIRN_SUMMARY_RETRY_BATCH`, `CAIRN_SUMMARY_RETRY_SPACING_MS`).
When there is no summary, the request falls back to the first thing a person actually typed
— never a skill expansion, a runtime wrapper or a bare "hello". `cairn vitals` still reports
sessions without prose daily.

Two cases where the summariser needs help:

- **The transcripts are root's and the login is not.** A swept runtime whose sessions live
  under a `0700` home has to be swept as root, and `claude -p` as root is not logged in.
  Point `CAIRN_SUMMARY_CLI` at a wrapper that drops to the account that is:
  `sudo -n -u <user> -H env HOME=/home/<user> CAIRN_SUMMARISER=1 claude "$@"`.
- **The summariser is itself a Claude Code session.** It would trigger the hook again, so
  the hook sets `CAIRN_SUMMARISER=1`, `QUARRY_SUMMARISER=1` and `AGENT_MEMORY_SUMMARISER=1`
  in the child and exits immediately when it sees any of them — so Quarry's summariser is
  skipped too, and Quarry skips ours. The child also runs with `--no-session-persistence`
  from a scratch directory, so `claude --continue` in a project can never resume it. And a
  transcript whose first turn is a summariser prompt is not recorded whatever the
  environment said, because a `sudo` wrapper resets the environment. A wrapper should
  still pass the flags through: `sudo -n -u <user> -H env HOME=/home/<user>
  CAIRN_SUMMARISER=1 QUARRY_SUMMARISER=1 claude "$@"`.

**When a runtime has no session-end event**, nothing hands the transcript over, so sweep
instead of waiting:

```bash
node ~/.cairn/hooks/cairn-session-end.mjs --scan <sessions dir> --window-hours 2
node ~/.cairn/hooks/cairn-session-end.mjs --dry-run <transcript>   # parse it, write nothing
```

`--dry-run` is the thing to reach for when a runtime is recording nothing: it prints what
would be written from one transcript, which separates "the hook never ran" from "the hook
ran and understood nothing".

### MCP — optional

Native tool-calling for Claude Code and Codex; OpenClaw reaches it through `mcporter`. The
server lives in [`mcp/`](./mcp), holds no logic of its own, and
exposes 21 of the CLI's verbs as typed tools — `context`, `next`, `history`, `people` and the
session verbs stay CLI-only. `cairn_check`, `cairn_add` and `cairn_list` take an optional
`assignee`, and `cairn_add`'s body meets the same markdown rule as `cairn add`.

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

### Existing memory

If you already keep curated agent memory as one markdown file per
fact, `node scripts/import-memory-files.mjs --dry-run` shows what it would bring in as
knowledge. It reads `~/.claude/projects/*/memory/` unless `--root` says otherwise, and
needs `--map <file>` — JSON of `{ "<directory>": "KEY" | null }` — to know which project
each directory belongs to. Anything unmapped is refused rather than filed globally, since
knowledge in the wrong scope is read by every project that should not see it; `--global`
says you meant it.

### What the CLI keeps on disk

All under `~/.cairn/`, none of it precious except `env`:

| | |
|---|---|
| `env` | credentials, `0600` |
| `acted.jsonl` | a breadcrumb per accepted write, which is how a session knows which tasks it touched on a runtime whose session names the CLI cannot see |
| `outbox.jsonl` | notes, comments and checkpoints made while the server was unreachable, replayed later; `outbox.jsonl.rejected` keeps what the server refused rather than discarding it |
| `projects.json` | directory → project key, from `cairn map` |
| `ownership/` | which tasks this machine holds |
| `recorded-rollouts` | which swept transcripts have already been turned into sessions, so a sweep on a timer is idempotent |
| `summaries.json`, `unsummarised.json`, `summariser.log` | the session summariser's reuse stamps, its retry queue, and every failure it hit |
| `hooks/`, `maintenance/` | where the installers put the copies they manage |
| `instances.json` | only on a machine with several instances: each one's URL, the saved routes, and what an unrouted directory does |
| `instances/<name>/` | that instance's own `env`, outbox, `ownership/`, `projects.json` and `project-keys.json` (its project keys, for routing a ref); on such a machine the files above with those names are not read |
| `session-routes/`, `unrouted/` | answers given for one session only, and sessions that ended before anyone said which instance they belong to |

### Several instances on one machine

A personal Cairn and a work one, say. Nothing in a
task ref, a project key or a directory name says which server a command is for, so the
choice is made explicitly or not at all:

```bash
cairn setup --url https://cairn.work.example --name work   # adopts this machine's existing setup as an
                                                          # instance (still the default), registers
                                                          # `work`, pairs its keys into
                                                          # ~/.cairn/instances/work/env
cairn instance list
cairn note ACME-42 "…" --instance work                                # or CAIRN_INSTANCE=work
```

- `~/.cairn/instances.json` names the instances and what happens in a directory with no
  route: `"unclassified": {"mode": "default", "instance": "personal"}` uses that one, and
  `{"mode": "ask"}` (the default) stops before any request with **exit 10**, so an agent asks
  the user instead of guessing. Adding the second instance with `instance add` at a terminal
  asks which you want (`cairn setup` never asks, and says so when it is `ask`); `--default`
  on `instance add`, or `cairn instance policy ask | default <name>` at any time,
  answers it directly.
- Each instance keeps its own state in `~/.cairn/instances/<name>/`: `env` (the same per-runtime
  keys as [above](#keys-and-identity)), the outbox, ownership and `projects.json`. `--adopt` moves the files at the
  top of `~/.cairn` into the instance, and refuses if they were used with a different server
  (`CAIRN_BASE_URL`, then `~/.cairn/env`, then localhost). Interrupted, it finishes on a re-run.
  `cairn setup` adding a second instance does this itself, naming the adopted one from its url.
- `CAIRN_API_KEY` in the environment is refused once instances are configured — it cannot say
  which instance issued it — and so is a `CAIRN_BASE_URL` that disagrees with the chosen one.
- People are per instance too: `--assignee me` is resolved by the server that answers, as
  the human behind that instance's key.
- Without `instances.json` nothing changes.

**Which instance a command goes to**, when it does not say, is decided in this order, and
nothing is ever guessed from a project name, a remote or a directory name:

1. `--instance` or `CAIRN_INSTANCE`;
2. a saved route for the directory: an **exact** route names one repository — its main
   checkout, so every worktree and subdirectory follows — or one plain directory; a
   **folder** route covers everything under it. Exact beats folder, folder routes never
   overlap, and none may cover `~` or `/`;
3. the command's ref (`note WORK-12 …`, never a flag's value), when exactly one instance is
   known to have its project — each instance's keys are cached from its own responses, at
   most six hours old. A route still wins over it, with a hint to add `--instance`. Past six
   hours a cache is stale, which is the ordinary state of any secondary instance nobody has
   used in a while, so before deciding anything this gives every stale instance one short
   (1.5s), best-effort chance to say what it currently owns, from its own URL and key. An
   instance that answers is treated exactly like a fresh one; one that does not (still down,
   or never reached at all) leaves the routing rule unchanged from before the attempt: only
   the instance(s) whose *own* cache actually claims this ref are ever a problem — if that
   cache is still stale after the attempt, or two fresh caches both claim it, the command
   stops with **exit 10** instead of guessing; an unrelated instance that could not be reached
   never blocks a ref a reachable instance plainly owns. The one case this refuses outright
   rather than falling through to step 5 is an instance that has *never once* answered (no
   cached keys at all, not merely an old cache) and still could not be reached to ask — every
   project on such an instance would otherwise be permanently invisible to this rule. A
   project that moved between instances within the old owner's six-hour window is the
   server's problem, not this rule's: a write to the archived copy gets a `409`, naming the
   project's new home;
4. an answer saved for this session only;
5. the default instance, if `unclassified` names one.

Otherwise the command stops with exit 10 before any request and prints what to ask and the
command that saves the answer; at a terminal it asks you instead.

```bash
cairn route                                # this directory's instance, and why
cairn route add work                       # this repository (or directory)
cairn route add work --folder              # ~/clients and everything under it
cairn route add personal --session         # just this session
cairn route list | pending | remove [--folder]
```

The session-start briefing passes that instruction to the agent, so it asks the first time
it needs Cairn. A session that ends before anyone answered is not guessed at or dropped: the
session-end hook parks it in `~/.cairn/unrouted/`, and `route add` sends it (without
checkpointing, since it may be days old).

**Maintenance** is about an instance, not a directory, so `reconcile` and `vitals` take
`--all-instances` — one run per instance under its own maintenance key — and the reports
name their instance: `CAIRN_NOTIFY_VITALS=personal:CAIRN-107,work:OPS-3`. See
[Scheduled maintenance](#scheduled-maintenance--optional); re-run its installer (or
`cairn setup --url <it> --maintenance`, which also pairs its key) after adding instances.
The MCP server routes by the directory it was started in, like any other command.

**Telling them apart in the browser.** An administrator can give each instance its own name
and accent colour under **Settings → Branding**. The name replaces "Cairn" in the sidebar, the
breadcrumbs, every tab title (`Board · Work Cairn`), the login page and link previews; the
accent recolours the interface and the mark, so the favicon is the same cairn in that
instance's colour. Each theme gets a variant of the colour that stays readable on its ground,
so a dark navy comes out a brighter blue in dark mode. It is stored in the database, not the
environment, and needs no rebuild.

### Integrating a runtime that is not listed above

The runtimes above are the ones this is used with. Nothing here is specific to them, and
another runtime is mostly a question of which of these it gives you.

**A skill folder and a CLI on PATH is the whole minimum.** Every interface here shells out
to the same binary, so a runtime that can run a shell command and read a markdown file is
already integrated. The hooks, the MCP facade and the rest are how it gets better, not how
it starts.

**One key per runtime, always** ([why](#keys-and-identity)). This is the only item on this
list that is not optional.

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
sweep** — point `CAIRN_SUMMARY_CLI` at a wrapper that drops privilege, as in
[How a session gets written up](#how-a-session-gets-written-up).

**A copy in a directory nothing reads is worse than no copy.** Agent-facing files live in
a directory per runtime and drift silently. Repair copies where a runtime already lives;
never install one because a plausible directory exists.

## Scheduled maintenance — optional

Cairn works with none of these. They are the difference between a tracker that notices its
own problems and one that waits to be asked, and each is independent: install none, some,
or all. [`cairn setup`](#connect-a-machine) installs `agent-files`, and `reconcile` and
`vitals` too with `--maintenance`; the installer below is for the rest, or for doing it by
hand.

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
retries a network failure for about a minute and a half before it gives up. Reporting into
a task (`CAIRN_NOTIFY_FILES`) needs a maintenance key (below), and warns about a missing one
on every run.

Install only what that machine is for. A laptop beside a server usually wants
`--only agent-files`, which is what `cairn setup` installs for every machine — plus
`openclaw-sessions` where it sets up OpenClaw and can find its sessions directory: `reconcile`
and `vitals` are about the instance rather than the machine, and running `vitals` in two
places reports the same findings twice.

| Job | What it is for |
|---|---|
| `reconcile` (30 min) | Releases any claim in the workspace that went quiet for two hours, and moves a `doing` task back to todo so `doing` keeps meaning somebody is on it (`in-review` keeps its status). Workspace-wide only under the `maintenance` key; any other agent's `reconcile` covers its own claims. Once per instance on a machine with several |
| `vitals` (daily) | Asks whether the memory is still being written and read, and reports **only** when something looks wrong. Once per instance on a machine with several |
| `agent-files` (hourly on Linux, and on every deploy; on macOS every 15 minutes and at load) | Repairs the skill, CLI and hooks wherever a runtime is reading a stale copy, from the release the instance reports (`--source release`) or a checkout `cairn setup` was run from |
| `openclaw-sessions` (30 min) | OpenClaw has no session-end event, so its transcripts are swept instead of waiting to be handed over |

Host-specific paths come from the environment, because a machine's layout does not belong
in this repository: `CAIRN_CLI_PATH`, `CAIRN_NODE_PATH`, `CAIRN_LOG_DIR`,
`CAIRN_SYNC_SCRIPT`, `CAIRN_HOOKS_DIR`, `CAIRN_OPENCLAW_SESSIONS`,
`CAIRN_SUMMARY_CLI` for a sweep that has to reach a summariser it cannot run as itself, and
`CAIRN_SYNC_ALSO` for copies outside the running user's home. Where `agent-files` syncs
from is `release` by default — the tag of the version the instance reports, under
`CAIRN_RAW_REPO` (or `CAIRN_REPO=<owner>/<name>` on GitHub; default the public repository)
— or `--source <checkout>` on `--install`, which is what `cairn setup` passes from
`CAIRN_SETUP_SOURCE`. `CAIRN_RAW_BASE` makes it follow one URL as given, rendered with
`--unpinned`; that is the only way to schedule a branch. The defaults describe the
machine rather than one host: on macOS the CLI is looked for in `~/.local/bin`, logs go to
`~/Library/Logs`, and node is the one running the installer. `CAIRN_NOTIFY_VITALS` and
`CAIRN_NOTIFY_FILES` name a task to report into; leave them unset and the jobs stay quiet. On
a machine with several instances, `reconcile` and `vitals` run once per instance
(`--all-instances`) and exit non-zero if any run failed, and the targets name their
instance: `CAIRN_NOTIFY_VITALS` is a comma list, one `<instance>:<ref>` per instance, and
`CAIRN_NOTIFY_FILES` a single `<instance>:<ref>` — the sync warns about a bare ref, which
exists on only one of them.

Run the jobs under an identity of their own: `CAIRN_AGENT=maintenance` with a matching
`CAIRN_API_KEY_MAINTENANCE` (in each instance's `env`, where there are several).
`cairn setup --maintenance` pairs it, in a request of its own that only an administrator
can approve, since it releases anyone's claims. Where the
keys are split per runtime, the CLI refuses to send a maintenance write under the default
key (exit 3), because that key belongs to some other agent and a scheduled job's warning is
read by nobody.

### Keeping the copies honest

The skill, the CLI, both hooks and the OpenClaw briefing are read from a directory per
runtime, so the same file
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

`--source release` takes the canonical files from the tag of the release the instance
reports at `/api/v1/health` (`--repo <base>` for a mirror), which is what lets it run on a
host with no checkout; `--source <url>` takes them from that URL as given. From any remote
source everything is fetched before anything is written, a version that cannot be read or
validated writes nothing, and the two maintenance scripts are skipped: a repairer that
rewrites itself from the network cannot be audited once installed, so they change only when
`install-cron.mjs --install` (which `cairn setup` runs) or a source on disk puts them there.
A job installed before this read `--source https://raw.githubusercontent.com/montytorr/cairn/main`;
that exact URL is now read as `release`. `--runtimes a,b` leaves a listed-out runtime's copy
alone. A CLI is only ever updated where one is already installed — `/usr/local/bin`
existing is not consent to install into it.

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
deployed sitting on disk, which beats any network source the schedule names: that is
CDN-cached, so a fetch seconds after a merge can be handed the previous tree and write it
back as current (`--repo` and `--unpinned` go with the source they described). `--no-notify` because a repair is the *expected* outcome of this path —
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
  administrators alone manage users, roles, passwords and other people's agent keys. A
  signed-in person can pair keys for their own agents, and a `maintenance` key only if they
  are an administrator. PostgreSQL
  is reachable only from the private application network.

**The data model**, in six groups:

| | |
|---|---|
| the tracker | `projects` (+ `project_repos`, `project_former_keys`), `tasks` (+ `task_projects` for extra projects; `assignee_user_id` is the owning human, `claimed_by` the agent on it, `actor_id` who filed it), `task_notes`, `task_comments`, `task_attachments`, `task_deps`, `task_mentions`, `task_activity_events` |
| what we know | `knowledge` + `knowledge_projects` / `knowledge_entities` / `knowledge_files`, and `knowledge_revisions` for every version it replaced |
| what happened, and where | `sessions`, `file_touches` |
| groupings | `entities` + `project_entities`, between one project and everything |
| whether it is read back | `search_events` (the query, whether it widened, which entries came back), `knowledge_reads` (every read by slug, with a `hit` flag — `false` says a named fact was asked for and missing), and `knowledge_recall_state` derived from both |
| who | `app_users`, `app_sessions`, `api_keys`, and `connect_requests` for machine pairings (device codes hashed, kept 90 days once used as the record of who approved which host) |

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
  ([#4](https://github.com/montytorr/cairn/issues/4)); that `next dev` was quietly
  eating the agent guide's byte budget
  ([#1](https://github.com/montytorr/cairn/issues/1)); and that the browser UI could not
  write behind a TLS-terminating proxy, with the fix
  ([#42](https://github.com/montytorr/cairn/issues/42),
  [#43](https://github.com/montytorr/cairn/pull/43)).
- **[@jgiffard](https://github.com/jgiffard)** — the shared multi-user workspace
  ([#5](https://github.com/montytorr/cairn/pull/5)), a configurable backup role
  ([#55](https://github.com/montytorr/cairn/pull/55)), Hermes Agent support
  ([#61](https://github.com/montytorr/cairn/pull/61)), session checkpoints without closing
  ([#67](https://github.com/montytorr/cairn/pull/67)), the project-scoped briefing
  ([#68](https://github.com/montytorr/cairn/pull/68)), and the proposal that became
  several instances on one machine.

A report that leads to a fix is credited here the same way a patch is. Finding the problem
is most of the work — much of the above was invisible from the inside, because the machine
that wrote the code had already been set up in a way that hid it.

## Licence

[Sustainable Use License](./LICENSE) — the licence n8n publishes, for the reason they
publish it. Read the source, run it yourself for your own business or personally, modify
it, fork it, share your changes. The one thing it does not permit is selling Cairn itself
as a service.

Releases up to and including v0.5.1 were MIT and stay MIT for anyone who has them; a
licence change is not retroactive. [`LICENSE-MIT-HISTORY`](./LICENSE-MIT-HISTORY) says
exactly what moved and what did not.
