# Cairn on OpenClaw

OpenClaw gets Cairn through three things, and each one has a trap that fails silently:

| | how | the trap |
|---|---|---|
| **Briefing** at session start | the `cairn-briefing` hook on `agent:bootstrap` | a hook OpenClaw does not *discover* is enabled in config and never runs |
| **Rules** the agent follows | a Cairn block in the workspace's `AGENTS.md`, plus the skill | a hand-written block drifts from the CLI, and the agent follows the stale one |
| **Sessions** recorded | the `openclaw-sessions` job sweeping transcripts | OpenClaw has no session-end event, so nothing else records them |

## 1. The briefing hook

`hooks/openclaw/cairn-briefing/` is a standard OpenClaw hook (`HOOK.md` + `handler.ts`).
On `agent:bootstrap` it runs `cairn context --cwd <workspaceDir>` as `CAIRN_AGENT=openclaw`,
with a 5 second deadline, and adds one bootstrap file, `CAIRN.md`: a seven-line lifecycle
rule followed by the live briefing (what the agent holds, what is in flight, where the last
session stopped). If the CLI is missing, slow or failing, the rule is injected alone; if
anything else goes wrong, the session starts as if the hook were not there.

Install it as the user the gateway runs as:

```bash
node scripts/install-hooks.mjs            # --dry-run prints the exact command instead
```

It only links for an account that has an OpenClaw config (`~/.openclaw/openclaw.json`, or
`OPENCLAW_CONFIG_PATH`). A global install puts `openclaw` on every account's PATH, and
linking from one that runs no gateway would create a config nobody reads while the real
gateway stays unbriefed — so that account is skipped and says so. Pass `--openclaw` to link
anyway, for a gateway you have not configured yet.

With `openclaw` on PATH (or `CAIRN_OPENCLAW_BIN` pointing at it) and a config present, that
copies the hook to `~/.cairn/hooks/openclaw/cairn-briefing` and runs:

```bash
openclaw hooks install --link ~/.cairn/hooks/openclaw/cairn-briefing --force
```

Then **restart the gateway** — OpenClaw loads hooks only when it starts. Releases of
OpenClaw that do not know `--force` get the same command without it. The copy under
`~/.cairn` is kept current by `scripts/sync-agent-files.mjs` (the `agent-files` job); a
gateway running as a different user than the job is reached with
`--also hook:openclaw-briefing=<its home>/.cairn/hooks/openclaw/cairn-briefing/handler.ts`
and the same for `hook:openclaw-briefing-doc` and `HOOK.md`. A changed handler, like a new
one, loads on the next gateway restart.

Check it after the restart:

- `openclaw hooks list --json` lists `cairn-briefing` as loadable and enabled;
- the gateway log's count of loaded internal hook handlers went up by one;
- the next session's first turn has a `CAIRN.md` section with the rule at the top.

### Discovery: where a hook has to live

OpenClaw discovers directory hooks only in:

1. `<workspace>/hooks/` — the **current** agent workspace;
2. the managed directory `~/.openclaw/hooks/`;
3. `hooks.internal.load.extraDirs` in `openclaw.json` (what `hooks install --link` writes);
4. plugins, and the hooks bundled with OpenClaw.

Two ways this goes wrong without a single error:

- **The workspace moves.** A hook kept in `<old workspace>/hooks/` stops being discovered
  the day `agents.defaults.workspace` changes, and its `hooks.internal.entries.<name>.enabled:
  true` keeps looking correct. One installation lost its bootstrap hook this way for months:
  the gateway logged the bundled hooks only, and the rule never reached a single session.
- **`hooks.path` is not a hook directory.** It is the URL path of the *webhook* HTTP
  ingress. Pointing it at a folder of hooks does nothing for discovery.

Link the **single hook directory**, not a folder that holds many: a non-empty `extraDirs`
entry is scanned for every hook under it, so linking a collection enables all of them. If
you already run a hand-made bootstrap hook that injects Cairn (a "task enforcer" or
similar), disable it once this one is linked, or the agent reads two briefings.

## 2. The AGENTS.md block

The hook carries the rule, but `AGENTS.md` is what the agent reads as policy, so it must say
the same thing. Replace every Cairn section in the workspace's `AGENTS.md` with one block
like this (about 1.5 KB), and point any other file that restates the rules (a `SOUL.md`
line, say) at it instead of repeating them:

````markdown
## Cairn — track durable work
Before durable work (a fix, config change, deploy, migration, investigation or delegation):
`cairn check "<subject>"`, and `show` the hits that matter. The live briefing is injected at
session start; `cairn context` re-runs it.
```
cairn add "Title" --project <KEY> --type bug --priority high --body -   # claims by default; or `cairn claim <ref>`
cairn note <REF> "…" --kind attempt|finding|decision|handoff  # as it happens; dead ends are attempts
cairn checkpoint <REF> --summary "state + next step"         # after milestones, before yielding
cairn update <REF> --status in-review                        # written but not landed/pushed/deployed
cairn done <REF> --resolution "what changed and why" --kind fixed|verified|answered|wont-fix|duplicate|superseded
```
`claim` exiting 9 means another agent holds it: pick other work. Sweeping a backlog: claim
one task for the sweep and note on the rest. A bug or spike needs a body: what happens vs
expected, how to reproduce, what you ruled out, why now.
**Knowledge:** `cairn learn "<what is now true>" --body -` with an explicit scope —
`--project <KEY>`, `--entity <name>` or `--global`. Use `relearn <slug>` to correct an
entry, `verify <slug>` to confirm one.
**When not to file:** trivia; work a task you already hold covers (note on it); work
another agent holds; a question reading a file answers; throwaway exploration. A session
that files nothing is fine — sessions are recorded for you.
````

Things this block deliberately does **not** say, because each has been in one and was wrong:

- **"Track ANYTHING, no exceptions, add it retroactively."** It fills the board with tasks
  nobody will look up, filed without bodies, and contradicts the skill's durability test.
- **`cairn learn "<…>"` with no scope, annotated as global.** See below.
- **"Two hours of silence releases the claim"** as a guarantee. It is true only where the
  maintenance `reconcile` job runs (`scripts/install-cron.mjs`), and then it means: no beat,
  note, checkpoint, edit, commit, push or run for two hours, found by a sweep every 30
  minutes; `doing` returns to `todo`, `in-review` keeps its status.
- **"Session end checkpoints what you hold."** The recorder checkpoints only what the
  session worked on and never over a checkpoint the agent wrote; the agent's own checkpoint
  is the handoff.

### Why an unscoped `learn` fails on OpenClaw

`cairn learn` with no `--project`, `--entity` or `--global` takes the project of the
directory it runs in, and **refuses when there is none** — "global" is a claim about every
project, so it has to be chosen. An OpenClaw workspace is usually not a mapped checkout, so
from there an unscoped `learn` is always refused. An instruction that teaches the unscoped
form therefore teaches a command that never works, and agents stop writing knowledge at
all. Name the scope in the block, as above, or `cairn map <KEY>` the workspace if it really
is one project's.

## 3. Sessions and identity

- **Sessions:** `node scripts/install-cron.mjs` installs `openclaw-sessions`, which runs
  `hooks/cairn-session-end.mjs --scan "$CAIRN_OPENCLAW_SESSIONS"` every 30 minutes.
- **Identity:** set `CAIRN_AGENT=openclaw` where the gateway starts (the hook sets it for its
  own call), and give OpenClaw its own `CAIRN_API_KEY_OPENCLAW` in `~/.cairn/env`. OpenClaw
  runs on Codex, so without its own key its work is filed under whichever runtime owns the
  key it borrows.
- **Skill:** copy `skills/cairn` into the workspace's skills directory; `sync-agent-files
  --also skill=<that path>/cairn/SKILL.md` keeps it current.
