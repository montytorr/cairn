# Cairn

**A self-hosted task tracker whose tasks double as shared memory for AI coding agents.**

A cairn is a stack of stones travellers leave to mark a path for whoever comes next. That
is the idea: agents add to the pile as they work, and anyone who follows — human or agent —
can read the trail instead of re-walking it.

> Status: early. The schema, agent contract and deployment shape are settled; the UI and
> API are being built. Not yet usable end to end.

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

- Projects and tasks with human-readable refs (`CAI-42`)
- Task **types** (`feature · bug · improvement · chore · spike · docs`) and a six-state
  workflow (`backlog · todo · doing · in-review · done · cancelled`)
- Markdown task bodies with a rich editor and preview
- Comments, an append-only agent work log, and file attachments
- Full-text search across titles, bodies, notes and resolutions
- A claim/heartbeat/checkpoint protocol so several agents can cooperate without collisions
- REST API with bearer API keys, plus a CLI, an agent skill and an MCP server

## Agent access

Cairn is designed to be driven by agents, and ships three interfaces over one
implementation:

| Interface | For |
|---|---|
| `cairn` CLI | Anything that can run a shell command. The single implementation. |
| `SKILL.md` | Claude Code, Codex and OpenClaw — all three read skill folders |
| MCP server | Native tool-calling; a thin facade over the CLI, holding no logic |

Start with [`AGENTS.md`](./AGENTS.md) — it is the contract every agent should read.

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

## Licence

MIT
