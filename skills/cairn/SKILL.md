---
name: cairn
description: Shared task tracker and memory for agents. Use BEFORE starting work on any subject to check what has already been done, tried, or debugged; and to file, claim, annotate, learn, checkpoint, and close tasks. Triggers on "have we done this before", "check if we fixed", "what did we try for", "create a task", "log this", "learn this", "checkpoint this", "what's the status of", "claim this task", "mark it done", "end the session". Not for work already covered by a task you hold, a question answered by reading a file, or throwaway exploration that changes nothing: it is for durable work and durable answers, not for every request that has a verb in it.
---

# Cairn

Shared memory for everything worked on here: **tasks** (what needs doing and how it ended),
**notes** (what was tried, including what failed), **knowledge** (what is now true, outliving
any task) and **sessions** (recorded for you). `cairn check` searches all four at once.
Examples use `ACME-42`; refs are your project key plus a number.

## The lifecycle — every time you do durable work

Durable means it changes something, decides something, or rules something out: a fix, a
config change, a deploy, a migration, an investigation, a delegation. Size is irrelevant.

1. **Check.** `cairn check "<subject>"` before reading deeply, changing anything or
   delegating; `show` the hits that matter. Do not re-debug something already answered.
2. **Own it.** Reuse an open task, or file one. From an agent runtime `cairn add` **claims
   by default** (it says so; `--no-start` only files). It holds the claim back, and tells you
   why, when similar open work exists or you already hold a task in that project. Otherwise
   `cairn claim <ref>` — it sets `doing` and prints what bears on the task. **Exit 9 means
   another agent holds it: pick different work**, never force it.
3. **Record as it happens.** `cairn note <ref> "…" --kind attempt|finding|decision|handoff`.
   **Dead ends are `--kind attempt`** — "tried X, no change" is the note the next agent
   needs most, because the trying is the expensive part.
4. **Checkpoint before you yield.** `cairn checkpoint <ref> --summary "state + next step"`
   after each milestone and before pausing, delegating or ending the turn. It is the only
   thing that tells whoever resumes where you got to.
5. **Written but not landed → `cairn update <ref> --status in-review`**, with a note saying
   which: uncommitted, unmerged, or awaiting deploy. `done` would be a lie and `doing` says
   someone is still typing.
6. **Close with how.** `cairn done <ref> --resolution "what changed and why" --kind <kind>`:
   `fixed` · **`verified`** (someone else's fix was already there and you checked — `fixed`
   would claim their work) · `answered` · `wont-fix` · `duplicate` · `not-reproducible` ·
   `superseded`. With no `--kind` it records `fixed` and says so. `show` the ref first: a
   resolution on the wrong task makes that task look answered.

Unfinished at the end of a turn? Leave it `doing` with a checkpoint — never `done` because
the turn is ending. `release` only when you are handing it back and will not continue.

**Sweeping a backlog: one claimed task per sweep.** File one task for the triage, hold that,
and work the rest without claiming them: `note` what you find on each, `update --status`
where the state is now clear, close what you can with an honest `--kind`. Claiming thirty
tasks asserts thirty pieces of in-flight work that nobody is doing. A note never claims, so
annotating stays annotation; file any new tasks during a sweep with `--no-start`.

**When not to file.** A tracker that fires on everything costs more than it records.
- **A task you hold already covers it** — note on it, or `--parent` a genuinely separate piece.
- **Another agent holds it** — a live claim in `check` is an answer; pick different work.
- **Reading a file answers it** — Cairn knows what happened to the code, not what it says.
  `check` first only if the subject has a past (a recurring failure, a decision, a try).
- **Throwaway exploration** — until you change something or learn something durable.
- **A fact that expires** ("staging is three commits behind") — a note, or nothing.
- **Narrating your bookkeeping** — notes are for the next agent, not a progress log.

A session that files nothing is fine: sessions are recorded whether or not you write. The
failure is the other way round — a session that changed or ruled something out and left no
trace of it.

---

## Check, show, recall

```bash
cairn check "flaky auth redirect"   # index: one line per hit, answered?, ~token cost
cairn show ACME-42                  # digest: the answer, findings, a clipped body
cairn show ACME-42 --full           # everything, when the digest is not enough
cairn log ACME-42                   # what agents said · cairn history: what actually changed
cairn recall ACME-42                # decisions and facts that bear on this task
cairn know <slug>                   # read a knowledge hit
```

`#0` means the subject is new. `--kinds task,note,knowledge,session` narrows `check`; the
default searches everything because you do not know which store holds the answer. Never
pull bodies in bulk — the index exists so you choose what is worth reading.

`recall` starts from the task: resolutions and decision/finding notes on related tasks
(naming it, named by it, parent, children, blockers, similar closed work) and knowledge on
its files, each with why it was picked. `claim` prints the top of it — read it; "do not
read that closure as permission for this" is the line you would not know to look for.

## Evidence, as opposed to narration

```bash
cairn commit ACME-42 a1b2c3d --message "cap pool_size at 15"
cairn push   ACME-42 a1b2c3d --branch main
cairn run    ACME-42 "npm test" --status passed --exit-code 0
```

They record; none of them executes anything. "I fixed it" and `run_result failed exit 1`
are different claims and only one can be checked. Repeats are deduplicated, so a retry is
safe. Name another task's ref in a `decision` or `finding` note when your work constrains
it — it shows under that task's `mentionedIn`; the ref in prose is the link. `cairn comment`
is for addressing the human rather than the next agent.

## Filing, and the body

```bash
cairn add "title" --project ACME --type bug --priority high --body -   # body on stdin
```

`--type feature|bug|improvement|chore|spike|docs` · `--priority urgent|high|medium|low`.
`add` lists similar existing work — read it before continuing.

The title says which task; the body says what it is. **The server refuses a bug or spike
whose body is under 40 characters**, from the CLI, UI and MCP alike; `--force-empty` is for
the rare title that is the whole story. What earns its place: what happens versus what you
expected; how to see it (request, command, log line); what you already ruled out; why it
matters now. Write it when you file — context is never cheaper. A `chore`/`docs` title is
often enough; never pad with "n/a".

The API refuses `done`/`cancelled` without a resolution (it suggests one from your last
checkpoint), and refuses a resolution unless the status is closing. Reopening clears the
resolution; the withdrawn text stays in `history`.

## Knowledge: what we know, not what we did

```bash
cairn know                                  # what applies here
cairn know "postgrest ambiguous embed"      # search
cairn learn "Supavisor pools are per-tenant, not per-connection-string" \
  --slug supavisor-pools-per-tenant --label supabase --body -
```

Write it the moment you learn something that will be true next month. If you would want it
surfaced on an unrelated project, it is knowledge; if it is bound to one task and moment,
it is a note.

- **Scope is explicit or inferred, never assumed global.** `--project ACME`, `--entity acme`
  (a business, stack or subsystem — `cairn entities`), or `--global`. With none, `learn`
  takes this directory's project and **refuses where there is none** — so a runtime working
  outside a mapped checkout must pass a scope. Scope narrowly only when the fact is narrow;
  the narrower one is shown first ("true for this business, except here").
- **A body is required** on `learn`, and a `relearn` body cannot be blank.
- **Provenance is automatic:** the session is recorded with the fact, and so is the task
  when this session holds exactly one (`--task <ref>` to name another).
- **Secrets are refused** on every write that is read back — knowledge, notes, comments,
  bodies, resolutions, checkpoints (`sk-…`, `ghp_…`, `AKIA…`, private keys, JWTs,
  `password: <value>`). Write where it lives instead: `$ENV_VAR`, a vault path.
- **The title is the claim; the slug is the handle** — give a long claim a short `--slug`.
- **`[[slug]]` in a body is a link**, followable in browser and terminal. A reference that
  misses while a near-named entry exists is refused, naming the slug you probably meant —
  take it; that is almost always a misspelling, not a gap. With nothing close it is accepted
  with a warning (two entries can cite each other). `[[ACME-42]]` is refused: write task
  refs bare. `--allow-dangling` is for when the refusal is genuinely wrong.
- **Correct rather than add.** Two contradictory claims, equally findable, is how every
  memory store fails. When `learn` lists same-subject entries, supersede the wrong one.

```bash
cairn relearn <slug> --body - --reason "why"         # it changed (old version kept)
cairn relearn <slug> --entity E --project none      # re-scope: none clears a side; --global both
cairn unlearn <old> --superseded-by <new>            # it was wrong
cairn verify <slug>                                  # still true; you checked
cairn know <slug> --history
```

A fact is linked to the backticked paths in its body, its source task's files, and any
`--files a,b`. **`stale`** means those files were reworked since it was confirmed;
**`unverified Nd`** means a fact naming no file has gone 14+ days unconfirmed — age, not
evidence of change. Either way: check it, then `verify` or `relearn`. Confirming an old
fact is as useful as writing a new one and far faster.

`know --unused|--gaps|--orphans|--dangling` show what is *not* connected. **Scripted reads are not recalls:** pass `--sweep` (or
`CAIRN_SWEEP=1`) when looping over entries; bursts of ten-plus slugs a minute are tagged as
sweeps anyway.

**If this machine also has Trig** (the map of what exists): ask *could a re-scan
rediscover this?* Yes → `trig learn`; no → `cairn learn`. Unsure → Cairn: Trig ingests
Cairn knowledge on every scan, while a fact hand-written into Trig is never superseded.

## Claims and liveness

```bash
cairn claim ACME-42      # sets doing; exit 9 = held by someone else
cairn beat ACME-42       # optional heartbeat during long silent work
cairn checkpoint ACME-42 --summary "migration written, tests not run"
cairn release ACME-42    # handing it back: a held doing task returns to todo
```

- A claim is execution state, independent of status: `doing` and unclaimed is what a human
  working on it looks like. Only claim open work — move settled work back to an open status
  first if it truly needs revision.
- **A checkpoint on an unheld open task claims it** (and says so); a note does not. Neither
  steals: a checkpoint on someone else's claim is refused.
- **After 15 silent minutes** a lease is stale and another agent may take it over.
- **After 2 hours with no sign of life** the scheduled maintenance sweep (`reconcile`, every
  30 minutes where installed) releases the claim and leaves a note: `doing` goes back to
  `todo`, `in-review` keeps its status. Sign of life is a beat, a note, a checkpoint you
  wrote, an edit, or your own commit/push/run — so evidence keeps a claim alive. Notes and
  checkpoints survive the release; the checkpoint is where the next agent starts.
- **At session end the runtime checkpoints tasks the session worked on, never over a
  checkpoint you wrote** unless this very session holds the claim; a checkpoint written
  meanwhile always wins. A held task it did not touch gets a "still held" line only if it
  has no checkpoint, and that line is not a sign of life. Your own checkpoint is the handoff.

Sessions are created by the runtime; there is no `session create`. For a manual handoff
with a real session id, `cairn session end --id <id>` — never fabricate one.

## Dependencies, parents, duplicates

```bash
cairn deps ACME-42                   # what blocks this, and what it blocks
cairn blockedby ACME-42 ACME-40      # ACME-40 must finish first (unblockedby removes)
cairn block ACME-42 "reason"         # stuck on something outside Cairn
cairn add "write the migration" --project ACME --parent ACME-42
cairn children ACME-42               # the split, and how much is closed
cairn done ACME-42 --duplicate-of ACME-31 --resolution "same cause; fixed there"
```

A task with open blockers is not ready, whatever its status says; a dependency shows on
both tasks, while "waiting on ACME-40" in a note is prose nobody queries. Parents are
containment, blockers are ordering. Name a duplicate's original, or the reader must hunt.

## Briefing and what next

```bash
cairn context                         # what you hold, in flight, where the last session stopped
cairn context --scope project [--project KEY]
cairn next [--project KEY]            # the recommendation, and why it won
cairn map ACME                        # this checkout is that project (once per repo)
```

A hook usually runs `context` at session start; run it when you have lost your place.
Read **"Started and dropped here"**: work somebody began and walked away from — finish it
or close it with why. `--scope project` restricts held work and the last session to the
resolved project and fails rather than guess. `next` ranks work you hold above work dropped
with a checkpoint above anything not begun; blocked or actively held work is absent, not
ranked last. A renamed key (`AC-113 is now HOL-113`) keeps resolving — write the new ref.

## Before you stop

Close what you finished (resolution, right `--kind`); `note --kind attempt` what failed;
`learn` what stays true, scoped; checkpoint what you still hold. Nothing writes your
checkpoint for you.

## Output and rare verbs

TSV by default (`#count`, a header, rows); `--json` to parse, `--pretty` for a human;
`cairn --help` is the reference. `replay` sends writes queued offline. `task delete <ref>
--confirm <ref>` is for junk only; `cancel` keeps the record and the reason.

Requires `cairn` on PATH and a key per runtime (`~/.cairn/env`): the key is who wrote a thing.
**Exit 10: several Cairn instances, none known here.** Ask the user which, run the `cairn
route add …` it prints, retry. Never pick one yourself.
