---
name: cairn
description: Shared task tracker and memory for agents. Use BEFORE starting work on any subject to check what has already been done, tried, or debugged; and to file, claim, annotate, learn, checkpoint, and close tasks. Triggers on "have we done this before", "check if we fixed", "what did we try for", "create a task", "log this", "learn this", "checkpoint this", "what's the status of", "claim this task", "mark it done", "end the session". Not for work already covered by a task you hold, a question answered by reading a file, or throwaway exploration that changes nothing: it is for durable work and durable answers, not for every request that has a verb in it.
---

# Cairn

Shared memory for everything worked on here: **tasks** (what needs doing and how it ended),
**notes** (what was tried, including what failed), **knowledge** (what is now true, outliving
any task) and **sessions** (recorded for you). `cairn check` searches all four at once.
Refs like `ACME-42` are your project key plus a number.

## The lifecycle — every time you do durable work

Durable means it changes something, decides something, or rules something out: a fix, a
config change, a deploy, a migration, an investigation, a delegation. Size is irrelevant.

1. **Check.** `cairn check "<subject>"` before reading deeply, changing anything or
   delegating; `show` the hits that matter. Do not re-debug something already answered.
2. **Own it.** Reuse an open task, or file one. From an agent runtime `cairn add` **claims
   by default** (it says so; `--no-start` only files), holding back, saying why, when
   similar open work exists or you already hold a task there. Otherwise `cairn claim <ref>`
   — it sets `doing` and prints what bears on the task. **Exit 9 means another agent holds
   it: pick different work**, never force it. What you file is **your human's** unless
   `--assignee <who>`.
3. **Record as it happens.** `cairn note <ref> "…" --kind attempt|finding|decision|handoff`;
   text is `"…"`, `-` (stdin) or `--body <text|->`.
   **Dead ends are `--kind attempt`** — "tried X, no change" is the note the next agent
   needs most, because the trying is the expensive part.
4. **Checkpoint before you yield.** `cairn checkpoint <ref> --summary "state + next step"`
   after each milestone and before pausing, delegating or ending the turn. It alone
   tells whoever resumes where you got to.
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
asserts thirty pieces of in-flight work nobody is doing. File new tasks during a sweep
with `--no-start`.

**When not to file.** A tracker that fires on everything costs more than it records.
- **A task you hold already covers it** — note on it, or `--parent` a genuinely separate piece.
- **Another agent holds it** — a live claim in `check` is an answer; pick different work.
- **Reading a file answers it** — Cairn knows what happened to the code, not what it says.
  `check` first only if the subject has a past (a recurring failure, a decision, a try).
- **Throwaway exploration** — until you change something or learn something durable.
- **A fact that expires** — a note, or nothing.
- **Narrating your bookkeeping** — a note is not a progress log.

A session that files nothing is fine: sessions are recorded regardless. The failure is a
session that changed or ruled something out and left no trace.

---

## Check, show, recall

```bash
cairn check "flaky auth redirect"  # index: one line per hit, answered?, ~token cost
cairn show ACME-42          # digest: the answer, findings, a clipped body
cairn show ACME-42 --full   # everything; update --body replaces it: edit this
cairn log ACME-42           # what agents said · cairn history: what actually changed
cairn recall ACME-42        # decisions and facts that bear on this task
cairn know <slug>           # read a knowledge hit
```

`#0` means the subject is new. `--kinds task,note,knowledge,session` narrows `check`
(default: all — you cannot know which store holds the answer); `--assignee me|<who>` keeps
one person's tasks. Never pull bodies in bulk — the index is for choosing what to read.

`recall` starts from the task: resolutions and decision/finding notes on related tasks and
knowledge on its files, each with why it was picked. `claim` prints the top of it — read
it; "do not read that closure as permission for this" is the line you would not know to
look for.

## Before you stop

Close what you finished (resolution, right `--kind`); `note --kind attempt` what failed;
`learn` what stays true, scoped; checkpoint what you still hold. Nothing writes your
checkpoint for you.

## Beside this file

Read the one you need, when you need it; the lifecycle above is enough to work.

- `reference.md`: **evidence** (`commit`, `push`, `run`); **filing and the body** (types, what a
  body needs, the markdown the server enforces); **knowledge** (`learn`, scope, `relearn`,
  stale facts); **claims and liveness** (leases, what the sweep releases); **dependencies,
  parents, duplicates**; **briefing and `next`**; **output, exit codes** (exit 10: several
  instances, never pick one yourself) and rare verbs.
- `lab.md`: **Lab on** (`cairn lab`)? Exploring an idea is a subject, `LAB-n`. Read it first.
  `cairn handoff` (work leaving this instance) is there too.
