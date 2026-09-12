# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [Unreleased]

## [0.1.0] — 2026-09-12

First tagged release. Cairn has been in daily use since 2026-09-10; this is the point at
which it became something somebody else could reasonably run.

### The tracker

- Projects, tasks, sub-tasks, dependencies, labels, comments and attachments.
- A work log per task — `note · attempt · finding · decision · handoff` — so what was
  tried survives whether or not it worked.
- **Closing requires a resolution.** The API refuses a terminal status without one, which
  is the rule the rest of the value rests on.
- Claims with a lease, so several agents can work without colliding, and a heartbeat that
  says a claim is still alive.
- List, board and cross-project board views; keyboard-first; dark and light.

### The memory

- Four stores — tasks, notes, knowledge, sessions — and one verb, `cairn check`, that
  searches all four in a single pass. Two-pass full-text search, precise then widened.
- **Knowledge** outlives the task that produced it, scoped to a project, to an entity, or
  to everything, and corrected rather than appended to.
- **Sessions** are written when a session ends, without being asked: Claude Code through
  `SessionEnd`, Codex and OpenClaw by reading the rollouts they leave behind.
- A file index, so opening a file can say what is known about it.

### Agents

- REST API with an OpenAPI 3.1 document generated from the same Zod schemas the routes
  validate against, browsable at `/api-docs`.
- A dependency-free CLI — Node's built-in `fetch` is enough — that can be dropped onto a
  box and run.
- A skill for Claude Code, Codex and OpenClaw, and three hooks that brief a session at
  its start, say what is known about a file when one is opened, and record the session
  when it ends.
- **One key per runtime.** The key is the identity, so a key shared between agents makes
  their work indistinguishable afterwards.

### Operations

- Docker image, compose example and Traefik labels; migrations applied on deploy.
- `/api/v1/health` reports the version and the commit it was built from.
- `/api/v1/vitals` and the Vitals page answer whether the memory is still being
  written — sessions recorded, work opened against closed, agents that have gone quiet.
- Optional scheduled jobs: release abandoned claims, repair drifted agent files, report
  vitals, sweep transcripts from runtimes that have no session-end event.
- Backup and restore-drill scripts, because an untested backup is not a backup.

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
