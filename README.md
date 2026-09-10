# Cairn

**A self-hosted task tracker whose tasks double as shared memory for AI coding agents.**

A cairn is a stack of stones travellers leave to mark a path for whoever comes next. That
is the idea: agents add to the pile as they work, and anyone who follows — human or agent —
can read the trail instead of re-walking it.

> Status: in daily use, single-tenant. The schema, agent contract, API, CLI and UI are
> all in place. Multi-user is not: every RLS policy resolves to a single owner, so it is
> built for one person and their agents, not a team.

---

## Why

Task trackers record *intent* and throw away *knowledge*. A task closes as "done" and the
reasoning evaporates, so the next person re-debugs the same problem. That is tolerable on
a human team, where memory lives in people. It is fatal when the workers are AI agents
with no memory between sessions.

Cairn makes the tracker the memory:

- **Check before you start.** `cairn check "<subject>"` returns prior work on a subject —
  open and closed — so an agent learns what was already tried before spending a token on it.
- **Resolutions are mandatory.** Closing a task requires recording *how*. A closed task
  with no answer in it is invisible to everyone who comes later.
- **Dead ends are first-class.** An append-only work log captures attempts and findings as
  they happen. "Tried X, no difference" is worth as much as the fix.
- **Attributable.** Every write records which agent made it, so "who tried what, and did it
  work" is always answerable.

## Features

**Tracking**

- Projects and tasks with human-readable refs (`CAI-42`), per-project numbering
- Task **types** (`feature · bug · improvement · chore · spike · docs`) and a six-state
  workflow (`backlog · todo · doing · in-review · done · cancelled`)
- Priorities, labels, due dates, and blocked-by / blocks **dependencies** with cycle
  rejection
- Markdown bodies in a WYSIWYG editor, rendered with syntax-highlighted code, GFM tables
  and task lists; bare refs like `CAI-42` become links
- Comments for humans, an append-only work log for agents, and file attachments
- List and board views, bulk edit with shift-click ranges, a cross-project home, and
  live updates over SSE

**Memory**

- Postgres full-text search across titles, bodies, notes *and* resolutions, ranked in the
  database by `ts_rank` — closed work is included on purpose
- Results come back as an index with a `~tokens` estimate per row, so an agent can budget
  what it opens instead of pulling bodies it will never read
- Resolutions are mandatory on close, and carry a kind
  (`fixed · wont-fix · duplicate · not-reproducible · superseded · answered`)

**Coordination**

- A claim / heartbeat / checkpoint protocol so several agents can work a backlog without
  collisions, with lease stealing when a holder goes quiet
- Every write is attributed to the API key that made it
- REST API with hashed bearer keys, plus a CLI, an agent skill and an MCP server

## Agent access

Cairn is designed to be driven by agents, and ships three interfaces over one
implementation:

| Interface | For |
|---|---|
| `cairn` CLI | Anything that can run a shell command. The single implementation. |
| `SKILL.md` | Claude Code, Codex and OpenClaw — all three read skill folders |
| MCP server | Native tool-calling; a thin facade over the CLI, holding no logic |

Start with [`AGENTS.md`](./AGENTS.md) — it is the contract every agent should read.

## The CLI

One implementation, wrapped by the skill and the MCP server so behaviour cannot diverge.
Output is TSV by default — a `#count` line, a header row, then rows — with `--json` to
parse and `--pretty` to read.

| | |
|---|---|
| `cairn check "<subject>"` | **Start here.** Prior work on a subject, open and closed, with a `~tokens` cost per row |
| `cairn show <ref>` · `cairn list` · `cairn projects` | Read one, many, or the project index |
| `cairn add "<title>" --project K` | File work. Warns if something similar already exists |
| `cairn update <ref> --status S --priority P` | Change fields |
| `cairn done <ref> --resolution "…"` | Close. The resolution is required |
| `cairn cancel <ref> --resolution "…"` | Drop it, and say why |
| `cairn note <ref> "…" --kind attempt` | Append to the work log — `note · attempt · finding · decision` |
| `cairn log <ref>` | Read that log back |
| `cairn comment <ref> "…"` | Leave something for the human |
| `cairn attach <ref> <file>` · `cairn files <ref>` | Attachments |
| `cairn deps <ref>` | What blocks this, and what it blocks |
| `cairn blockedby <ref> <other>` · `cairn unblockedby` | Link and unlink |
| `cairn claim <ref>` | Take it. **Exit code 9** means another agent holds it |
| `cairn beat <ref>` · `cairn release <ref>` | Keep a claim alive, or drop it |
| `cairn checkpoint <ref> --summary "…"` | Where work stopped, for whoever resumes |
| `cairn block <ref> "<reason>"` · `cairn unblock <ref>` | Stuck on something outside Cairn |
| `cairn project rename\|delete <KEY>` | Deleting takes every task in it, and demands the key back |

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
/tasks/{ref}/attachments        upload; /attachments/{id} to fetch
/tasks/{ref}/dependencies       blocked-by / blocks
/tasks/{ref}/claim  /beat  /release  /checkpoint  /block
/keys  /keys/{id}               issue and revoke agent keys
```

Authenticate with `Authorization: Bearer sk_live_…`. Keys are stored as a sha256 hash —
the plaintext is shown once, at creation, and never again. Issue **one key per agent** so
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

Requires Docker and a Postgres/Supabase stack (Postgres, Auth and Storage).

```bash
git clone https://github.com/<you>/cairn.git && cd cairn
cp .env.example .env.local        # fill in your Supabase URL and keys
npm install
npm run db:migrate                # applies supabase/migrations/*.sql in order
npm run dev
```

To deploy behind a reverse proxy, copy the example compose file and adjust:

```bash
cp docker-compose.example.yml docker-compose.yml
# set CAIRN_DOMAIN and CAIRN_PROXY_NETWORK in your environment
docker compose up -d --build
```

The example assumes a Traefik instance already running on an external Docker network with
a Let's Encrypt resolver. Adapt the labels for nginx/Caddy as needed.

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
> configure it per environment at run time, they will be empty in the browser — Cairn
> passes them through a runtime provider instead, which is why the root layout is
> `force-dynamic`.

### A note on secrets

`.env*` is gitignored except `.env.example`, and `docker-compose.override.yml` /
`docker-compose.prod.yml` are gitignored so host-specific configuration stays out of the
repository. `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — keep it server-side only.

## Architecture

- **Next.js 16** (App Router) · React 19 · TypeScript · Tailwind v4
- **Postgres** via Supabase — Auth for the human login, Storage for attachments
- **Auth**: Supabase Auth session for the UI (enforced in middleware, server-side);
  hashed bearer API keys for agents, one key per agent
- **RLS**: every policy resolves to `projects.owner_user_id = auth.uid()`

See [`docs/`](./docs) for the design notes, and
[`supabase/migrations/001_initial.sql`](./supabase/migrations/001_initial.sql) — it is
commented and is the best description of the data model.

## Backups

Cairn holds real work, so back up **both** halves — a database dump without the storage
tree loses every attachment, and the storage tree without the dump loses every reference
to those files.

```bash
export CAIRN_STACK_DIR=/srv/supabase/cairn      # holds the Supabase .env
export CAIRN_BACKUP_DIR=/srv/backups/cairn
export CAIRN_DB_CONTAINER=supabase-db

./scripts/backup.sh          # nightly, from cron
./scripts/restore-drill.sh   # weekly — actually restores and verifies
```

`restore-drill.sh` restores the newest dump into a throwaway database, asserts the data
is really there (including that the generated `search_vector` survived, which would
otherwise break search silently), then drops it. An untested backup is not a backup.

## Agent setup

Three interfaces over one implementation. The CLI is the implementation; the skill and
the MCP server are thin wrappers, so behaviour cannot diverge between them.

```bash
# credentials — or export CAIRN_BASE_URL / CAIRN_API_KEY
mkdir -p ~/.cairn && cat > ~/.cairn/env <<'ENV'
CAIRN_BASE_URL=https://cairn.example.com
CAIRN_API_KEY=sk_live_...
ENV
chmod 600 ~/.cairn/env

install -m 755 cli/cairn.mjs /usr/local/bin/cairn
```

**Skill** (Claude Code, Codex and OpenClaw all read skill folders):

```bash
cp -r skills/cairn ~/.claude/skills/     # Claude Code
cp -r skills/cairn ~/.codex/skills/      # Codex
cp -r skills/cairn /root/clawd/skills/   # OpenClaw
```

**MCP** (optional — native tool-calling for Claude Code and Codex; OpenClaw reaches it
through `mcporter`). Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.cairn]
command = "cairn-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

Note Codex rejects a literal `bearer_token`; for an HTTP transport it wants
`bearer_token_env_var`.

Issue **one key per agent** so writes are attributable and any single agent can be
revoked without disturbing the others.

## Trimming the Supabase stack

The upstream self-hosted compose starts eleven services. Cairn uses five: `db`, `auth`,
`rest`, `storage`, `api-gw`.

On a shared host the other six are not free — measured here, Studio, imgproxy, edge
functions, postgres-meta, realtime and the pooler burned **107% CPU between them, more
than the five actually in use**, while the app container itself sat at 0.00%.

`docker-compose.cairn.yml` puts them behind a `optional` profile, which cuts the stack's
CPU by roughly 70%. Two `depends_on` edges have to be reset for that to work: `api-gw`
is ordered behind Studio, and `storage` behind imgproxy.

Re-enable any of them when a feature needs it:

```bash
docker compose --profile optional up -d realtime   # live sync
docker compose --profile optional up -d imgproxy   # image transforms
docker compose --profile optional up -d studio     # admin UI
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). In short: `npm run lint`, `npx tsc --noEmit`
and `npm test` all have to pass, and the domain vocabulary lives in
[`src/schemas/task.ts`](./src/schemas/task.ts) — types, statuses, priorities and
resolution kinds are defined there once and flow into the API, the OpenAPI document, the
CLI and the UI.

## Licence

MIT
