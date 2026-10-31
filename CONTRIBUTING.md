# Contributing

Cairn is a personal tool published in the open. Issues and PRs are welcome; the
maintainer's own use is what drives the roadmap, so a feature may be declined simply
because it is not needed here.

## Running it

See [`README.md`](./README.md#self-hosting). You need Node 22+, Docker and PostgreSQL 17+.

Cairn used to run on Supabase and no longer does — the runtime moved to the native
PostgreSQL driver, and `migrations/` used to be `supabase/migrations/`. If you find a
reference to Supabase that reads as a requirement rather than as history, it is stale and
a PR fixing it is welcome.

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm test
npm run build

# migrates a throwaway PostgreSQL in Docker (tmpfs, removed afterwards), then runs
# tests/integration/ — or point DATABASE_URL at one and run
# `npm run db:migrate && npm run test:integration`
npm run test:integration:local
```

CI runs all but the last, plus a check that `AGENTS.md` stays under 7900 bytes — agents
read that file every session, so its size is a real cost. It currently sits a couple of
bytes under, so adding a line there means cutting one: guidance with room to grow belongs
in [`skills/cairn/SKILL.md`](./skills/cairn/SKILL.md) instead.

The integration suite runs on your machine before merge, not in GitHub CI: it is the last
`.drove.json` check, after the build, and needs Docker. It migrates a clean PostgreSQL
first, which is the point of it: `tests/integration/` is the only execution-level proof
that the SQL does what the rest of the suite mocks. `vitals-closure.test.ts` in particular
checks queries no unit test can reach. It is easy to skip locally and easy to break, so run
it before a PR that touches `migrations/` or anything that queries them.

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

**A backfill must not advertise itself as user activity.** `tasks`, `projects` and
`task_comments` carry a `before update` touch trigger that sets `updated_at = now()` on
every row it sees. A migration that rewrites a column for bookkeeping therefore stamps
every row it touches as just-edited. Migration 049 qualified legacy actor ids across the
table and flattened `updated_at` on 3023 tasks to one timestamp, which destroyed recency
ordering and blinded every staleness view until it was repaired from a backup. Disable
the trigger around the statement, and turn it back on in the same transaction:

```sql
alter table tasks disable trigger tasks_touch;
update tasks set ... ;
alter table tasks enable trigger tasks_touch;
```

Nothing warns you: the migration succeeds, the data is correct, and only the timestamps
are quietly wrong.

**The knowledge map's layout must stay a pure function of the graph.** No `Math.random`,
no simulation in the browser — `src/lib/graph-layout.ts` seeds every position from a hash
of the slug and settles it on the server. Every view in this app re-renders through
`router.refresh()` when the live stream reports a change, which on a working day is every
few minutes, so a layout computed client-side rearranges the whole map under whoever is
reading it each time an agent writes a note. Animation is allowed and moves a node *around*
its anchor; nothing may move the anchor. `src/lib/graph-layout.test.ts` asserts two runs
agree, and `graph-view.test.tsx` asserts two renders are byte-identical.

**The `admin()` client bypasses RLS.** It is a PostgREST-compatible adapter over the
`pg` driver (`src/lib/db/client.ts`) and it connects as the owner, so every query made
with it must filter by owner explicitly — `.eq('owner_user_id', …)`, or through the
embedded relation for a join. RLS is the browser-side boundary and defence in depth, not
what protects server-side reads.

## Licence

Cairn is [MIT licensed](./LICENSE), and contributions are accepted under the same licence:
what you send in goes out under MIT. You keep the copyright in what you write.

## Credit

Contributions keep their authorship: a PR is merged rather than squashed into a
maintainer commit, so your commits stay yours in the history and in GitHub's contributor
graph. Anything that lands is credited by name and issue number in
[`CHANGELOG.md`](./CHANGELOG.md), and a report that leads to a fix is credited the same
way as a patch — finding the problem is most of the work.

## Versions and releases

Semantic versioning, and pre-1.0: the schema, API and CLI are stable in practice but a
minor bump may still change them. Anything that breaks an existing install is called out
under **Breaking** in [`CHANGELOG.md`](./CHANGELOG.md), with what to do about it.

Main deploys only under an untagged version or under a version whose tag has the same
tree as HEAD (including a merge with that tree).
The version must also be at least as new as the newest release tag.
Otherwise the deploy guard refuses: cut the next release with `drove release <next patch> --prepare`
in a Drove run or `node scripts/release.mjs <next patch> --confirm`, then publish it.

Cutting a release is [`scripts/release.mjs`](./scripts/release.mjs):

```bash
node scripts/release.mjs 0.6.0            # shows what it would do, writes nothing
node scripts/release.mjs 0.6.0 --confirm  # bumps both versions, closes the changelog,
                                          # commits and tags
```

It exists because the procedure lived in whoever remembered it, and it has two version
strings to keep in step — `package.json`, which the server reports, and the constant in
`cli/cairn.mjs`, which a copied CLI reports. It refuses to start if those two already
disagree, or if `[Unreleased]` is empty.

**It does not push.** Pushing a tag is a release, and that stays a decision: review the
commit, then push it and the tag yourself. Until the tag is pushed, `cairn setup` at the new
version cannot download its release files (`v<version>` on GitHub); `install.sh` takes the
CLI from the latest *published GitHub release*, so it moves on only once that exists.

**Publishing the release moves `production`.** The `production` workflow fast-forwards the
`production` branch to the tag as soon as a (non-pre-)release is published, and refuses a tag
that does not descend from it. Nobody pushes `production` by hand. It is what downstream
installs follow: a downstream mirror can merge it every morning and deploy when it moved. `main`
keeps deploying our own instance on every merge, so a merge reaches a downstream only once
it is released. To re-point it by hand, run the workflow with a tag
(`gh workflow run production.yml -f tag=v0.14.3`).

The CLI carries its own version number because it is copied onto machines rather than
installed from a registry — there is no package.json beside the copy in `/usr/local/bin`.
That makes it exactly the kind of constant that goes stale silently, so a test pins it,
and `cairn --version` asks the server as well and says when the two disagree.

`cairn --version` is also the one command an agent has no reason to run, so every API
response carries the release as an **`x-cairn-version`** header — `src/lib/api/response.ts`
sets it on `ok()` and `fail()` alike. The CLI compares it against its own constant once per
process and warns on **stderr**, never stdout, because callers parse stdout. That turns a
stale copy from something found by accident into something that announces itself on the
next ordinary call.

`/api/v1/health` reports both numbers: `version` is the release, `build` the commit it was
built from. The first tells a CLI whether it is out of step, the second tells you whether
your fix is actually live.

## Secrets

`.env*` is gitignored except `.env.example`, and GitHub secret scanning with push
protection is enabled. Do not add real hostnames, IPs or keys to committed files —
deployment specifics belong in a gitignored `docker-compose.override.yml`.
