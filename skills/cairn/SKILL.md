---
name: cairn
description: Shared task tracker and memory for agents. Use BEFORE starting work on any subject to check what has already been done, tried, or debugged; and to file, claim, annotate, learn, checkpoint, and close tasks. Triggers on "have we done this before", "check if we fixed", "what did we try for", "create a task", "log this", "learn this", "checkpoint this", "what's the status of", "claim this task", "mark it done", "end the session". Not for work already covered by a task you hold, a question answered by reading a file, or throwaway exploration that changes nothing: it is for durable work and durable answers, not for every request that has a verb in it.
---

# Cairn

Cairn is the shared memory for everything worked on here. It holds four things, and
`cairn check` searches all of them at once:

| | what it answers |
|---|---|
| **tasks** | what needs doing, what was done, how it was resolved |
| **notes** | what was tried along the way, including what did not work |
| **knowledge** | what we now *know* — infra, conventions, gotchas — outliving any task |
| **sessions** | what happened in a working session, and where it was left |

Examples below use `ACME-42`; refs are your own project key plus a number.

Requires `cairn` on PATH. Credentials come from `CAIRN_BASE_URL` / `CAIRN_API_KEY`, or from
`~/.cairn/env` if those are unset. Where a machine runs several runtimes there is a key
each — `CAIRN_API_KEY_CLAUDE_CODE`, `CAIRN_API_KEY_CODEX` — and the CLI picks by runtime,
because the key is what says who wrote a thing.

## When not to reach for it

Section 0 begins "for every non-trivial request", and the rest of this file is about the
requests that are. This is the other half, because a tracker that fires on everything costs
more than it records: a `check` before trivia, a task filed for something nobody will ever
look up, and an agent narrating its own bookkeeping instead of doing the work.

The test is durability, not size. A one-line fix that lands in the repo is durable work and
gets a task; an afternoon of reading that changes nothing is not and does not.

- **You already hold a task that covers it.** File the next step as a second task and the
  board now claims two pieces of work where there is one. Note on the task you hold, or use
  `--parent` when it is genuinely a separate piece. `add` warns you when similar work
  already exists, and that warning is usually right.
- **Another agent holds it.** A live claim in `check` is an answer, not an obstacle: pick
  different work. Filing your own copy of their task is how one bug ends up with two
  resolutions and a history split across both.
- **The question is answered by reading a file.** What does this function do, is this flag
  still used, which port does it bind — open the file. Cairn does not know what the code
  says, only what happened to it. Section 1's *every time* is about starting work on a
  subject, and a question a file answers outright is not one: the floor in section 0 for a
  trivial read-only answer is a `check` and nothing else, and that is worth spending when the
  subject has a past — a failure that recurs, a decision somebody already made, something
  already tried. If you cannot tell which you have, it is the one with a past, and `check` is
  one line.
- **Throwaway exploration.** Getting your bearings in an unfamiliar codebase files nothing.
  It stops being throwaway the moment you change something, or learn something that will
  still be true next month — and the second one does not need a task to hang off, because
  knowledge is bound to none.
- **A fact that expires.** "The staging branch is three commits behind" is true until
  somebody pushes. `learn` is for what will still be true next month; the rest is a note on
  the task it came up in, or nothing.
- **Narrating the bookkeeping.** Notes are attempts, findings, decisions and handoffs —
  what the next agent would otherwise repeat. Not a running commentary on your own progress,
  and not a report to the human of every `cairn` call you made along the way. `cairn comment`
  exists for the times you really are addressing them.

**A session that files nothing is not a failure.** Sessions are recorded by the runtime
whether or not you write anything, so there is no gap to plug and nothing to prove. Filing a
task to show you were here leaves a tracker that looks busy and answers nothing. The failure
is the other way round: a session that changed something, decided something, or ruled
something out, and left no trace of it.

## 0. Mandatory lifecycle — do not skip a gate

For every non-trivial request, follow this sequence and leave evidence at each boundary:

1. **Orient:** run `cairn context --cwd "$PWD"`, then `cairn check "<subject>"` before
   reading deeply, changing anything, or delegating. Inspect relevant hits with `show`.
2. **Own:** reuse an open task when one exists; otherwise `cairn add` one in the correct
   project, then `cairn claim <ref>`. A task is required for durable work, investigations,
   fixes, deployments, migrations, and delegated work; trivial read-only answers may use
   only `check`.
3. **Record:** write `note` entries for attempts, findings, decisions, and handoffs as
   they happen. When a fact should survive task closure, write it with `learn` (or correct
   it with `relearn`) instead of leaving it only in a task note.
4. **Checkpoint:** after each meaningful milestone and before pausing, delegating, or
   yielding, run `cairn checkpoint <ref> --summary "..."`; use `beat` during long work.
5. **Hand over, if it is written but not landed:** `cairn update <ref> --status in-review`.
   This is the most common real state and the lifecycle used to jump straight past it —
   the code is correct and not merged, or merged and not deployed. `done` would be a lie
   and `doing` says someone is still typing. Say which in a note: uncommitted, unmerged,
   or awaiting deploy.
6. **Close:** when the work is actually complete, run `cairn done <ref> --resolution
   "..." --kind fixed` (or the accurate non-fixed kind), then verify with `show` or
   `history`. Release a claim only when handing work back unfinished.

   **`--kind verified` when the fix was already there.** Closing a task after reading the
   code and finding somebody else's commit had already fixed it is not `fixed` — that
   claims their work, and makes your close indistinguishable from one where nobody read
   anything. The verification IS the value; name it.

### Sweeping many tasks at once

Triaging a backlog is not the shape above, and reading it literally goes wrong in both
directions: claiming thirty-one tasks falsely asserts thirty-one pieces of in-flight work,
and claiming none makes the sweep itself invisible while it runs.

File **one** task for the sweep, claim that, and work the rest without claiming them —
`note` what you found on each, `update --status` where the state is now clear, and close
the ones you can with an honest `--kind`. Writing a note does not claim a task, precisely
so that annotating thirty of them stays annotation.

Do not finish a durable task with only a chat reply, a dashboard update, or a vague note.
If work is incomplete, leave the task doing with a checkpoint and explicit handoff; never
claim done merely because the current turn is ending.

A checkpoint is what makes leaving it open safe. Two hours with nothing happening on a
claim releases it and moves the task back to todo, so the board stops saying someone is
working on it — the notes and the checkpoint are kept, and the checkpoint is the only
thing that tells whoever picks it up where you got to.

Sessions are created and recorded by the runtime lifecycle; there is deliberately no
`cairn session create` command. At session start, use `context` and `check`; at session
end, the runtime/Stop hook writes the episodic record and auto-checkpoints held tasks.
If a manual handoff is required and a real session id is available, use `cairn session
end --id <id>`; never fabricate a session or substitute a second memory/task system.

## 1. Check first. Every time.

Before starting work on a subject:

```bash
cairn check "supabase pooler connection timeouts"
```

Returns an index — one line per prior task, whether it has a recorded answer, and the
rough token cost of opening it:

```
#3
kind       ref                       status  type         answered  tokens  title
task       ACME-1                     done    bug          yes       ~15     supavisor timeouts under load
knowledge  supavisor-pool-sizing     current knowledge     yes      ~90     Supavisor pools are per-tenant
note       ACME-7                     doing   bug          yes       ~40     Tried raising pool_size, no change
```

Open a task with `cairn show ACME-1`, a piece of knowledge with `cairn know <slug>`, a
task's notes with `cairn log ACME-7`. **Do not re-debug something already answered.** If it
returns `#0`, the subject is new.

`--kinds task,note,knowledge,session` narrows it; the default searches everything, because
you do not know in advance which one holds the answer.

## 2. Then: check → show → act

```bash
cairn check "flaky auth redirect"   # index. cheap.
cairn show ACME-42                   # digest: the answer, findings, a clipped body
cairn show ACME-42 --full            # everything, when the digest is not enough
cairn recall ACME-42                 # picking it up: the decisions and facts that bear on it
cairn note ACME-42 "..."             # act, and record it
```

Never pull bodies in bulk to browse them. That is what the index is for.

`recall` starts from the task rather than a phrase. It returns resolutions and
decision/finding notes on the tasks around it — ones that name it, ones it names, its parent,
sub-tasks, blockers, similar closed work — and the knowledge that applies: linked to files it
touched, learned on it or a related task, or matching its terms. Each line says why it was
picked. `claim` prints the top of it for you; read it before you start, because the line that
says "do not read that closure as permission for this" is the one you would not know to look
for.

## 3. Record as you go

```bash
cairn note ACME-42 "bumped pool_size to 30, no change" --kind attempt
cairn note ACME-42 "supavisor caps at 15 regardless of client" --kind finding
cairn note ACME-42 "staying on supavisor; direct conns break PgBouncer" --kind decision
```

`--kind`: `note | finding | decision | attempt | handoff`

**Write down dead ends.** "Tried X, made no difference" saves the next agent an hour and
is as valuable as a fix. Notes are deduplicated, so a retry after a timeout is safe.

**Name the other task when it is affected.** A ref written in a note, comment, description
or resolution — `ACME-31` — shows up on `cairn show ACME-31` under `mentionedIn`, decisions
and findings first. So when something you decided here constrains or contradicts other work,
write its ref in a `decision` or `finding` note: whoever picks that task up sees it without
having to know to look. No link command needed; the ref in prose is the link.

Use `cairn comment` instead when you are addressing the human rather than the next agent.

### Evidence, as opposed to narration

A note is what you chose to say. These are what actually happened, and they go in the task
timeline where a reader can check them:

```bash
cairn commit ACME-42 a1b2c3d --message "cap pool_size at 15"
cairn push   ACME-42 a1b2c3d --branch main
cairn run    ACME-42 "npm test" --status passed --exit-code 0
```

**They record; none of them runs anything.** `cairn run` does not execute the command — you
have already run it, and this is you writing down what it did.

Worth doing when you ship something or a test decides an argument, because "I fixed it" and
`run_result failed exit 1` are very different claims and only one of them can be checked.
Recording the same commit against the same task twice is one line, not two, so a retry
after a timeout is safe.

## 4. Closing requires saying how

```bash
cairn done ACME-42 --resolution "raised supavisor pool_size to 40; default 15 was the cap"
```

The API refuses `done` without a resolution, and will suggest one from your last
checkpoint. `--kind fixed | wont-fix | duplicate | not-reproducible | superseded | answered`.

A closed task with no recorded answer is invisible to everyone who comes later.

**Check the ref before you close.** A resolution written onto the wrong task is worse than
no resolution at all: that task now looks answered, and `check` will offer it as prior
work. It has happened — an audit's findings landed on an unrelated task because the ref
was one digit out. `cairn show <ref>` costs nothing.

Reopening a task clears its resolution. An open task carrying one claims to be settled
while it is not; the withdrawn text stays in `cairn history`.

## 5. Claiming, so agents don't collide

```bash
cairn claim ACME-42        # exit code 9 means another agent holds it
cairn beat ACME-42         # keep it alive during long work
cairn checkpoint ACME-42 --summary "migration written, tests not run"
cairn release ACME-42
```

- **Claiming starts the task.** `claim` sets the status to `doing` for you — there is no
  second command to remember, and no reason to skip it because it looks like ceremony.
- **Claim the task you just filed, if you are about to do it**, or use `cairn add --start`
  which files and claims in one call. Filing and closing without claiming leaves the work
  invisible while it happens; on a machine running more than one agent that is exactly
  when a second one picks up the same thing.
- **You do not have to remember — if you checkpoint.** A checkpoint on an open task
  nobody holds claims it for you, and says so in its reply; it is also something you were
  going to write anyway. This exists because the rule above was stated plainly for weeks
  and 36% of closed tasks were still never claimed — discipline that costs nothing to skip
  gets skipped, so the ordinary path now produces the right state. **A note does not claim
  it.** It tells you the task is open and unheld and leaves the decision to you, because
  annotating is most of what reading a backlog is, and a `finding` written while merely
  reading a task is not a claim to be working it. Neither one steals: a checkpoint on a
  task somebody else holds is refused, and a note on it stays a note.
- **Closing is still yours to do.** A resolution is refused unless the status is closing,
  because "here is how it ended" while the task stays open is a contradiction — and one
  that used to be accepted silently, leaving the task carrying an answered dot and
  offering itself to `check` as settled.
- **Exit 9 means pick different work.** Do not force it.
- **Only claim open work.** A task in `done` or `cancelled` is settled history;
  claiming it must not reopen it. If the work genuinely needs revision, explicitly
  move it back to an open status first, then claim it.
- A claim is independent of `status` — a task can be `doing` and unclaimed, which is what a
  human working on it looks like.
- A lease goes stale after 15 minutes of silence and can then be taken over. Two hours of
  silence releases it and returns the task to `todo`.
- Leave a checkpoint before you stop; it is how another agent resumes without your
  transcript.

## 6. Filing work

```bash
cairn add "title" --project ACME --type bug --priority high --body -
cairn add "title" --project ACME --body "one line, when that is genuinely all there is"
```

`--type`: `feature | bug | improvement | chore | spike | docs`
`--status`: `backlog | todo | doing | in-review | done | cancelled`
`--priority`: `urgent | high | medium | low`

`add` warns if similar work already exists — read the warning before continuing.

### The body is the task

A title says which task this is. The body says what it is. Filing a title alone
leaves the next agent — often you, next week, with none of today's context — a
label for a thing nobody wrote down.

**A bug or a spike without a body is refused.** Not to be difficult: it is the
same rule as `done` refusing without a resolution, and that rule is why every
close carries one. Pass `--force-empty` when the title really is the whole
story, and expect to almost never need it.

What earns its place in the body:

- **What happens, and what you expected instead.** "403 on `/cart`" is a symptom
  in search of a report. What called it, what came back, what should have.
- **How to see it.** The request, the page, the command, the log line. A bug
  nobody can reproduce is a rumour.
- **What you already ruled out.** The hours you save are someone else's, and
  they are the hours they would have spent repeating you.
- **Why it matters now**, if that is not obvious. Urgency in a priority field is
  an assertion; urgency in a sentence is an argument.

Write it when you file it. The context is never cheaper than at that moment, and
a task you meant to flesh out later is one you filed against yourself.

For a `chore` or `docs`, the title is often genuinely the whole task and no body
is asked for. Do not pad one — "n/a" in a description is worse than an empty
one, because it looks answered.

## 7. Knowledge: what we know, not what we did

A task is a piece of work. Knowledge is what survives it — the thing the *next* person
needs whether or not they ever find the task it was learned in.

```bash
cairn know                              # what applies here
cairn know "postgrest ambiguous embed"  # search it
cairn know postgrest-embeds-go-ambiguous-when-a-second-fk-path-appears   # read it
```

Write it the moment you learn something that will be true next month:

```bash
cairn learn "Supavisor pools are per-tenant, not per-connection-string" \
  --label supabase,postgres --body -
```

### The title is the claim; the slug is the handle

The title should read as the thing you now know, so a list of titles is a list of
answers rather than a list of topics. The slug is derived from it — lowercased,
hyphenated, cut at a whole word — and it is the name the fact then has forever: what
you type to read it back, and what goes inside `[[...]]` to point at it.

Those two pull in opposite directions, and the measured result is that they matter:
entries whose slug runs past sixty characters are referenced by other entries about
an eighth as often as short ones. A claim long enough to be precise makes a handle
too long to reach for.

So when the claim is a long one, name it yourself:

```bash
cairn learn "Supavisor pools are per-tenant, not per-connection-string" \
  --slug supavisor-pools-per-tenant --body -
```

### Pointing at another entry

Write `[[its-slug]]` in a body. It becomes a link, and `cairn know <slug>` reads it
back — the same reference works in the browser and the terminal, and underscores are
read as hyphens so an older spelling still resolves. Use it the way you would use
`ACME-42` for a task: a reference that stays followable long after the conversation.

`learn` and `relearn` resolve every reference before they write anything, so a guessed
slug does not get recorded and found later. **A reference that misses while a
near-named entry exists is refused, and the refusal names the slug you probably meant.**
Take it at face value and re-run with that slug: 63% of the dangling references already
in the store point at a fact Cairn holds under a different name, so almost every time
this fires you have not found a gap in the memory — you have spelled the handle wrong.

`cairn know "<phrase>"` finds the slug when you do not know it, and is cheaper than
being refused.

Two cases behave differently:

- **Nothing close exists.** The write is accepted and says so in a warning, because two
  entries that cite each other cannot both be written first and refusing would make that
  pair unwritable. It is still a promise the store cannot yet keep, so write the other
  entry or correct the reference while you are here.
- **A task ref in wiki brackets — `[[ACME-42]]`.** Refused, with no way past it. Inside
  `[[...]]` it reads as a knowledge slug and points at an entry that will never exist.
  Write the ref bare, in prose.

`--allow-dangling` on `learn` or `relearn` records the refused case anyway. It is for
the time the refusal is wrong — a genuinely new fact whose name happens to resemble one
already there — and not for getting past a slug you could have looked up in one
command. It does not cover a task ref in brackets, because that is never what the
author meant.

Reading an entry says so too: `cairn know <slug>` names any of its references that point
at something nobody has written.

### What is not connected

```bash
cairn know --unused      # entries no search or read has returned in 30 days
cairn know --gaps        # the shape of the memory: islands, orphans, dead references
cairn know --orphans     # entries nothing links to, that link to nothing
cairn know --dangling    # references pointing at entries nobody ever wrote
```

A list of knowledge shows what is there. These show what is not, which is the part that
goes wrong quietly: an entry nobody links to is one nobody finds by following a trail,
and a reference to something unwritten is a promise the store cannot keep. Both are worth
a minute when you are already in the area — link the orphan to whatever it belongs beside,
or write the entry that was referenced.

### If this machine also has Trig

Trig is the sibling product: Cairn holds what we **did** and what we **concluded**; Trig
holds what the company **is** — its repositories, services, databases and what depends on
what, scanned from the real sources.

**If you are unsure which one a fact belongs in, write it here.** Trig ingests Cairn
knowledge on every scan, so a fact filed in Cairn reaches the map by itself. Nothing
carries facts the other way, and a fact written into Trig by hand becomes a
`contributed` aspect that no scan may ever supersede. The two mistakes cost different
amounts: one is a delay, the other is forever.

When it is not a close call, the test is one question:

> **Could a re-scan rediscover this?**
> **yes → Trig (`trig learn`).  no → Cairn (`cairn learn`).**

"dispofi-api writes to the `quotes` collection" is Trig — a scanner finds it every time.
"we raised the pool size and it made no difference" is Cairn — nothing rediscovers that.

### Where does it apply?

Three scopes, narrowest first:

```bash
cairn learn "..."                     # inferred: this directory's project
cairn learn "..." --project ACME      # true of that project
cairn learn "..." --entity acme       # true of that grouping — see `cairn entities`
cairn learn "..." --global            # true everywhere — chosen, not defaulted to
```

An **entity** is any grouping a fact can be true of: a business, a stack, a subsystem. A
project belongs to several at once, so reach for the one the fact is actually about —
"Customer.io campaign ids" is true of the business running those campaigns, not of one
repo in it, and not of the work that has nothing to do with it.

Scope narrowly only when it is genuinely narrow. A fact filed under one project is
invisible from the other four where it also applies — which is the mistake that made five
facts about one business get filed as global, because global was the only thing left that
was not also wrong.

When a fact exists at two scopes, the narrower one is shown first: a project fact beats an
entity fact beats a global one. That is how "true for this business, except here" gets said.

**Correct it rather than adding to it.** The failure mode of every memory store is
accumulation without correction — two contradictory claims, equally findable, and no way to
tell which one is current.

```bash
cairn relearn <slug> --body - --reason "why"         # it changed
cairn relearn <slug> --global                        # it is true more widely than filed
cairn unlearn <old-slug> --superseded-by <new-slug>  # it was wrong
cairn verify <slug>                                  # still true; you checked
cairn know <slug> --history                          # what it used to say, and who changed it
```

A fact is linked to the files it is about — the backticked paths in its body, the files its
source task touched, and any you name with `--files a,b` — so `cairn context --file <path>`
finds it, and it is marked stale when those files are reworked. Name the files when the body
does not.

A correction keeps what it corrected: every `relearn`, re-scope and supersession stores the
version it replaced, with who replaced it and the `--reason` if you gave one. Give one — "the
default was 15, not the cap" is what makes the old version readable as a mistake rather than
as a second opinion. A `verify` is not a new version.

`relearn` takes the scope flags too — `--project`, `--entity`, `--global` — so a fact filed
against this directory's project can be widened once you find it is true elsewhere.
`--global` clears both scopes, and refuses to be combined with either.

A superseded row stays findable, is marked as superseded, and now ranks below its
replacement — so a correction beats the claim it corrects wherever both match.

`verify` is the cheap half of that. A fact whose files several sessions have reworked since
it was last confirmed is marked **stale** in `check` and in the briefing; verifying clears
the mark without making you restate the body. Confirming an old fact is as useful as
writing a new one, and a great deal faster.

### Knowledge or a note?

A note is bound to a task and to a moment: *"tried raising pool_size on ACME-7, no change"*.
Knowledge is bound to nothing: *"Supavisor pools are per-tenant"*. If you would want it
surfaced while working on an unrelated project, it is knowledge.

### Two more, rarely needed

`cairn replay` sends writes that were put aside while the server was unreachable. Any
successful write drains that queue on its own, so this is for looking rather than fixing.

`cairn task delete <ref> --confirm <ref>` removes a task that should never have existed. It
refuses anything carrying children, notes, comments or dependencies — for those, `cancel`
keeps the record and the reason, which is almost always what you actually want.

## 8. Before you stop

The session record and the checkpoint are written for you when a session ends, so nothing
is lost if you forget. These are the things nothing can do on your behalf:

- [ ] **Close what you finished** — `cairn done <ref> --resolution "…"`. The API refuses a
      close without one, so a task left open is a task you did not close, not one you
      closed badly.
- [ ] **Say what did not work** — `cairn note <ref> --kind attempt`. The next agent will
      otherwise try it again, and the trying is the expensive part.
- [ ] **Record what you learned** — `cairn learn`, if it will still be true next month.
      Scope it: `--project` for one codebase, `--entity` for a business or a stack,
      `--global` for true everywhere. Given none of them it takes this directory's
      project, and refuses when there is none to take — global is a claim about every
      project you have, so it is chosen rather than arrived at.
- [ ] **Release or checkpoint anything you are still holding** — `cairn release`, or
      `cairn checkpoint --summary` if the work continues. Going quiet does the release for
      you and sends the task back to todo, but it cannot write the checkpoint for you.

`cairn context` shows what you are holding and flags anything that has gone quiet, so run
it if you are unsure what you left open.

## 9. The briefing

```bash
cairn context          # what you hold, what is in flight, where the last session stopped
cairn context --scope project          # only this project's tasks and last session
cairn context --scope project --project CAIRN  # select a project explicitly
```

Usually you will not run this: a hook runs it when a session starts and puts the result in
front of you. Run it by hand when you have lost your place, or after a long stretch of work.

Read **"Started and dropped here"** when it appears. Those are tasks somebody began and
walked away from — nobody is holding them, and nothing else will surface them again. Pick
one up and finish it, or close it with a resolution saying why it is not worth finishing.
Leaving them is how a tracker fills with work that looks live and is not.

`cairn map CAIRN` tells Cairn that this directory is that project, which is what makes the
briefing project-aware. Do it once per repository — it claims the repo, so a second clone
and a `git worktree` resolve without being mapped again.

By default, held work and stale claims can still span projects: the briefing helps you see
everything you are responsible for. Use `--scope project` to restrict those sections and
the last session to the resolved project. If no project resolves, it fails rather than
returning a cross-project briefing that looks filtered. An unknown `--project` key returns
404. Tasks linked to the project only through `--also-project` are excluded: the filter
uses their home project, as "In flight here" already does. Shared/global knowledge remains
available; this is a relevance filter, not an authorization boundary.

A project's key can change (`cairn project rekey AC HOL`). Old refs and `--project AC`
keep working, and every answer reached that way says so: `AC-113 is now HOL-113 — project
AC was renamed HOL on …`. When you see that, write the new ref from then on, and run
`cairn map HOL` if the briefing or `cairn map` says this checkout is still mapped to AC.

### Which one to pick up

```bash
cairn next                     # the recommendation, and why it won
cairn next --project CAIRN
```

The briefing says what exists; this says what to do. Finishing beats starting, so work you
already hold ranks above work dropped with a checkpoint, which ranks above anything not
begun. Anything blocked, waiting on an unfinished task, or actively held by another agent
is **absent rather than ranked last** — a list ending in things you must not pick has to be
read to the bottom before it is safe to use.

Every pick carries the reason it won. If you disagree with the reason, that is information:
the ranking is wrong, or the task is mis-filed.

## 10. Dependencies

Before claiming, check whether something has to land first. A task with open blockers
is not ready to start, no matter what its status says.

```bash
cairn deps ACME-42                    # what blocks this, and what it blocks
cairn blockedby ACME-42 ACME-40        # ACME-40 must finish before ACME-42
cairn unblockedby ACME-42 ACME-40   # remove it again
```

Use this instead of writing "waiting on ACME-40" in a note: a note is prose nobody
queries, a dependency shows up on both tasks and in `cairn deps`.

`cairn block ACME-42 "reason"` is a different thing — it flags a task as stuck on
something outside Cairn (an unavailable credential, a third party). Reach for
`blockedby` when the blocker is another task.

## 11. Closing as a duplicate

```bash
cairn done ACME-42 --duplicate-of ACME-31 --resolution "same cause as ACME-31; fixed there"
```

Naming the original is the point. `--kind duplicate` on its own records *that* it was a
duplicate and leaves the reader to go and find *what* — which is the work the resolution
was supposed to save.

## 12. Splitting work up

```bash
cairn add "write the migration" --project ACME --parent ACME-42
cairn children ACME-42                 # the split, and how much of it is closed
cairn update ACME-7 --no-parent        # lift it back to the top level
```

Sub-tasks are *containment*; `blockedby` is *ordering*. Use a parent when one task is
too big for a single resolution, and a blocker when two separate things have to happen
in an order.

## 13. What already happened

```bash
cairn history ACME-42     # status moves, claims, renames, resolutions — with who and when
```

Different from `cairn log`, which is what an agent *said*. `history` is what actually
happened, recorded whether anyone narrated it or not. Reach for it when a task is in a
state nobody explained.

## Output

TSV by default: a `#count` line, one header row, then rows; nulls omitted. `--json` to
parse, `--pretty` for a human. `cairn --help` is the full reference.

## Scope

Cairn holds open loops, durable answers, and what was learned getting to them. Sessions are
recorded automatically when they end and knowledge is written by hand, so "what did I do in
that conversation last Tuesday" and "what do we know about this" are both `cairn check`.

What it is still not: a transcript. It holds what a session concluded, never what was said
turn by turn.
