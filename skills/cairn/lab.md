# Cairn: the Lab, and work that leaves

Read when `cairn lab` says the Lab is on (the briefing then has a `Lab:` line), or when a
task has to leave this instance. Everything in `SKILL.md` still applies; this adds what the
Lab changes. If a Lab verb answers `lab_disabled`, it is off here: use tasks.

## What a subject is

Anything being **explored or proved** before it becomes committed work is a **subject**
(`LAB-12`): a technology to evaluate, a proof of concept, an idea. It has a markdown
write-up, a log, tags, an owner, optionally a project, a **stage** and, in the end, a
**conclusion**. Its **todos** are ordinary tasks: every task verb works on them unchanged.

An idea is a subject in a `planned` stage. There is no separate idea object.

## The lifecycle

```bash
cairn check "pgvector for recall"       # subjects come back too (--kinds subject narrows)
cairn idea "pgvector for recall" --tag search --body -   # first planned stage
cairn subject add "pgvector for recall" --stage exploring --project ACME --body -
cairn subject todo LAB-12 "benchmark 1M rows" --body -   # an ordinary task of the subject
cairn subject note LAB-12 - --kind finding|decision|attempt
cairn subject stage LAB-12 rejected --conclusion -       # a closing stage needs the answer
cairn subject show LAB-12 [--full]      # conclusion, todos, write-up, log (cairn show LAB-12 too)
cairn subject list [--stage S] [--category planned] [--tag t] [--mine] [--project K]
cairn ideas                             # the planned subjects: what the lab has not started
```

1. **Check first.** The lab may already have concluded ("rejected: no row-level security").
   `show` the hits that matter; `#0` means the subject is new.
2. **File it once.** The question, why it matters, what would settle it. A subject that
   already covers it gets a todo or a note, not a second subject.
3. **Todos are tasks.** From an agent runtime `subject todo` **claims by default**
   (`--no-start` only files it; exit 9 on `claim` means pick different work). An existing
   task joins with `cairn update <ref> --subject LAB-12`, a new one with `cairn add …
   --subject LAB-12`; `--subject none` unlinks. Note, checkpoint and close them with a
   resolution like any task. They are filed in the subject's project, else the lab's home
   project.
4. **Log on the subject** with `subject note … --kind finding|decision|attempt`; **dead
   ends are `attempt`** ("tried HNSW at m=16, recall 0.71"). A stage move writes its own log
   line: do not narrate it. People's cards on it are `subject notes LAB-12` (read-only here).
5. **Conclude.** **Entering a completed or dropped stage requires a conclusion**: what the
   lab concluded, and why. `rejected` with a clear reason is a result, not a failure: it is
   what stops the next agent re-evaluating the same thing. Without it the server answers
   `conclusion_required`: pass `--conclusion -`. The conclusion is the answer the next
   `check` finds.

Bodies, notes and conclusions are markdown (`##` headings, lists, paths in backticks); a
wall of text is refused, and so are secrets.

## Stages, tags, who may change what

```bash
cairn lab                  # the settings: on or off, the home project for todos
cairn lab stages | tags    # the curated lists, in board order
```

Stages are `planned` (ideas), `active` (under way), `completed` and `dropped` (both need a
conclusion). Adding, editing, removing and ordering stages and tags is an administrator's
(`cairn lab stages add|edit|remove|order`, `cairn lab tags add|edit|remove`). Switching the
Lab on or off and choosing its home project (`cairn lab on|off|home <KEY>`) is a **human**
administrator's: an agent key is refused, even an administrator's.

## When not to file a subject

- The work is committed already: that is a task. A todo that outgrows its subject is still
  a task; it leaves with `handoff`.
- A fact that will still be true next month: `cairn learn`.
- A file or one command answers it.

A subject filed by mistake is deleted (`cairn subject delete LAB-n --confirm LAB-n`),
which refuses while it has todos and never deletes one (`--detach-todos` unlinks them).
One that was explored and dropped is concluded or archived (`cairn subject archive LAB-n`),
never deleted: that record is the answer.

## Hand-off: work that leaves this instance

Not a Lab feature: it works on any task, with the Lab on or off. When committed work belongs
in another Cairn instance or a GitHub repository, hand it over instead of copying it:

```bash
cairn handoff ACME-42 --to work:KDP            # another configured instance (cairn instance)
cairn handoff ACME-42 --to github:acme/api     # an issue, through `gh`
cairn handoff ACME-42                          # where its project's default says
cairn handoff ACME-42 --link KDP-41 [--url URL]   # record a task you made by hand
cairn handoff ACME-42 --undo                   # take it back; nothing is done there
cairn project handoff ACME --to github:acme/api   # a project's default (--clear removes it)
cairn sync                                     # read every handed-off task's status back
```

It files the task there (title, body, a line saying where it came from), records the link
here with the destination's absolute https URL, and releases your claim. **From then on the
other tracker owns the status**: claim, release, close or move the task here and the server
answers `handed_off`, **exit 1** (not 9, which is another agent holding it): work it there,
or `--undo` to take it back. `sync` reads each one through that tracker's
own CLI and credentials on this machine (`cairn` for another instance, `gh` for GitHub) and
skips, saying so, those it cannot reach. A task that ended there is closed here once, with
their resolution, and a todo's subject gets a line for it: then decide the subject's stage,
often with a conclusion.

Moving a task between projects of this instance is `cairn update <ref> --project`, not a
hand-off.
