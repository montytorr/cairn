# Contributing

Cairn is a personal tool published in the open. Issues and PRs are welcome; the
maintainer's own use is what drives the roadmap, so a feature may be declined simply
because it is not needed here.

## Running it

See [`README.md`](./README.md#self-hosting). You need Docker and a Supabase stack
(Postgres, Auth, Storage).

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs all four, plus a check that `AGENTS.md` stays under 8 KB — agents read that file
every session, so its size is a real cost.

## Things worth knowing before you change them

**Never derive an update schema with `.partial()` on a schema that has `.default()`.**
Zod wraps the default rather than replacing it, so the defaults still fire and every
PATCH silently overwrites fields the caller never sent. `src/schemas/task.ts` derives
create and update from a defaults-free base for exactly this reason, and
`src/schemas/task.test.ts` guards it.

**Generated columns must be IMMUTABLE.** `to_tsvector(text, text)` is only STABLE — use
`'english'::regconfig`. `array_to_string` is also only STABLE, which is why `labels` is
absent from the search vector.

**The editor must never save an unchanged body.** Markdown round-trips through
ProseMirror, so writing an untouched body can rewrite what an agent authored. See
[`docs/tiptap-markdown-spike.md`](./docs/tiptap-markdown-spike.md).

**The service-role Supabase client bypasses RLS.** Every query made with it must filter
by owner explicitly. RLS is the browser-side boundary and defence in depth, not what
protects server-side reads.

## Versions and releases

Semantic versioning, and pre-1.0: the schema, API and CLI are stable in practice but a
minor bump may still change them. Anything that breaks an existing install is called out
under **Breaking** in [`CHANGELOG.md`](./CHANGELOG.md), with what to do about it.

Cutting a release:

```bash
# 1. version in package.json AND in cli/cairn.mjs — a test fails if they disagree
# 2. move Unreleased into a dated section in CHANGELOG.md
npm test && git commit -am "release: v0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The CLI carries its own version number because it is copied onto machines rather than
installed from a registry — there is no package.json beside the copy in `/usr/local/bin`.
That makes it exactly the kind of constant that goes stale silently, so a test pins it,
and `cairn --version` asks the server as well and says when the two disagree.

`/api/v1/health` reports both: `version` is the release, `build` the commit it was built
from. The first tells a CLI whether it is out of step, the second tells you whether your
fix is actually live.

## Secrets

`.env*` is gitignored except `.env.example`, and GitHub secret scanning with push
protection is enabled. Do not add real hostnames, IPs or keys to committed files —
deployment specifics belong in a gitignored `docker-compose.override.yml`.
