# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [Unreleased]

### Added

- **Vitals can see what it was blind to** (CAIRN-288). The CAIRN-282 audit found every vitals
  number correct and the panel green while 17 of 22 claims had been quiet for over 20h, the
  reaper had released nothing for 13 days, the summariser wrote 1 of 16 sessions, and codex and
  openclaw's scheduled runs had stopped. `cairn_vitals_signals` (migration 065, a new function
  beside `cairn_vitals`, not another rewrite of it) adds: claims with no genuine activity for
  more than 2h / 24h and the quietest ten (`task_genuine_activity_at` is the one definition of
  liveness: claim, heartbeat, note, activity event or a hand-written checkpoint, never
  `updated_at` or a session-end auto-checkpoint); reconcile releases in the window and in 7
  days, plus the maintenance identity's last write; sessions and summarised share per runtime
  and host; runtimes and writers absent for the window and the week before; knowledge never
  verified or not in 30 days (informational). New findings: `claims-quiet`, `reaper-idle`
  (alarm, reaches the banner), `maintenance-silent`, `summariser-degraded`, `runtime-quiet`,
  `runtime-absent`, and `signals-unavailable` when the function cannot be read. The
  summariser's own `claude -p` runs no longer count as sessions. The health banner now says
  "vitals unavailable" instead of rendering nothing when vitals cannot be read, and the Vitals
  page renders what it could read when one of its three aggregates fails.

- **How often each fact is actually recalled** (CAIRN-270). 053 recorded which entries every
  search returned and every direct read by slug, and nothing read either per entry.
  `knowledge_recall_counts` (migration 061) does: `cairn know` lists gain a `recalled` column
  (last column, 30 days), the knowledge page says "recalled N× in 30 days", and `cairn know
  --unused [--days N]` (`?unused=N`, MCP `cairn_know unusedDays`) lists current entries nobody
  was given in that window, never-recalled first — dead, or titled so no search finds them.
  The session briefing and `cairn recall` record nothing, so they are not counted, and every
  surface says so. `--unused` reads `knowledge_recall_state` (migration 062), kept current by
  triggers on the telemetry tables and backfilled once; a recall never writes a knowledge row,
  so it never changes `updated_at`. The query merges two index-driven halves, never-recalled
  and least-recently-recalled, each cut at the limit. Its cost grows with the number of current
  entries in the worst case (when nearly all have been recalled, finding the never-recalled ones
  walks the corpus), never with recorded search and read history.

- **`cairn recall <ref>`: what already bears on this task, and why** (CAIRN-268). `check`
  answers from a phrase; this starts from the task. Decisions: resolutions and
  decision/finding notes on tasks that name it (with the note that does, excerpted around the
  name), tasks it names, its parent, sub-tasks, blockers, and answered tasks with a similar
  title. Knowledge: current entries linked to files it touched, learned on it or a related
  task, or matching its terms within its project, with their stale mark. Every line carries
  `why`. `GET /api/v1/tasks/{ref}/recall`, MCP `cairn_recall`, and `cairn claim` now prints
  the top three of each on stderr — the recall an agent does not think to run is the one that
  catches a closure elsewhere saying "do not read this as permission for this task". Built on
  the mentions of CAIRN-267 and the file links of CAIRN-269.

- **Which files a fact is about is stored, and can be asked backwards** (CAIRN-269).
  Staleness worked out a fact's files at read time and nowhere else, and "what do we know
  about this file" read `file_touches.knowledge_id`, which nothing ever wrote — so `cairn
  context --file` never returned knowledge. `knowledge_files` (migration 060) now holds the
  links: backticked paths in the body and the files the source task or session touched, both
  kept by trigger and backfilled, plus files named with `cairn learn --files a,b` / `relearn
  --files` (`files` on the API, `files` on the MCP tools). `context --file` finds knowledge
  by path or basename, and staleness ages a fact on its explicit files too. Links are not
  written to `file_touches`: that table is a log of touches, and an anchor there would read as
  every other fact about the same file having been reworked.

- **A task knows where else it was named** (CAIRN-267). Agents write refs into notes all the
  time, and they only ever pointed one way: BB-343's finding said its closure must not be
  read as permission for BB-333, and `cairn show BB-333` said nothing about it. Every
  resolvable ref in a note, comment, description or resolution is now indexed in
  `task_mentions` (migration 059, filled by triggers and backfilled from everything already
  written), through retired keys too. `cairn show` carries the first five as `mentionedIn`
  — decisions, findings and resolutions first — `show --full` adds `mentioned_in`, `GET
  /api/v1/tasks/{ref}/mentions` lists them all, and the task page shows a "Mentioned in"
  section. Only refs that resolve to a task count, so `UTF-8` and `HTTP-404` do not; a task
  naming itself does not either. An edited description stops claiming a ref it dropped.

- **A knowledge correction keeps what it corrected** (CAIRN-266). `relearn` was a plain
  UPDATE: the previous title, body, labels and scope were gone for good, `actor_id` went on
  naming the first author, and the feed credited every later correction to them. Each edit
  that changes an entry's content, scope or supersession now stores the version it replaced
  in `knowledge_revisions` (migration 058), with who replaced it, when, and an optional
  reason — `cairn relearn --reason`, `cairn unlearn --superseded-by X --reason`, and
  `reason` on `PATCH /api/v1/knowledge/{slug}`. Read it back with `cairn know <slug>
  --history [--full]`, `GET /api/v1/knowledge/{slug}/history`, the MCP `cairn_know
  history` flag, or the "earlier versions" list on the knowledge page. A `verify`, and a save
  that changes nothing, are not new versions. The feed now shows a revised entry as written
  by its author and then each correction by its editor; entries never revised read exactly
  as before.

- **A project key rename is told, not only resolved** (CAIRN-264). AC was renamed HOL and
  ACC HOLC on 2026-09-22. CAIRN-125 had already made the old refs resolve, and they did —
  which is the problem: `cairn show AC-113` printed HOL-113 and said nothing, so an agent
  whose commit message said AC-113 could not tell it had the same task. Anything reached
  through a retired key now says how. `GET /tasks/{ref}` adds `requested_ref` and
  `renamed_from: { key, to, at, by }`; the CLI prints `AC-113 is now HOL-113 — project AC
  was renamed HOL on 2026-09-22` on stderr before the task, and `cairn check "AC-113"`
  does the same for its exact-ref hit (`requestedRef`/`renamedFrom` on that row). A current
  ref changes nothing. The MCP facade now returns the CLI's stderr ahead of its stdout, so
  an MCP caller is told too — it used to get stdout alone, and with it none of what the CLI
  says *about* an answer.

- **`cairn project rekey <KEY> <NEW>`**, also spelled `cairn project rename <KEY> --key
  <NEW>` as `entities rename` does (CAIRN-264). The API has always accepted a key change and
  the CLI never offered one, so the one rename that rewrites every ref was the one only
  reachable by a hand-written PATCH. It prints what it did, and that the old refs keep
  resolving and the old key cannot go to another project.

- **Former keys are listed** (CAIRN-264). `GET /projects` and `/projects/{key}` carry
  `former_keys: [{ key, retired_at, retired_by, new_key }]`, and `cairn projects` shows them
  in a `was` column. It is the last column on purpose: `cairn projects` is parsed by header
  (trig's connector reads it), and a column appended at the end is one no reader sees move.

- **The briefing names a held task by the ref it had, for a month after a rename**
  (CAIRN-264): `HOL-113 (was AC-113)`, only for keys retired after the task was filed and
  within 30 days. A checkout still mapped to the old key gets a line saying so, and
  `cairn map` warns about every mapping that names a retired key and what to map instead.

- **Who retired a key, and what it became** (CAIRN-264, migration 057).
  `project_former_keys` gains `retired_by` and `new_key`, which `project_rename_key` fills
  from now on; until now the actor lived only in the activity event, and for a project
  renamed twice nothing said that AC had become HOL rather than today's key. Backfilled from
  the `project_key_changed` events where they exist, and `new_key` from the order of
  retirements where they do not; `retired_by` is left empty rather than guessed. Both
  functions 057 touches are edited from their installed definitions, not re-copied — see
  `never-rebuild-a-sql-function-by-copying-an-older-migration-s-body`.

- **The web app says when a project key changed** (CAIRN-264). CAIRN-125 made AC-113 keep
  resolving after AC became HOL, and it did — silently, so someone holding AC-113 from a
  commit message landed on a page reading HOL-113 with nothing to say it was the same task.
  An old task address now redirects with a notice, *"AC-113 is now HOL-113 — project AC was
  renamed HOL on 22 Sept 2026."*, and the marker it rides on is dropped from the address bar
  so a copied link stays clean. `/projects/AC` was a 404 and now redirects the same way. The
  projects list and the project header show `formerly AC · 22 Sept 2026`, and the activity
  feed links a project event to its project instead of to nothing, with a sentence in place
  of the blank title a key change used to render.

- **A project key can be changed from the web app** (CAIRN-264). The API always could and
  nothing else could, so the edit most in need of explaining was the one nobody saw
  explained. *Change key…* in the project menu, and the key button on the projects page,
  open a dialog that says the two things a reader cannot guess — old refs keep working, and
  the old key is spent for good, because another project taking it would make its refs lead
  to two tasks — and checks the API's rules while typing, including a key another project
  retired. Creating a project refuses a retired key up front for the same reason, rather than
  after the server does.

### Fixed

- **The session-end checkpoint stops destroying handoffs and keeping dead claims alive**
  (CAIRN-283). It wrote onto every task the agent's label held, replacing whatever was there:
  28 real checkpoints were overwritten with "Still held, not progressed…", BB-385's among
  them. Now a claim naming another session is never touched, a task the session only held is
  written only when it has no checkpoint at all, and a written checkpoint is replaced only on
  a claim that provably belongs to this session. The write goes through
  `auto_checkpoint_task_atomic` (migration 063), which loses to a concurrent deliberate
  checkpoint, leaves `updated_at` alone and records an `auto_checkpointed` event. Reconcile no
  longer reads the "still held" checkpoint as a sign of life, and the close dialog no longer
  offers automatic text as the resolution.

- **The claim reaper releases quiet claims again** (CAIRN-284). The scheduled `reconcile` runs
  as the `maintenance` key, and reconcile only ever looked at the caller's own claims, so it had
  released nothing since 2026-09-12. Under the `maintenance` key (from the key row, never the
  display name) it now covers the whole workspace; any other agent's still covers its own. A
  quiet `doing` task goes back to `todo`, `in-review` keeps its status. `cairn release` now
  moves a held `doing` task back to `todo` too, and both releases clear `claimed_session`.

- **Both boards stop at the viewport and scroll per column** (CAIRN-277, CAIRN-278). `/board`
  and a project's Board view grew with their tallest column, so the page scrolled as a whole
  and the toolbar and column headings scrolled away with it. Each column is now a panel as
  tall as the board with its own scroll; the drop target is the scroll box, so a column
  scrolled halfway still takes a drop anywhere on screen. With swimlanes, each lane cell is
  capped (`min(26rem, 55dvh)`) and scrolls on its own while the board scrolls through the
  lanes; the column headings are drawn once and stick, lane names stick to the left when
  scrolled sideways, and a lane collapses from its name. Both boards share
  `src/components/board-columns.tsx`, and the project board gained keyboard dragging.

- **A board no longer hydrates as a different board** (CAIRN-277, CAIRN-278). `/board`
  parsed its view from `window.location`, so the server rendered the default view for a link
  like `?swimlane=agent`; the project page read List/Board from localStorage, so the server
  always rendered the list. Both then re-rendered on hydration. The board's query now comes
  from the server's `searchParams`, and the project view choice is a `cairn-view-<KEY>`
  cookie (an existing localStorage choice carries over once). dnd-kit's
  `aria-describedby` counter mismatch is gone too, via a fixed `DndContext` id.

- **Search says what its number means** (CAIRN-280). Every unified result ended in `~19`,
  which read as a minus sign and a mystery. It is the rough token cost of reading the result
  — what `cairn check` prints — and now reads `~19 tok`, with a tooltip, hidden when zero.
  Result rows keep a full-width rule but cap their content at a readable width.

- **`--project <retired key>` answers for the project it became** (CAIRN-264). Every place
  that turned a key into a project matched it as a string, so after AC became HOL, `cairn
  list --project AC` said "No project AC." and `cairn next --project AC` said "nothing open"
  about a project with open work — the second one reading as true. One resolver
  (`resolveProject`, `liveProjectKey` in `src/lib/api/project-keys.ts`) now backs the
  project routes, task list and create, repos (`cairn map`), `next`, `context`, `search`,
  `activity`, `knowledge`, `sessions`, the live-update stream, moving a task, `alsoProjects`
  and entity membership. Each answers for the live project and carries `renamed_from`, and
  the CLI prints `note: project AC is now HOL` once on stderr.

- **Project renames have a title in the activity feed** (CAIRN-264, migration 057).
  `project_key_changed` and `project_renamed` were recorded with their actor and from/to and
  rendered blank, because `activity_feed` titled events from `data.title` and `data.key`
  only. They now read `AC → HOL` and `A2A comms → Holloway`, with the project's live key as
  `project_key` and `ref` to link through.

- **An old ref is never claimed for a task filed after the rename** (CAIRN-264). HOL-114
  was filed after AC became HOL, and the task page said it had been AC-114 — a ref nobody
  ever wrote down. `GET /tasks/{ref}` now carries `former_refs`, which only lists keys
  retired after the task was created, and `AC-114` is a 404 that says `AC-114 was never
  issued. Did you mean HOL-114?` rather than silently answering with a task it never named.

- **The "(was AC-n)" label no longer invents refs, and no longer hides** (CAIRN-264). It
  claimed HOL-114 "was AC-114" although HOL-114 was filed after AC was retired, so that ref
  never existed; it now only names keys retired after the task was created. It was also
  hidden on a phone and whenever the task had an `external_ref` — which is every task in a
  project imported from Linear, the case that exposed this — and is now shown on every width,
  beside the imported ref rather than instead of it, with the rename and its date on hover.

### Changed

- **Settings has the header bar every other page has** (CAIRN-279), and its Password
  heading matches Labels and Entities instead of being the one uppercase eyebrow.

- **`GET /next?project=` with a key that names no project is a 404** instead of "nothing
  open" (CAIRN-264). Silence was the answer for a typo and for a renamed project alike, and
  it read as true for both.

## [0.6.0] — 2026-09-22

### Added

- **A CLI can tell whether it is the current file, not just the current release**
  (CAIRN-261). CAIRN-246 put `x-cairn-version` on every response so a drifted copy would
  say so, and it worked exactly as designed — which turned out to be almost never.
  Releases are cut by hand and 133 commits fitted inside v0.5.1, so nearly all real drift
  is *intra*-version: a laptop copy was two features behind, missing `--allow-dangling` on
  `relearn` and the whole vitals memory block, while both sides reported 0.5.1 and no
  warning was possible. Every response now also carries **`x-cairn-cli`**, a 16-hex sha256
  of the `cli/cairn.mjs` the deployment was built from, and the CLI hashes its own file
  once per process — 0.049 ms, measured, for the 100KB it weighs — and compares. A content
  hash is the only identifier a copied CLI can work out about itself: there is no
  repository behind `~/.local/bin/cairn`, which is the constraint that made a version
  constant the easy choice in the first place. It is the same digest
  `scripts/sync-agent-files.mjs` prints, so the installer's log line and the header are
  one string for one file. `/api/v1/health` now goes through `ok()` so that it carries the
  headers too — it is the endpoint `cairn --version` calls, and it was the one route whose
  whole job was answering "am I current?" that could not. If the server sends no
  fingerprint the CLI says nothing; the check is an improvement on silence, never a
  dependency.

- **`search_tasks` stops suppressing its own fallback** (CAIRN-260, migration 056). 055
  fixed `search_all` and deliberately left this one alone, because extending an unscored
  change to a second function is how you ship something and never learn whether it helped.
  It has now been scored both ways, on the same store in the same instant, by applying the
  migration inside a transaction and rolling it back (`scripts/ab-search.mjs`). The
  evaluation set says the change costs almost nothing and buys almost nothing: recall@20
  0.933 either way, MRR 0.717 → 0.706, one case down three places and two up one. Real
  traffic says the opposite, because the suppression never fires on any case in the set. Of
  23 natural-language task searches in 90 days, 3 did not widen — and all three are
  transformed: *"claim on note annotation vs work"* returned a Queue-it pause, an algorithm
  port, an incident and a Flashbuy crash, and now returns *"Auto-claim on note cannot tell
  annotating a task from working on it"* at rank 1. So: one answered question loses three
  places, in exchange for the questions that were not answered at all, and `cairn check
  "x"` and `cairn check "x" --tasks` stop ranking by different rules.

- **The retrieval evaluation set records the invocation it was scored under** (CAIRN-259).
  `tests/fixtures/search-eval.json` recorded the query and the expected rows but not the
  scope, and the scope decides the answer — the same question returns a different ordering
  under `--project` and `--kinds`, so two people re-scoring the file got different numbers
  and neither was wrong. Every case now carries a `scope`, `scripts/score-search-eval.mjs`
  reads it rather than a human re-deriving it, and the recorded baseline carries a
  timestamp, the server build, the CLI version and the size of the store. The last part is
  not bookkeeping: the previous baseline recorded 0.73 and gave 0.82 on a re-run the same
  day, with no code change, because the store had grown — a number with no provenance
  cannot tell a retrieval change from a Tuesday.

- **The agent files are repaired on merge, not only on the hour** (CAIRN-257). Cairn's code
  is push-based — merge to `main`, GitHub Actions deploys — while the skill, CLI and hooks
  every agent reads are pull-based, repaired by an hourly cron. Two clocks, and the slower
  one is the one agents read from: merged at 16:14 with the previous sync at 15:23, every
  agent on every machine spent 51 minutes reading a `SKILL.md` that contradicted the code
  already live, and up to 59 in the general case. That day the contradicted sentence was
  the one that merge had just fixed, so the window reproduced CAIRN-250 on an hourly cycle.
  The deploy now runs the same job the schedule runs, the moment it has finished deploying:
  `install-cron.mjs --run agent-files` reads the command back out of the installed crontab
  block (or LaunchAgent) rather than restating it, because which copies a host has —
  `--also skill=<another account's tree>` — is a fact about that host, and a second copy of it
  would be the next thing to drift. Two overrides and only two: `--source`, so the deploy
  syncs from the tree it just deployed rather than the CDN-cached raw URL, which seconds
  after a merge can still be serving the previous `main`; and `--no-notify`, because a
  repair is the expected outcome of this path and one note per merge would bury the
  schedule's notes, which mean a runtime was reading a stale copy until now. **The hourly
  job stays**, as the fallback for a machine that was powered off or a merge that never got
  there — and its notes now carry a sharper meaning, namely that the trigger did not
  arrive. The step cannot fail the deploy: a stale skill is a problem, a failed deploy is a
  bigger one. It needs one sudoers line on the box, pinned whole rather than by wildcard,
  and warns rather than failing where that line is absent.

- **The CLI refuses a flag it does not implement, instead of ignoring it.** `cairn know
  --banana split` returned results and exited 0: any flag was accepted and unknown ones
  were dropped in silence, so a caller who mistyped a filter — or reached for one that
  does not exist — got a full unfiltered answer that looked exactly like a filtered one.
  The case that found it was `--offset`, which is not implemented and not in help, so an
  agent paginating with it got page one forever. A connector built against this CLI could
  only ever reach 200 knowledge entries, and noticed only because it counted. Unknown
  flags now exit 2 naming the flag, with a near-miss suggestion (`--limt` → `did you mean
  --limit?`). The first version of the list was enumerated by grepping `flags.X`, which
  misses every flag read dynamically, and it broke `cairn add --priority high` — a flag
  the CLI's own help documents. The list is now built by hand and guarded by a test.

- **`cairn learn` refuses a `[[reference]]` the store can almost resolve, and says what it
  should have said** (CAIRN-253). 70 of 579 references in the corpus pointed at nothing, and 44
  of those named a fact Cairn already holds under a different slug — `capsolver-akamai-bug`
  where `capsolver-akamai-script-bug` exists — so two thirds of the "missing knowledge" was a
  recall miss rather than a gap. Nothing checked `[[...]]` at write time; dangling links
  surfaced only in a diagnostic nobody is obliged to run, which is how 70 accumulated. A write
  is now refused when a close slug exists — the same name modulo a type prefix, or one name
  containing the other whole — and the refusal names the candidate, because there is nothing to
  override in that case. It is accepted with a warning when nothing close exists: that is the
  genuinely unwritten fact, and the structural case that two entries citing each other cannot
  both be written first. A task ref in wiki brackets (`[[dis-2129]]`) is refused by shape with
  "write it bare", since it names an entry that will never exist. `--allow-dangling` on the CLI,
  `"allowUnresolvedRefs": true` on the API, is the deliberate way past, so recording a reference
  as it stands is a claim somebody made rather than a default nobody noticed. The CLI now prints
  the unresolved list and its suggestions — `request()` printed `error` alone, so the
  suggestions were computed and thrown away. Prefix tolerance deliberately does not live in
  `normalizeSlugRef`: folding `project-` in there would make `project-x` and `x` the same
  identifier, and the store holds both. A `[[ref]]` quoted inside an inline code span no longer
  counts as an edge, so the diagnostic and the rendered page agree. This stops new ones; the
  existing 44 are untouched.
- **The same check runs on `PATCH /api/v1/knowledge/{slug}`.** Without it the whole thing was
  reachable in one hop: write a clean entry, then edit a dangling reference into it with nothing
  looking. A request that does not change the body is not re-checked, so a rename or a
  `--verified` does not fail on a reference the entry has carried for weeks.
- **Every API response carries `x-cairn-version`, and a CLI that has drifted says so**
  (CAIRN-246). `cairn --version` could always answer this, but it is the one command an agent
  has no reason to run, so a stale copy goes on working — just not the way the docs say. One
  install here was found only because `cairn vitals` happened to come back "unknown command",
  after a day of writes recorded under the wrong identity. The header is set at `ok()` and
  `fail()`, and the CLI compares once per process and writes the mismatch to stderr, never
  stdout: callers parse stdout, and a warning in it is a bug. Silent when the header is absent,
  so it degrades quietly against an older server.
- **`GET /api/v1/vitals` returns a `memory` block, and `cairn vitals --all` prints it**
  (CAIRN-254). Whether agents consult the memory was already measured and was visible only on a
  page in a browser — the one place the population it measures cannot look, which is the same
  failure the knowledge-gaps route names in its own header, one panel over. The block rides
  along on the same window as the counts: searches, how many widened, how many came back empty,
  how many tasks were filed without checking first, and the recent misses. It degrades to `null`
  rather than taking the monitor down when the aggregate cannot be read.
- **Knowledge recall is recorded, not just knowledge volume** (CAIRN-254, migration `053`).
  `search_events` has answered "was the memory consulted" since migration `024`, and nothing
  answered "did it give back the right thing": results were counted and never identified, and
  `cairn know <slug>` — the single path that most directly means an agent called knowledge when
  it needed it — recorded nothing at all, because `recordSearch` only ever fired from
  `/api/v1/search`. A `knowledge_reads` table now records actor, slug and hit on every read of
  `GET /api/v1/knowledge/{slug}`, and the miss is written as a row *before* the not-found
  return, because a miss on a guessed slug is a dangling reference followed live and an absence
  cannot be counted. `search_events.returned_slugs` records which entries a search actually
  returned; it is nullable with no default on purpose, so `NULL` means the row predates the
  column and `{}` means the search returned nothing — defaulting to `{}` would have rewritten
  every historical row into a claim nobody made. A separate table rather than a reused one,
  because pooling would corrupt the three numbers `search_events` exists to produce: `widened`
  is meaningless for a slug lookup, `zeroResults` means the opposite on the two paths, and
  `result_count` is only ever 0 or 1. `cairn_memory_use` reports both, and
  `tasksFiledWithoutChecking` unions them — looking a fact up by name is checking.
- **`scripts/release.mjs` cuts a release** (CAIRN-248). The process lived in whoever remembered
  it, and it has two version strings to keep in step by hand: `package.json`, which the server
  reports, and the constant in `cli/cairn.mjs`, which a copied CLI reports. Forgetting the
  second fails in the direction that reassures — every stale install then agrees with a server
  that has moved on, disarming the header above. The script bumps both, closes `[Unreleased]`
  into a dated section, commits and tags, and refuses to start if the two strings are already
  out of step. It does not push: pushing a tag is a release, and that stays a decision. A test
  asserts the two versions match.
- **One mark across both Cairn sites, and a social card** (CAIRN-249). The two properties
  carried different artwork, and this one had no opengraph image or metadata at all, so every
  link pasted as a bare URL. `icon`, `apple-icon` and `opengraph-image` now share the cloud's
  palette and geometry with the stones solidified — at a true 16px the outlined version fills in
  and the three stones fuse into one shape — and `openGraph`/`twitter` metadata is set.
  `metadataBase` reads `CAIRN_BASE_URL` rather than hardcoding a domain, because this repo is
  meant to be self-hosted.
- **The skill says when *not* to reach for Cairn, and no longer tells agents a note claims a
  task.** `skills/cairn/SKILL.md` carried one line of negative guidance and a frontmatter
  description of eleven positive triggers with no boundary, so it fired on anything task-shaped
  (CAIRN-245); the new section sits before the lifecycle rather than after it, and its test is
  durability rather than size — a one-line fix that lands in the repo gets a task, an afternoon
  of reading that changes nothing does not. The file also contradicted itself 123 lines apart
  (CAIRN-250): the sweep section said a note does not claim, and a bolded "You do not have to
  remember" said it does. The second is pre-CAIRN-146 wording, and it is the half that wins,
  because it is written to reassure and therefore to be believed — an agent trusting it
  concludes that noting is enough and never claims, which is the behaviour the surrounding
  paragraph complains about. `claim.ts` and `AGENTS.md` have had it right since CAIRN-146; the
  skill never caught up. A checkpoint still claims an unheld task; a note still does not.
- **`--mine` answered "this human's agents" while reading like "this session".** The CLI
  guessed the caller from a `CAIRN_AGENT` environment variable and sent
  `claimed_by=$CAIRN_AGENT` — and when that variable was unset it sent an empty string,
  asking for tasks held by nobody and getting back an answer that looked like an answer. The
  server resolves it now, because only the server knows who is asking, and narrows to the
  caller's session when there is one. A claim that names no session is still yours, on the
  same rule the release guard and `cairn next` follow: cannot tell must not become not
  yours.
- **`cairn next` offered another session's live claim as "you are holding this one".** It
  compared `claimedBy` alone, and that is an actorLabel every Claude Code session on a
  machine shares — so a sibling's claim was not merely left unskipped, it was promoted to
  the top of the list with "finish it or hand it back". A session working on a trading bot
  was told to finish a knowledge-map task it had never opened. The comparison now includes
  the session on both the skip and the tier, so a live claim from another session is passed
  over exactly as any other agent's would be, and a stale one still surfaces as the
  abandoned work it is.
- **A session's closing summary could be recorded against tasks it never touched.** The
  session-end hook filtered its breadcrumbs by time and directory and, when no breadcrumb
  matched the directory, fell back to *every task any session wrote in that window*. Its
  last resort was worse: task references regex-matched out of conversation prose, so
  discussing a task counted as working it. CAIRN-209 — a task about label collision on the
  knowledge map — is carrying a progress report about three unrelated pull requests, and two
  more carry a checkpoint about a task in a different product. Breadcrumbs now record the
  session that wrote them and are filtered on it exactly, with no fallback to the window:
  a session row with no task links is a small loss, a session row attached to someone
  else's task is a wrong record that later readers believe. Bare prose mentions no longer
  count as work at all.
- **A claim now says which session holds it, not just which human.** `claimed_by` is a label
  like `claude-code · cal@example.com`, and every Claude Code session on a machine writes
  exactly that — four run here at once. The claim itself was never the broken part; the
  things around it were. `release` matched on the label and would drop another session's
  claim silently, `--mine` answered "this human's agents" while looking like "this session",
  and the session-end hook stamped its checkpoint onto every task the *label* held, so one
  session's afternoon landed on another's tasks. Nobody could answer "which session is
  holding this", which cost a duplicated implementation the day this was written. The CLI
  now sends its session id (`CAIRN_SESSION_ID`, or `CLAUDE_CODE_SESSION_ID`, which Claude
  Code already exports), releasing another session's claim requires `--force`, and a claim
  that names no session behaves exactly as before — because "cannot tell" must not become
  "not yours".
- **Vitals counts the work nobody could see was happening.** CAIRN-135 measured that 36% of
  closed tasks had never been claimed, shipped auto-claim on checkpoint, and that number then
  had no reader — nothing recomputed it, so nobody would have known if it went back up. `cairn
  vitals` now reports when a quarter or more of the tasks closed in the window went from filed
  to closed with *nothing at all* recorded in between: no claim, no checkpoint, no commit, no
  push, no run result, and no status move off the status the task was filed in — and with the
  close itself made by a runtime, because a person is documented as never claiming and
  `claim.ts` refuses to claim on their behalf, so counting their closes measures the design
  rather than a lapse. The transition that closes the task is not evidence, since every close
  writes one; without that carve-out the count would be permanently zero and look like a fix.
  That is a strictly narrower question than *was this ever claimed*, which is what this check
  asked in its first, unreleased form: a task that moved to in-review hours earlier with commits
  and test runs against it was not invisible while it was being worked, whatever the claim log
  says, and a claim is one way of being visible rather than the only one. A floor of five closed
  tasks, so a small week is not mistaken for a pattern. Not an alarm, and deliberately not auto-
  claim on close: CAIRN-146 rejected inferring intent from an ambiguous signal, and closing is
  at least as ambiguous as annotating — `--kind verified` exists precisely for closing somebody
  else's fix.
- **A map of the knowledge corpus** at `/knowledge/graph`, and the same findings without a
  screen through `cairn know --gaps` / `--orphans` / `--dangling`, a `GET
  /api/v1/knowledge/gaps` route and a `cairn_gaps` MCP tool. It answers what a list of
  knowledge cannot — what is connected to *nothing*. On the corpus that prompted it: a
  quarter of the entries joined to nothing, nineteen separate islands, and dozens of
  references pointing at entries nobody ever wrote. The layout is computed on the server
  and is a pure function of the graph, because every view re-renders on a live update and a
  map that rearranges itself under the reader is not a map.
- **`[[slug]]` references resolve**, in the rendered body and in the terminal, with
  underscores read as hyphens. 265 of 377 entries carried them and nothing had ever parsed
  them, so 606 references rendered as literal brackets.
- **A reference to an entry nobody wrote is marked** rather than quietly linked into
  nothing — in the browser, and on the way out of `cairn know <slug>`.
- **Knowledge pages show the slug, who wrote it, and the task it was learned on**, and
  their scope chips link through to the project or entity.
- **Six knowledge tools on the MCP facade** — `know`, `learn`, `relearn`, `unlearn`,
  `verify`, `entities`. An MCP-only agent could not read or write the memory half of the
  product, and was not told it existed.
- **`scripts/install-mcp.mjs`**, because the facade needs a `node_modules` beside it and so
  cannot be copied like the CLI. It prints by default, and refuses to call an install done
  unless an account other than the installer's can read what it wrote.
- **A CI guard against one machine's layout reaching this repository**, checking shape —
  absolute paths into a named account's home — rather than carrying a list of private names,
  which would itself be a list of private names in a public repository.
- **Shared workspace membership:** administrators can add, disable and restore users,
  assign administrator or member roles, reset passwords, and manage each user's agent
  keys. Active users and valid agent keys work across one common project and memory space.

### Changed

- **The `closed-unclaimed` finding is now `closed-without-trace`, and counts a different
  population** (CAIRN-251, migration `054`). It was firing on the wrong tasks and its own
  sentence was false of them. Of the ten flagged in a 24h window, classified by hand against the
  activity feed, *zero* were the bare filed-to-closed shape it was built for: nine had moved to
  in-review hours earlier, several with commits and test runs recorded against them. Two defects
  behind that. Human closes were counted, although a person is documented as never claiming and
  `claim.ts` returns false for them by design — while the agent-silent finding twenty lines
  above it in the same report does skip people. And the backlog sweep the skill explicitly
  instructs — file one task, claim that, work the rest unclaimed — was indistinguishable from
  the failure the check exists to catch. So the question became "was there any evidence of work
  by anyone at any point" rather than "was this claimed". Renamed rather than redefined in
  place, because the name is the safety mechanism: a server still on migration `051` sends the
  old key, the new check does not find the new one, and it says nothing — which is correct,
  where printing the new sentence over the old number would not be. Measured here after the
  migration landed, 12 of 64 closes were untraced, under the quarter threshold, so the finding
  no longer fires; the old predicate read 26% at the same moment. Known and intended: `051`'s
  own motivating case is no longer counted, because a commit and a push were recorded against
  it. There is no grace window, because any threshold there would be arbitrary.
- **The CLI's known-flag list is checked from the code's side.** The parser exits 2 on a flag it
  does not know, and the test meant to stop the list going stale compared it against the help
  text and the dynamic lookup loops — neither of which sees a flag the code reads directly and
  the help never names. Adding `flags.zzzProbeFlag` to the CLI left all three tests green while
  the parser would have refused it with exit 2: the same failure, one door over. The list is now
  also diffed against every `flags.x` and `flags['x']` read in the file, with comments stripped
  so prose about a flag is not mistaken for a read. A second test asserts that no
  `flags.camelCase` read exists at all — the parser keys on the literal flag name, so such a
  read is not a style choice but permanently `undefined` and silent about it (CAIRN-255).
- **A slug is cut at a whole word.** Twelve entries ended mid-word — `...cannot-sha`,
  `...dernier-passag` — which cannot be typed and read as corrupt.
- **`cairn learn` scopes to this directory's project** instead of defaulting to global.
  27% of everything written since the import was filed as true everywhere when it was true
  of one project.
- Owner columns are retained as attribution metadata, not authorization boundaries.
  Project keys, entity keys and knowledge slugs are unique across the workspace.
- Durable actor labels include the owning user's display identity, and migration `049`
  qualifies legacy task, activity, knowledge, session and search attribution accordingly.

### Fixed

- **A flag the verb you ran never reads is now reported, and `relearn` re-scopes**
  (CAIRN-262). `KNOWN_FLAGS` is one list for every verb, which is what makes it cheap and
  what makes it blind: it catches a flag *nothing* reads, never a flag one verb reads and
  another does not. `cairn relearn <slug> --global` parsed, printed the entry with its old
  scope still on it and exited 0 — three lines below the comment explaining why a silently
  dropped flag is unacceptable. Found on a real write, not by reading the code, and the
  command's own output *showed* the unchanged scope: there was no lie to catch, only a line
  nobody rereads because the exit code already said it worked.

  Not fixed with a per-verb table. The argument against one still stands — it rots the
  first time a verb grows an option, and a wrong entry makes a working command start
  exiting 2 on every machine at once, which is worse than the bug. Instead `flags` is a
  proxy that records every key the running command looks at, so **the reads are the
  registry**: nothing to enumerate, nothing to keep in step, and exact about this
  invocation rather than approximate about the code. A read that ignored a flag exits 2 —
  nothing has happened yet and the answer looks filtered when it is not. A write warns and
  exits 0, because it already went through and an exit code saying otherwise is how a
  caller ends up making it twice; whether anything was written is read off the HTTP method,
  not off a list of verbs.

  Swept across every read verb before shipping: exactly one thing changed behaviour, and it
  was a true positive — `cairn know <slug> --limit 5` now says `--limit` did nothing, which
  it did not.

  `relearn` also grows the scope flags it was missing: `--project`, `--entity` and
  `--global`, the last clearing both and refusing to be combined with either, since a fact
  true everywhere is one with no project *and* no entity. Exposed through the MCP
  `cairn_relearn` tool too, which had no way to re-scope at all.

- **`font-display` was not a class, so two headings quietly rendered as sans** (CAIRN-258).
  `fonts.ts` loaded Instrument Serif and `layout.tsx` put `--font-display` on `<html>`, but
  `globals.css` never registered the key in its `@theme` block, and Tailwind v4 generates a
  utility only for a registered key. Settings and Users fell back to IBM Plex Sans and the
  family was downloaded on every page for nothing. Nothing errored and nothing looked
  broken — which is why it survived, since a sans heading is a perfectly reasonable thing
  for a heading to be. The key is registered, and a test now asserts that every font family
  named in a `className` anywhere in `src/` has one behind it, because the instance is less
  interesting than the failure mode.

- **The knowledge map rearranged itself when nothing had changed.** `simulate()` sums
  forces over the edge list in array order, and floating-point addition is not
  associative, so the same graph handed over in a different edge order settles somewhere
  slightly different. The node path was already protected because `components()` sorts;
  the edge list never was, and `knowledge-graph.ts` builds it by iterating rows with no
  sort — in a file whose own comment says row order is "not stable across an update or a
  vacuum", and which sorts defensively in five other places. The symptom was a map that
  quietly shifted after an unrelated write, which reads as the map being organic rather
  than as a bug, and is why nobody reported it. The new tests vary EDGE order
  specifically: the existing determinism test varied node order and could never have
  caught this.

- **The summariser ran on every Codex turn.** Codex has no `SessionEnd`, so the recorder is
  wired to `Stop`, which fires at the end of each assistant turn — and `record()` summarised
  unconditionally, so a forty-turn session made forty model calls, each with up to 24 KB of
  transcript, to write and rewrite one row. Nobody chose one call per turn; it arrived
  because `Stop` was the only event Codex had. The hook now reuses the last summary for a
  session when the digest is byte-for-byte what it already summarised, or when the previous
  call was under `CAIRN_SUMMARY_MIN_INTERVAL_MS` (default ten minutes). The deterministic
  half is still written fresh every time, and the prose is reused rather than omitted, so a
  row never loses prose it already had.
- **`backup.sh` could not back up the database the README tells you to create.** It dumped
  with `pg_dump -U postgres`, hardcoded, while `.env.example` documents `cairn_app` — so a
  deployment that followed the instructions either failed with `role "postgres" does not
  exist` or, on a cluster that happened to have one, quietly dumped as a superuser nobody
  intended. The role is now `CAIRN_DB_USER`, defaulting to `postgres` so existing
  deployments are untouched, and the README and `.env.example` now point at each other.
  Reported and fixed by [jgiffard](https://github.com/jgiffard) —
  [#55](https://github.com/montytorr/cairn/pull/55).
- **Vitals called the owner of the instance a silent agent.** `monty.torr@gmail.com has
  written nothing in 24h, against 97 in the week before … verify it was expected to be active
  before investigating hooks or keys` — that is a person, the 97 is a week of his own clicks
  in the web UI, and he has no hooks or keys to investigate. `agent_stats` selected
  `actor_id` and grouped by it, never referring to `actor_type`, so everyone who had ever
  touched a task arrived in the list the silent-runtime check reads. The cost was not the
  noise: a genuinely silent runtime was sitting in the same list as a false positive about a
  person, and a warning that is wrong half the time is one nobody finishes reading. Migration
  050 carries `actor_type` through, and the check skips people. A payload from an older
  server carries no type and is still checked, because there everything in that list was a
  runtime as far as anyone knew.
- **A long session was summarised by its first hour.** `buildDigest` gave the agent's
  narration head *and* tail, with a comment saying why the middle is worthless, but took the
  prompts head-only. That was fine while a session was an afternoon; now that the recorder
  also runs at compaction, the normal session being written up is a long one. The first
  session recorded under the new trigger was two days old and its `request` read "reconcile
  gaps, fix settings/users duplication" — true on the Friday, and nothing to do with what
  the session had become. Prompts now get the same head-and-tail treatment, and the
  summariser is told the middle was cut so it covers the span rather than the opening.
- **The no-sessions alarm asserted a cause it cannot know.** It ended "The session hooks
  are not running, or cannot write" — and a count of zero cannot distinguish a runtime with
  nothing to say from one that cannot speak. It named only the second, and was wrong both
  times it mattered here: once the runtimes were out of tokens and every hook was fine, once
  the hooks fired and the key authenticated and the sessions had simply never ended. Twice
  the guess was read as the finding. It now states what was observed, names the three cases
  that produce it, and points at `cairn-session-end.mjs --dry-run <transcript>`, which was
  built to separate them and which the alarm had never mentioned.
- **A session that never ends was never recorded.** The session row is written at
  `SessionEnd`, and a session that runs for days does not end — it compacts. On the machine
  this was found on, four Claude Code transcripts had been open since the same morning, one
  of them 39 MB, and the last session recorded from that host was the minute those four
  began, 54 hours earlier. Nothing was broken: the hooks fired, the key authenticated, the
  parser read a real transcript correctly. The trigger never came. `install-hooks.mjs` now
  installs `PreCompact` alongside `SessionEnd`, because compaction is what happens *instead*
  of ending, and `cairn session end` upserts on (platform, id) so the row is rewritten in
  place rather than duplicated.
- **`install-hooks.mjs` rewrote a hooks file that already said the right thing**, and for
  Codex that is not cosmetic. `JSON.stringify` emits keys in insertion order, so rebuilding
  an identical entry moves `cairn-memory` from after `timeout` to before it and the file
  gains a trailing newline — 1264 bytes become 1265, nothing about the configuration
  changes, and every `trusted_hash` under `[hooks.state]` in `config.toml` stops matching.
  Codex then silently runs none of its hooks. It now compares the hook set canonically and
  writes nothing when it matches, and the warning about re-trusting entries prints only
  when the file actually moved — printed every run, it was wallpaper.
- **Re-running `install-hooks.mjs` duplicated hooks it had not installed itself.** It
  recognised its own entries only by the tag it writes, so hooks installed by hand — or by a
  version of the script from before the tag existed — were invisible to it and a second copy
  was appended beside them. Two session recorders means two model calls per event. It now
  also recognises its scripts by name, and by name rather than absolute path, because the
  stale entry most in need of replacing is exactly the one that points somewhere else.
- **The browser UI could not write behind a TLS-terminating reverse proxy** — the
  deployment the README documents. The origin check compared the browser's `Origin`
  against the request's own URL, which reads `http://` once the proxy has terminated TLS,
  so the two could never match and every browser mutation was refused with 403. A fresh
  install could not issue its first agent key, which is the step the README sends you to
  immediately after bootstrapping the administrator. The expected origin now reads
  `X-Forwarded-Proto` and `X-Forwarded-Host`, takes the first hop of each, compares normal
  forms so an explicit `:443` still matches, and falls back to the request itself when the
  headers are absent or unparseable — so a direct deployment and the CLI are unchanged.
  Reported and fixed by [Thierry Thiers](https://github.com/webcoder31) — [#42](https://github.com/montytorr/cairn/issues/42), [#43](https://github.com/montytorr/cairn/pull/43).
- **`cairn know --project` was read after the early return**, so it was accepted and
  silently dropped on every search — the same defect as `check --project`, relocated into
  the CLI, on the verb agents use most.
- **An unknown project key answered with emptiness.** A typo and a project nobody has
  learned anything about were indistinguishable; it now says which key does not exist.
- **The MCP wrapper pointed into a checkout under a `0700` home**, so every runtime not
  running as root got `MODULE_NOT_FOUND` from a correctly registered server.
- **`install-cron.mjs` was the one file the repairer never repaired**, and so the only
  deployed copy on a busy host that had drifted.

### Breaking

- `cairn vitals` reports `tasks.closedWithoutTrace`; `tasks.closedUnclaimed` is gone. Anything
  parsing the vitals payload must read the new key — the old one is simply absent, so a reader
  that does not will see `undefined` rather than an error, and a dashboard built on it will show
  a blank where a number was. The count is not the same measurement renamed: it excludes closes
  made by a person, and it excludes any task with a checkpoint, commit, push, run result, or a
  status move that is not terminal, recorded before the close — so it reads lower than
  `closedUnclaimed` did on the same window. Apply migration `054`; until it is applied the server sends the old
  key and the finding stays silent, which is deliberate.

## [0.5.1] — 2026-09-16

### Fixed

- **P0 integrity boundaries:** claim, release, checkpoint and knowledge mutations now use
  atomic server-side transitions with ownership generations and monotonic checkpoint versions.
  Stale, duplicate and concurrent writes are rejected instead of overwriting newer work or
  resurrecting a released claim.
- **Durable outbox replay:** malformed and rejected queued writes are retained in a rejected
  sidecar, crashed replay workers are recovered, and checkpoint acknowledgements survive a
  crash between local compaction and state persistence. Non-checkpoint writes no longer leave
  acknowledgement markers behind.

### Changed

- Added migrations `043_integrity_boundaries.sql` and
  `044_checkpoint_predecessor_boundary.sql`, applied by the normal deployment migration step.
- CI now runs the PostgreSQL integrity suite, and production deployment is gated on the
  successful same-repository `main` workflow before building and smoke-testing the release.

## [0.5.0] — 2026-09-14

### Added

- **`cairn next`** answers which task to pick up, not just what exists. Finishing beats
  starting: work you hold, then work dropped with a checkpoint, then in-review, todo,
  backlog. Anything blocked, waiting on an unfinished task, or actively held by another
  agent is absent rather than ranked last. Every pick carries the reason it won.

- **Knowledge ages.** A fact whose named files several sessions have reworked since it was
  last confirmed is marked stale in `check` and in the briefing. Marked, never hidden and
  never expired. `cairn verify <slug>` confirms one without rewriting it.

- **Projects are created and curated from the UI** at `/projects` — create, rename,
  archive, restore, and delete behind a typed confirmation that names the task count.
  Settings no longer carries a weaker copy of the archived list.

- **In Progress and Todo tabs**, with In Progress the default, and an empty state that
  offers somewhere to go rather than dead-ending.

- **`--kind verified`**, for closing a task after finding somebody else's commit already
  fixed it. `fixed` claims their work and makes the close indistinguishable from one where
  nobody read anything.

- **`in-review` is documented** as the gate between working and finished — written but not
  merged, or merged but not deployed. It existed in the vocabulary and no guidance
  mentioned it, so the lifecycle jumped straight from doing to done.

- **Delivery evidence in the timeline**: `cairn commit`, `push` and `run` record what
  shipped and what passed. They record; none of them executes anything.

- **The timeline records what it was missing** — checkpoints, attachments, dependency
  changes, and the project lifecycle — and now outlives what it describes. Deleting a task
  detaches its events instead of erasing them, so the record that something was deleted
  survives the deletion.

- **`cairn task delete`**, refusing any task with children, notes, comments or
  dependencies; **`cairn replay`** for writes put aside while the server was unreachable;
  **`cairn add --start`** to file and claim in one call.

### Changed

- **A checkpoint claims an unheld task; a note does not.** The first version claimed on any
  work-log write and was too broad: an agent annotating a backlog put a task into `doing`
  that nobody was working on, reverted it, then did the real work without re-claiming.
  Annotating is most of what reading a backlog is. `cairn note` now says the task is
  unclaimed rather than deciding for you.

- **Everything is larger, and scales from one number.** Every size was a fixed pixel value —
  343 text sizes and 192 dimensions — so raising the type alone would have pushed text out
  of rows that could not grow. All of it is rem now, with the root at 18px.

- **Every page keeps itself current, or says why it does not.** The live-update stream
  watched only tasks, so the pages that go stale fastest could never have been helped by
  it. `cairn_pulse` covers tasks, sessions, knowledge and activity.

- **Projects are alphabetical everywhere**, case-insensitively — the collation sorted
  lowercase titles below every capitalised one.

- **Sessions say what came of them.** The API returned the request and the next steps and
  omitted what was learned and completed, so every reader outside the web UI got a session
  that said what was wanted and never what happened.

- Sessions record whether a run was **scheduled** rather than inferring it from prose the
  hook had deliberately discarded.

### Fixed

- **Every OpenClaw session was recorded as half a record.** `claude -p` as root answers
  "Not logged in", the transcript sweep must run as root, and the hook keeps the row when
  it cannot reach a summariser — so 42 of 42 sessions held their files and no prose at all,
  silently, for the life of the feature. Vitals now counts sessions actually summarised and
  alarms when none are.

- **Codex filed its work as OpenClaw.** Detection rested on `CODEX_HOME`, which Codex reads
  but does not export; the wrapper installed to set it was being bypassed. Detection now
  uses markers Codex does export, and OpenClaw is recognised by any `OPENCLAW_*` variable
  rather than two guessed names.

- **`check --project` ignored the filter for knowledge.** Three of four branches scoped;
  knowledge did not, so a scoped search returned other projects' facts and absence read as
  "this is new". Global facts still appear, and entity-scoped facts appear for projects in
  that entity.

- **A correction now outranks the claim it corrects.** Superseded knowledge was marked and
  never ranked below, so a stale fact could beat its own replacement.

- **A resolution cannot be written without closing the task**, and a task ref resolves in
  search — `CAIRN-131` used to return every task that mentioned it and never itself. A bare
  number works too.

- **The supersede picker searched instead of listing.** It was a select holding every
  current entry, capped at 300 against a corpus of 348, so 48 could not be chosen and
  nothing said so.

- Renaming a project key keeps old refs working; the list view shows the Cairn ref rather
  than an imported identifier that resolves nowhere; the sticky group heading is no longer
  painted over by the rows beneath it; settings and vitals are centred like every other
  page; and `/activity`'s "Load older" says that it is working.

### Breaking

- `DELETE /api/v1/tasks/{ref}` requires `?confirm=<REF>` and refuses a task with children,
  notes, comments or dependencies. It previously deleted anything without confirmation.

## [0.4.0] — 2026-09-14

### Added

- **`cairn next`** says what to pick up rather than what exists. The briefing listed what was
  held, in flight and dropped and never which one to do, so every agent invented its own
  ranking and they disagreed. Finishing beats starting: work you hold, then work dropped with
  a checkpoint, then dropped without one, then in-review, todo, backlog. Anything blocked,
  waiting on an unfinished task, or actively held by another agent is absent rather than
  ranked last. Every pick carries the reason it won.

- **Knowledge ages, and says so.** `verified_at` existed and nothing used it, so half a dozen
  entries describing the Supabase stack went on reading like facts confirmed this morning
  after the stack was replaced. A fact whose named files several sessions have reworked since
  it was last confirmed is marked stale in `check` and in the briefing. Marked, never hidden
  and never expired — a wrong confidence signal is worse than none. `cairn verify <slug>`
  confirms a fact without rewriting it.

- **`cairn task delete <ref> --confirm <ref>`**, refusing any task with children, notes,
  comments or dependencies in either direction, and pointing at cancel — which keeps the
  record and the reason — instead.

- **Writes survive a deploy.** They normally return in half a second; during a restart they
  blocked for minutes, so an agent mid-task froze rather than carrying on. A write now has a
  deadline, after which a note, comment, heartbeat or checkpoint is put aside and replayed by
  the next successful write. `add` and `claim` are deliberately not queued: a ref that does
  not exist yet, or being told you hold a task you may not have won, is worse than a clear
  failure. `cairn replay` flushes by hand.

### Changed

- **Sessions record what they actually touched.** The session hook recovered task refs by
  regex over the transcript and returned refs from documentation examples; those links feed
  search, and a session linked to everything answers yes to everything. The CLI now drops a
  breadcrumb per accepted write and the hook reads those, matched on time so it works for
  Codex and OpenClaw, which name sessions in ways the CLI cannot see. The regex remains as a
  fallback.

### Breaking

- `DELETE /api/v1/tasks/{ref}` now requires `?confirm=<REF>` and refuses a task that has
  children, notes, comments or dependencies. It previously deleted anything, with no
  confirmation. Anything scripted against it needs the parameter; anything relying on it to
  remove a task with history should use `cancel`.

## [0.3.0] — 2026-09-13

### Added

- Scheduled maintenance installs on macOS, as LaunchAgents rather than a crontab. The jobs
  were defined as cron lines and the defaults named one host's layout, so on a laptop every
  one of them skipped — correctly, and uselessly. They are now defined once as a schedule,
  an environment and a command, rendered by whichever backend the platform calls for, and
  the defaults describe the machine: `~/.local/bin` for the CLI, `~/Library/Logs` for logs,
  and the node running the installer. Verified byte-identical against the live Linux
  crontab before anything else changed.

- `sync-agent-files.mjs` repairs itself. It was the one file it never checked, so the
  repairer could sit stale indefinitely while reporting everything else healthy.

### Fixed

- A job whose prerequisite was never configured reported `skipping <job>: no  on this
  machine`, with an empty path where a filename should be — it reads as a bug in the
  installer rather than as a job this machine was never meant to run.

## [0.2.0] — 2026-09-13

### Added

- Renaming a project key is additive: the former key is retained and keeps resolving, so a
  ref already written into a commit message, a PR title or another agent's note still finds
  the task. Old links redirect to the live ref, retired keys still linkify in prose, and the
  task shows what it used to be called — resolution alone would let the lookup succeed while
  the screen showed a ref the reader had never seen. Reusing a key another project retired is
  refused, because every `ACME-n` would then point at two tasks. The rename and the record of
  the old key happen in one statement, so they cannot half-happen.

  Reported by [@webcoder31](https://github.com/webcoder31) in #4.

- The briefing resolves a project from the **repository**, not the path. `~/.cairn/projects.json`
  keyed identity on an absolute path, and the server's fallback on a recorded `cwd` — both
  describe where one machine keeps a checkout, which is not what was being identified. A
  `git worktree` of a mapped repository, a second clone, and a `mv` all resolved to no
  project, so the briefing went quiet exactly where several agents are most likely to
  collide. `cairn map` now also claims the origin remote, and `/context` accepts `?repo=`.
  Resolution order is `--project` → repository → the `cwd` heuristic, so an explicit answer
  and the local map both still win. One local git call, no network.

  Thanks to [@webcoder31](https://github.com/webcoder31), who reported it in #2 and sent
  the implementation in #3.

### Fixed

- `next dev` no longer appends a generated block to `AGENTS.md`. The guide is hand-written,
  read by every agent at session start, and held under 8KB by CI; the block took it to within
  107 bytes of that budget, so the failure would have landed on an unrelated pull request for
  a reason appearing nowhere in its diff. `agentRules: false` in `next.config.ts`, with a test
  pinning both the setting and the upstream switch it depends on.

  Reported by [@webcoder31](https://github.com/webcoder31) in #1.

### Changed

- `cairn map <KEY>` validates the key against the server before writing, and stores the key
  the server returns. It used to write whatever it was handed, so `cairn map CAl` produced a
  map that resolved to nothing, silently. It now needs to reach the server, where before it
  was purely local.

- `cairn map none` releases the repository claim as well as the local line. Removing only
  the local line would have left every clone — including that one — still resolving.

- Vitals reads as a dashboard rather than a column of hairlines: a verdict at the top that
  says plainly whether anything is wrong, four numbers at a size that admits they matter,
  and sections as panels. Adds a 24h / 7d / 30d window.

- Migrations moved from `supabase/migrations/` to `migrations/`. The directory was named
  after a dependency the project no longer has — the runtime moved to the native
  PostgreSQL driver — and a newcomer reading the tree would reasonably conclude Supabase
  was required. No migration content changed, and the applied-migrations ledger records
  filenames rather than paths, so existing installs need nothing.

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

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/montytorr/cairn/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/montytorr/cairn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/montytorr/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/montytorr/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/montytorr/cairn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
