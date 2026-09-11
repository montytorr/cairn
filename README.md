# Cairn

**The tracker your agents read before they start, and write to as they work.**

They check it for prior work, claim what they take, record what they tried — including
what failed — and close nothing without saying how. Six weeks later a different agent
asks the same question and gets the answer instead of repeating the work.

Self-hosted. A cairn is a stack of stones travellers leave to mark a path for whoever
comes next: a different agent, a different model, you in six weeks.

Three hooks make it happen without anyone being reminded — a briefing when a session
starts, what is known about a file when one is opened, and the session written down when
it ends.

> **Single-tenant on purpose.** Every RLS policy resolves to one owner, so Cairn is built
> for one person and their agents, not a team. In daily use; schema, API, CLI, UI and the
> agent contract are all in place.

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
$ cairn add "Migrations time out when workers run in parallel" --project CAI --type bug
similar existing work:
  CAI-12 [done] Make the migration runner idempotent
id	9f3c1a04-2b77-4a0e-8d51-6e0c2f1b9a44
number	57
title	Migrations time out when workers run in parallel
type	bug
status	backlog
priority	medium
created_at	2026-08-14T14:51:09.223Z
ref	CAI-57
```

Take it, so a second agent on the same backlog picks something else:

```console
$ cairn claim CAI-57
id	9f3c1a04-2b77-4a0e-8d51-6e0c2f1b9a44
number	57
status	doing
claimed_by	claude-code
claimed_at	2026-08-14T14:52:40.102Z
heartbeat_at	2026-08-14T14:52:40.102Z
attempt	1
```

`claim` is one conditional UPDATE. If somebody else holds it, it exits **9** and says who,
rather than guessing:

```console
$ cairn claim CAI-57
Held by codex, last heartbeat 3m ago. Pick different work; a lease becomes stealable
after 15m of silence.
```

Then the work log, as the work happens. The dead end goes in too — it is the half that
saves the next agent an hour:

```console
$ cairn note CAI-57 "Raised the client pool_size to 30. No change under load." --kind attempt
... (the written row, same shape as below)

$ cairn note CAI-57 "Supavisor caps at its own pool_size regardless of what the client asks for." --kind finding
id	c02b8f31-5c4d-4f2a-9a63-1f0d7e3a55b1
kind	finding
note	Supavisor caps at its own pool_size regardless of what the client asks for.
actor_type	agent
actor_id	claude-code
created_at	2026-08-14T15:41:52.006Z
```

The finding outlives the task, so promote it to knowledge — scoped to the project, because
it is not true everywhere:

```console
$ cairn learn "Supavisor caps the pool at its own setting" --project CAI \
    --body "The client's pool_size is advisory. Raise it in the pooler's own config; the client-side value never wins."
id	4a7e9b12-83cd-4d7f-b0a1-2c5f8d6e7099
slug	supavisor-caps-the-pool-at-its-own-setting
title	Supavisor caps the pool at its own setting
body	The client's pool_size is advisory. Raise it in the pooler's own config; the client-side value never wins.
actor_type	agent
actor_id	claude-code
created_at	2026-08-14T16:01:44.870Z
updated_at	2026-08-14T16:01:44.870Z
projects	CAI
```

Close it. The resolution is not optional — the API rejects a `done` or `cancelled`
transition without one:

```console
$ cairn done CAI-57 --resolution "Raised the pooler's own pool_size to 40; the client-side setting was never the cap."
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
task	CAI-57	done	bug	yes	~30	Migrations time out when workers run in parallel
knowledge	supavisor-caps-the-pool-at-its-own-setting	current	knowledge		~32	Supavisor caps the pool at its own setting
note	CAI-57	done	bug	yes	~21	Supavisor caps at its own pool_size regardless of what the client asks…
session	2026-08-14	claude-code	session	yes	~74	migrations time out when workers run in parallel
3 precise, 1 loose
```

`show` gives the cheap read: the answer in full, the findings and decisions, a clipped
body, and an honest account of what it withheld.

```console
$ cairn show CAI-57
ref	CAI-57
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
findings.0.by	claude-code
findings.0.at	2026-08-14T15:41:52.006Z
omitted.descriptionBytes	0
omitted.attemptsAndNotes	1
omitted.tokensToFetchFull	118
omitted.full	?view=full
withheld: 0B of body, 1 attempt/note(s) — cairn show CAI-57 --full is ~118 tokens
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

## Three mechanisms, so nobody has to remember

This is the part that makes the rest hold. Installed by `node scripts/install-hooks.mjs`.

| When | What happens |
|---|---|
| session start | the briefing is injected — what you hold, what is in flight, where the last session in this directory stopped, what is known here |
| a file is read | what Cairn knows about *that file*, if anything; silence if not |
| session end | the session is recorded, and any task still held is checkpointed |

Every hook fails silent and non-blocking. A memory system must never be the reason a
session cannot start or close. `CAIRN_HOOK_DEBUG=1` when that silence is itself the
problem.

## Features

**Tracking**

| | |
|---|---|
| Refs | `CAI-42` — project key plus per-project number, stable in a transcript |
| Types | `feature · bug · improvement · chore · spike · docs` |
| Statuses | `backlog · todo · doing · in-review · done · cancelled` |
| Structure | sub-tasks, blocked-by / blocks dependencies with cycle rejection, labels, priorities, due dates |
| Bodies | markdown in a WYSIWYG editor — syntax-highlighted code, GFM tables and task lists; bare refs like `CAI-42` become links |
| Trails | comments for humans, an append-only work log for agents, file attachments, and a full activity history |
| Views | list and board per project, a cross-project board at `/board` grouped and swim-laned by status, priority, type, project or agent, bulk edit with shift-click ranges, a cross-project home, live updates over SSE |
| Multi-project tasks | a task can belong to several projects at once — the home project keeps the ref, the extra links only widen where it appears |

**Memory**

- Postgres full-text search across all four stores in one pass, ranked inside the database
  by `ts_rank`. Closed work is included on purpose, and a row carrying a recorded answer
  outranks one that merely mentions the subject.
- A precise `websearch_to_tsquery` pass first; it widens to OR only when the precise pass
  comes back thin, and says so per row, because twenty loose word-overlaps silently read
  as prior work. Widening plus ranking in the database took measured recall on the real
  corpus from **75% to 93%**, with 12 of 15 hits at rank 1. Both rules came out of
  measurement rather than taste, and so did two rejections: ranking by term coverage first
  tested worse (87% → 81%) and was reverted, and re-sorting in the application dropped
  recall from 75% to 6%. The reasoning is written into
  [`004_search_ranked.sql`](./supabase/migrations/004_search_ranked.sql) and
  [`016_search_all.sql`](./supabase/migrations/016_search_all.sql); the measurements
  themselves are in Cairn, on the tasks that produced them — which is the product's own
  argument, made about itself.
- Results are an **index**, never bodies: each row advertises a `~tokens` cost, so an agent
  budgets what it opens instead of pulling text it will never read.
- **Knowledge is scoped narrowest-first** — to a project, to an *entity* (a grouping of
  projects: a business, a stack, a subsystem), or to nothing, meaning everywhere. It is
  corrected rather than added to: `superseded_by` keeps the old claim findable and marked,
  because two contradictory facts with no way to tell which is current is how a memory
  store stops being worth reading.
- **A file index** answers the question nobody asks: opening a file surfaces the tasks and
  knowledge that concern it, with no query to write.

**Coordination**

- A claim / heartbeat / checkpoint protocol so several agents can work one backlog without
  colliding. A lease whose holder has gone quiet for 15 minutes becomes stealable — one
  conditional UPDATE, no reaper, no cron, no lease table.
- `cairn reconcile` releases claims an agent walked away from, leaving a note saying why —
  the backstop for runtimes with no session-end event. It never closes anything: a task
  with a resolution nobody meant is worse than one plainly still open.
- `cairn context` is the briefing a session opens with, and is worth running by hand
  whenever you have lost your place.

## Agent access

Three interfaces over **one** implementation, so behaviour cannot diverge between them.

| Interface | For |
|---|---|
| `cairn` CLI | anything that can run a shell command — this is the implementation |
| `SKILL.md` | Claude Code, Codex and OpenClaw; all three read skill folders |
| MCP server | native tool-calling — a thin facade over the CLI, holding no logic |

[`AGENTS.md`](./AGENTS.md) is the contract every agent should read. It is kept under 8 KB,
and CI enforces that, because agents read it every session.

### The CLI

Output is TSV by default — a `#count` line, a header row, then rows — with `--json` to
parse and `--pretty` to read. Nulls and defaults are omitted rather than printed. `--body -`
and `--resolution -` read from stdin, so long markdown stays off argv.

| | |
|---|---|
| `cairn check "<subject>"` | **Start here.** Prior work across all four stores, with a `~tokens` cost per row |
| `cairn context` | The briefing: what you hold, what is in flight, where the last session here stopped |
| `cairn show <ref>` · `cairn list --project K` · `cairn projects` | Read one, many, or the project index |
| `cairn add "<title>" --project K` | File work. Warns if something similar already exists |
| `cairn update <ref> --status S --priority P` | Change fields; `--project` moves it, `--also-project` widens it |
| `cairn done <ref> --resolution "…"` | Close. The resolution is required |
| `cairn cancel <ref> --resolution "…"` | Drop it, and say why |
| `cairn note <ref> "…" --kind attempt` | Append to the work log — `note · attempt · finding · decision · handoff` |
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
| `cairn learn "<title>" --body -` | Record what we now know. Global unless `--project` or `--entity` |
| `cairn know [<slug>\|<query>]` | Read it back, or list what applies here |
| `cairn relearn <slug>` · `cairn unlearn <slug> --superseded-by <slug>` | Correct it, or mark it replaced |
| `cairn entities` · `cairn entities assign <key> --project A,B` | Groupings a fact can be true of |
| `cairn session list` · `cairn session end --id <id>` | The episodic record |
| `cairn reconcile` | Release your own claims that went quiet |
| `cairn project rename\|archive\|restore\|delete <KEY>` | Deleting takes every task with it, and demands `--confirm <KEY>` |
| `cairn map <KEY>` | Tell Cairn which project this directory is |

`cairn --help` is the full reference.

## API

`GET /api/v1/openapi.json` serves an OpenAPI 3.1 document generated from the same Zod
schemas the routes validate against, so it cannot drift. Browsable at `/api-docs`.

```
/health                         unauthenticated probe
/search                         the read half of Cairn-as-memory
/projects  /projects/{id}       list, create, read, rename, delete
/projects/{id}/tasks            list and create within a project
/tasks/{ref}                    read, update, close
/tasks/{ref}/notes              the work log
/tasks/{ref}/comments           for the human
/tasks/{ref}/activity           what changed, when, and who changed it
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
```

A test walks `src/app/api/v1` and asserts every route on disk appears in the spec, so the
docs cannot fall behind the surface — which they had, by six routes, before that existed.

Authenticate with `Authorization: Bearer sk_live_…`. Keys are stored as a sha256 hash: the
plaintext is shown once, at creation, and never again. Issue **one key per agent**, so
writes are attributable and any single agent can be revoked without disturbing the others.

Every response is enveloped: `{"success":true,"data":…}` or
`{"success":false,"error":"…","code":"…"}`.

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

Requires Node 22+, Docker, and a Postgres/Supabase stack (Postgres, Auth and Storage).

```bash
git clone https://github.com/<you>/cairn.git && cd cairn
cp .env.example .env.local        # fill in your Supabase URL and keys
npm install
npm run db:migrate                # applies supabase/migrations/*.sql in order
npm run dev
```

To deploy behind a reverse proxy:

```bash
cp docker-compose.example.yml docker-compose.yml
# set CAIRN_DOMAIN and CAIRN_PROXY_NETWORK in your environment
docker compose up -d --build
```

The example assumes a Traefik instance already running on an external Docker network with
a Let's Encrypt resolver; adapt the labels for nginx or Caddy. The container runs
read-only, as a non-root user, with all capabilities dropped.

### The first user

There is no sign-up page — a single-tenant tracker does not need one, and an open
registration form on a public host is a liability. Create the account against your
Supabase Auth instance directly:

```bash
curl -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…","email_confirm":true}'
```

`email_confirm: true` matters: without SMTP configured there is no confirmation mail to
click, and an unconfirmed user cannot sign in. Then issue an agent key from **Settings**
once you are in.

> `NEXT_PUBLIC_*` values are inlined at **build** time. If you build an image once and
> configure it per environment at run time they will be empty in the browser — Cairn
> passes them through a runtime provider instead, which is why the root layout is
> `force-dynamic`.

### Secrets

`.env*` is gitignored except `.env.example`, and `docker-compose.override.yml` /
`docker-compose.prod.yml` are gitignored so host-specific configuration stays out of the
repository. `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — keep it server-side only.

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

The CLI is deliberately dependency-free — Node 22's built-in `fetch` is enough — so it can
be dropped onto a box and run with no install step.

**Skill** (Claude Code, Codex and OpenClaw all read skill folders):

```bash
cp -r skills/cairn ~/.claude/skills/     # Claude Code
cp -r skills/cairn ~/.codex/skills/      # Codex
cp -r skills/cairn /root/clawd/skills/   # OpenClaw
```

**Hooks** — the three mechanisms above:

```bash
node scripts/install-hooks.mjs        # --dry-run to see what it would write
```

It is idempotent: every entry it writes is tagged, so re-running after an upgrade replaces
its own and touches nobody else's. Coverage differs by runtime:

| Runtime | Session start | File read | Session end |
|---|---|---|---|
| Claude Code | `SessionStart` | `PreToolUse(Read)` | `SessionEnd` |
| Codex | `SessionStart` | `PreToolUse(Read)` | `Stop` — there is no `SessionEnd`, so it leans on the API being idempotent |
| OpenClaw | manual — push `cairn context` output into the existing `agent:bootstrap` hook | — | — · schedule `cairn reconcile` instead |

Codex hook entries must also be trusted in `~/.codex/config.toml` before they run; the
installer prints what to add.

**MCP** (optional — native tool-calling for Claude Code and Codex; OpenClaw reaches it
through `mcporter`). The server lives in [`mcp/`](./mcp) and declares a `cairn-mcp` bin.
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
knowledge.

## Architecture

- **Next.js 16** (App Router) · React 19 · TypeScript · Tailwind v4
- **Postgres** via Supabase — Auth for the human login, Storage for attachments
- **Auth**: a Supabase Auth session for the UI, enforced server-side in middleware; hashed
  bearer API keys for agents, one key per agent
- **RLS**: every policy resolves to `projects.owner_user_id = auth.uid()`. The
  service-role client bypasses it, so every server-side query filters by owner explicitly —
  RLS is the browser-side boundary and defence in depth, not what protects server reads.

**The data model**, in four groups: `projects` / `tasks` / `task_notes` / `task_comments`
/ `task_attachments` / `task_deps` / `task_activity_events` for the tracker;
`knowledge` + `knowledge_projects` + `knowledge_entities` for what we know; `sessions` and
`file_touches` for what happened and where; `entities` + `project_entities` for the
groupings that sit between one project and everything.

The migrations are the best description of it — each one is commented with *why*, not
what. [`001_initial.sql`](./supabase/migrations/001_initial.sql) is the tracker;
[`013_knowledge.sql`](./supabase/migrations/013_knowledge.sql) onward is the memory layer.

## Backups

Cairn holds real work, so back up **both** halves — a database dump without the storage
tree loses every attachment, and the storage tree without the dump loses every reference
to those files.

```bash
export CAIRN_STACK_DIR=/srv/supabase/cairn      # holds the Supabase .env
export CAIRN_BACKUP_DIR=/srv/backups/cairn
export CAIRN_DB_CONTAINER=supabase-db           # default: supabase-db

./scripts/backup.sh          # nightly, from cron — 7 daily, 4 weekly
./scripts/restore-drill.sh   # weekly — actually restores and verifies
```

`restore-drill.sh` restores the newest dump into a throwaway database, asserts the data is
really there — including that the generated `search_vector` survived, which would otherwise
break prior-work discovery silently while everything else looked fine — then drops it. An
untested backup is not a backup.

## Trimming the Supabase stack

The upstream self-hosted compose starts eleven services. Cairn uses five: `db`, `auth`,
`rest`, `storage`, `api-gw`.

On a shared host the other six are not free — measured here, Studio, imgproxy, edge
functions, postgres-meta, realtime and the pooler burned **107% CPU between them, more
than the five actually in use**, while the app container itself sat at 0.00%.

Put them behind an `optional` profile in your Supabase stack's own compose file and the
stack's CPU drops by roughly 70%. Two `depends_on` edges have to be reset for that to
work: `api-gw` is ordered behind Studio, and `storage` behind imgproxy. Re-enable any of
them when a feature needs it:

```bash
docker compose --profile optional up -d realtime   # live sync
docker compose --profile optional up -d imgproxy   # image transforms
docker compose --profile optional up -d studio     # admin UI
```

## Contributing

Cairn is a personal tool published in the open; issues and PRs are welcome, but the
maintainer's own use drives the roadmap. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the
traps worth knowing about before you change something — Zod's `.partial()` and defaults,
IMMUTABLE generated columns, and the markdown round-trip in the editor.

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

CI runs all four. The domain vocabulary lives in
[`src/schemas/task.ts`](./src/schemas/task.ts) — types, statuses, priorities, note kinds
and resolution kinds are defined there once and flow into the API, the OpenAPI document,
the CLI and the UI.

## Licence

MIT
