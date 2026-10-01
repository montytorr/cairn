# Changelog

Notable changes, newest first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

Cairn is pre-1.0: the schema, API and CLI are in daily use and stable in practice, but a
minor bump may still change them. Anything that would break an existing install is called
out under **Breaking** with what to do about it.

## [Unreleased]

### Added

- **A machine with only Codex gets session prose** (CAIRN-337, S-15). The summariser was
  always `claude -p`, so a Codex-only machine recorded every session without its four prose
  fields, and OpenClaw's GPT sessions on clawdius were written up by Claude as another
  account. A session is now summarised by the runtime that produced it — `claude` for
  Claude Code, `codex exec` (`gpt-6-luna`) for Codex and OpenClaw — falling back to
  whichever is installed. `CAIRN_SUMMARY_BACKEND` forces one; `CAIRN_SUMMARY_CLI` alone
  still means `claude`, so existing wrappers keep working. The codex child runs with no
  shell, no MCP, no hooks and no saved session: `--sandbox read-only` on its own still let
  it read any file.
- **`install-cron.mjs` carries the summariser settings into the OpenClaw sweep**:
  `CAIRN_SUMMARY_BACKEND`, `CAIRN_SUMMARY_MODEL`, `CAIRN_SUMMARY_CODEX_MODEL` and
  `CAIRN_SUMMARY_LANGUAGE`, when set. Before, the sweep could only use claude's default.
- **Task web links in the CLI.** `show`, `add`, `list`, `next` and the task rows of `check`
  carry a `url` (last column in TSV) pointing at the task's page on the instance that
  answered, and the skill tells agents to cite tasks to the human as `[KEY-N](url)`.
- **The account menu shows the running version, and a changelog page.** A "Changelog" row
  with the version opens `/changelog`, which renders this file as the instance shipped it:
  one section per release, the running one marked, and anything merged since the release
  shown as "On main".

### Changed

- **No summariser is not an outage** (CAIRN-338). With neither `claude` nor `codex` on
  `PATH`, the session is no longer queued for four retries that cannot succeed, and the log
  says so once a day instead of once a turn. `install-hooks.mjs` reports which summariser
  this machine will use, or that there is none.

## [0.14.4] — 2026-10-01

### Fixed

- **The session summariser started every MCP server you have** (#119). `claude -p` is a full
  Claude Code session, so a server behind `op run` asked for 1Password on every SessionEnd
  and PreCompact, and slow servers ate into the 60 s timeout. The child now runs with
  `--strict-mcp-config` and an empty `--mcp-config`.
- **Summaries came out in a language nobody used** (#121). The prompt never named one, and
  `--system-prompt` replaces the default that carries your preference, so a French session
  was written up in Spanish. The summary is now in the language of the person's own prompts;
  `CAIRN_SUMMARY_LANGUAGE` fixes one for everyone.
- **The summariser had tools.** The fence from 0.14.0 keeps it from obeying the transcript;
  it now also runs with `--tools ""`, so a transcript that got past the fence has nothing to
  act with. It inherited your permission settings, which under an allow-all mode meant a
  shell. A CLI too old for `--tools` is asked again without it.
- **The claimant avatar sat lower than the assignee's** in list rows and on board cards.

## [0.14.3] — 2026-09-30

### Fixed

- **A machine that is an OpenClaw client was taken for a gateway** (CAIRN-332). Setup and
  `install-hooks.mjs` counted any `gateway.mode`, or a top-level `agents` block, as "this
  account runs a gateway". A laptop that reaches another machine's gateway has exactly that:
  `gateway.mode: "remote"` and `agents` defaults. So a plain `cairn setup` there would pair an
  OpenClaw key nothing reads and link a hook no gateway loads. `mode: "remote"` now means a
  client, whatever else the file holds.
- **The "To undo" lines name only what was set up.** They listed Claude's and Codex's files
  on a machine that set up OpenClaw alone. They now list the hook and skill locations of the
  runtimes this run set up, including `$CLAWD_HOME/skills/cairn` for OpenClaw.

## [0.14.2] — 2026-09-30

### Fixed

- **`cairn setup` wired Hermes without being asked** (CAIRN-330). The hooks step passed
  `--runtimes` only when you typed it, so a plain `cairn setup` let the installer wire every
  runtime it found. That included Hermes Agent's `pre_llm_call` hook (through
  `hermes config set --force`) wherever `hermes` was on PATH, a runtime setup never detects
  or pairs a key for. Setup now always passes the runtimes it set up, to the hooks and to
  the `agent-files` job. With `hermes` on PATH and not chosen, it prints a line saying so
  and the command to add it. **If you relied on setup wiring Hermes**, run
  `cairn setup --runtimes <yours>,hermes` once: it pairs a Hermes key
  (`CAIRN_API_KEY_HERMES`) and wires the hook. `install-hooks.mjs` run by hand still wires
  everything it finds unless given `--runtimes`.

### Changed

- **`cairn setup` says what it is doing.** It opens with one line on what it sets up and
  that `--dry-run` shows the plan. A `runtimes` line says which runtimes get keys, hooks and
  skills, and whether they were detected or named. Every skip says how to undo it. It ends
  with the next step, the fact that re-running is the upgrade path, and the command that
  takes out each piece. The README gains a "What `cairn setup` does" table (step, what it
  writes, where, how to skip it, how to undo it) and what it never does.

## [0.14.1] — 2026-09-30

### Fixed

- **A machine on several instances at different releases never synced.** With no default
  instance, 0.14.0's `agent-files` job required every instance to report the same release,
  so a personal instance on 0.14.0 beside a company one on 0.12.1 refused every run. With a
  default, it followed that one even when it was the older, putting the CLI behind the newer
  server. The job now follows the newest release any instance reports, default or not, and
  leaves out an instance it cannot ask (a company instance behind a VPN, from home). It
  still writes nothing when no instance answers.

## [0.14.0] — 2026-09-30

### Security

- **The `agent-files` job no longer runs unpinned code from `main` (#110).** Every 15 minutes
  it downloaded the CLI, the hooks every session runs, the skill and its own script from
  `raw.githubusercontent.com/montytorr/cairn/main` and wrote them with the user's rights, so
  any upstream commit reached every connected machine within the quarter hour. It now syncs
  `--source release`: each run asks the instance's `/api/v1/health` for its version and
  fetches that tag (`v<version>`). The version is validated first. If it cannot be read, or
  any file of the release is missing, the run writes nothing and exits 1. It does not fall
  back to `main`. Every file is fetched before any is written. From a remote source the job
  no longer replaces `sync-agent-files.mjs` or `install-cron.mjs`; `install-cron.mjs
  --install`, which `cairn setup` runs, refreshes them from the release it unpacked. A job
  installed earlier still names the old `main` URL, and the updated script reads that exact
  URL as `release`, so existing machines are pinned from their next run without re-running
  setup. `CAIRN_RAW_BASE` still follows a URL as given, now only as a deliberate opt-in
  rendered with `--unpinned`. On a machine with several instances the job follows the
  default one. Without a default, the instances must agree on one release.
- **`cairn setup` schedules the source it was installed from.** With `CAIRN_SETUP_SOURCE`, the
  job syncs from that checkout (`install-cron.mjs --install --source <checkout>`) instead of
  the public repository. `CAIRN_REPO=<owner>/<name>` is read by `install.sh`, by `cairn
  setup` (the release tarball) and by the job (its tags). Before, the one-line install and
  the job could only come from `montytorr/cairn`. `CAIRN_RAW_REPO` takes any https mirror.
  Before installing the job, setup now says what it overwrites, how often, where from, and
  how to skip it (`--no-jobs`) or remove it.
- **`--runtimes` is respected by the hooks and the job.** `cairn setup --runtimes
  claude-code` still wrote Codex hooks to `~/.codex/hooks.json`, and the job still wrote the
  Codex skill, wherever `~/.codex` existed. `install-hooks.mjs --runtimes a,b` and
  `sync-agent-files.mjs --runtimes a,b` wire only those runtimes. Setup passes the list when
  it was named. Without the flag, both detect runtimes as before.

### Added

- **Herdr shows the task each agent pane holds.** Inside a Herdr pane, `claim`, a claiming
  `add`, `beat` and `checkpoint` publish `<ref> · <title>` as a `cairn_task` pane token (TTL two hours,
  the claim's own), and `done`, `cancel`, `release` and `session end` clear it. It is
  detached and silent, and `CAIRN_HERDR=0` turns it off. The new `cairn.pane-title` plugin
  (`hooks/herdr/pane-title/`) labels the pane border, the sidebar rows and the focused tab:
  Cairn task, then session title, then terminal title, then agent name; a tab name you typed
  is never replaced. `cairn setup` links it when `herdr` is on PATH (`--no-herdr` skips),
  names a plugin that writes the same rows without removing it, and does not touch
  `config.toml`. See `docs/herdr.md`.

### Fixed

- **The summariser could answer the transcript instead of summarising it.** The session-end
  hook sent its instructions and the session digest as one user turn, so a digest whose last
  prompt asked the agent a question ("do you need to record knowledge after this session?")
  was sometimes answered in prose, logged as `no JSON in output`, and queued for a retry that
  failed the same way. The instructions now go in `--system-prompt` and the user turn holds
  only the digest, fenced in `<transcript>` tags and framed as data, not instructions.

## [0.13.0] — 2026-09-30

### Added

- **The session briefing carries Croft's brief.** Croft, the lab board of subjects being
  explored, proved or built, installs no session hook where Cairn's runs: one opener per
  session, as with Trig. The context hook now keeps a short list of siblings. Trig's line is
  unchanged, and Croft's `croft context --brief --cwd <dir>` follows Cairn's block, clipped
  to 5 lines and 600 bytes. Each sibling runs beside Cairn's own call on a 1.5 s deadline
  and says nothing when absent, failing, slow or empty. `CROFT_CLI` names the binary; without
  it the hook also looks in `~/.local/bin`, which a runtime's PATH often lacks. The OpenClaw
  briefing, which had no Trig line, now carries both. Siblings are skipped inside a
  summariser and on the per-file `PreToolUse` question. Re-run
  `node scripts/install-hooks.mjs` (or `cairn setup`) to pick up the new hook.
- **`CROFT_SUMMARISER` joins the summariser guard.** The session-end and learn-nudge hooks
  stay out of Croft's summariser children, and Cairn's own summariser sets the flag so
  Croft's hooks stay out of its runs.
- **The skill says when an idea belongs in Croft.** Exploring, evaluating or proving it is a
  Croft subject; changing a repo for real is a Cairn task, and Croft's todos arrive here
  labelled `croft:T-n` with Cairn owning their status.

### Fixed

- **Editing a description destroyed its tables** (CAIRN-326). The rich editor had no table
  node, so a GFM table showed as flattened text and was saved back that way after any edit;
  raw HTML was dropped the same way. Tables are now part of the editor, drawn as the page
  draws them, and come back from an edit byte-for-byte: alignment, inline code and bold in
  cells, and escaped pipes all survive. A body the rich editor would still lose part of (raw
  HTML, a heading below level 3, a footnote, a table row wider than its header) opens as
  its markdown in a plain textarea instead, with the reason under it.
- **A slow sibling held the session briefing open.** Killing a sibling that had forked left
  its child holding the pipes, and the hook could not exit until that child did: 5 s instead
  of the 1.5 s deadline on Linux. The hook now drops the pipes on its deadline, and the
  OpenClaw briefing keeps its own deadline rather than waiting on the child.

## [0.12.1] — 2026-09-29

### Added

- **Agents are asked to `cairn learn`** (CAIRN-323). `cairn done` ends, for an agent, by
  asking whether the task established anything the next agent should know, with the command
  to record it. On Claude Code and Codex a new `Stop` hook asks the same question once per
  session, after a turn that edited a file or committed, which covers sessions that close no
  task. Neither calls a model. `CAIRN_LEARN_NUDGE=0` turns the hook off. Re-run
  `node scripts/install-hooks.mjs` (or `cairn setup`) to wire it.

### Fixed

- **A late CI run could roll a deploy back** (CAIRN-318). Each successful CI run on `main`
  deployed its own commit. Two pushes close together could finish CI out of order, and the
  older commit then deployed last: v0.12.0's release commit was replaced by the merge before
  it. A gate job now deploys a commit only if it is still the tip of `main`. A superseded one
  stands down, since the newer commit's own run deploys it.
- **Codex closed its session on the first turn** (CAIRN-319). Its `Stop` hook ran the
  recorder as a session end, so every turn ended the session, which cannot be reopened, and
  checkpointed every held task. `Stop` now writes a live checkpoint and Codex's `SessionEnd`
  closes the session. A session whose row is already closed answers `409 session_closed`
  (CLI exit 11), and the hook stops summarising and checkpointing it until its real close.
  Re-run `node scripts/install-hooks.mjs` (or `cairn setup`) and trust the new `SessionEnd`
  entry in `~/.codex/config.toml`.
- **`cairn context` hid the session in progress** (CAIRN-320). It picked the last session by
  end time, so an open one only showed when nothing here had ever finished. It now picks the
  latest by activity, and the briefing says when that session is still open.
- **Session prose skipped the secret check** (CAIRN-322). `request`, `learned`,
  `completed` and `next steps` are written by a model from raw transcripts. Secret-shaped
  strings in them are now redacted to `[redacted <rule>]` rather than refused, since a
  refusal would lose the background recorder's whole record. The response lists each one.
- **A manual `cairn session end` from Codex or OpenClaw wrote a second row** (CAIRN-321).
  Without `--platform` it was filed as `claude`; the platform now comes from the runtime.
  The summariser check also reads through OpenClaw's conversation wrapper, and the vitals
  leave out any tool's summariser runs, not only Cairn's.

## [0.12.0] — 2026-09-29

### Changed

- **Breaking: the admin key endpoints answer in the same shape as Your agent keys**
  (CAIRN-317).
  - `GET /api/v1/users/{id}/keys` returned raw rows (`agent_name`, `key_prefix`,
    `last_used_at`, `revoked_at`, `created_at`); it now returns what `GET /api/v1/me/keys`
    does (`agentName`, `keyPrefix`, `lastUsedAt`, `revokedAt`, `createdAt`, `revoked`).
  - Creating a key and revoking one answer in the same camelCase.
  - All three are now documented in the OpenAPI spec, with one shared key schema.
  - `revoked` is true for a key disabled by an account-wide reset too, which `revokedAt`
    alone does not show, so `/users` now marks those correctly.
  - Nothing in the repository outside the admin page read the old shape. Update any script
    that calls these endpoints directly.

## [0.11.1] — 2026-09-29

### Added

- **Your agent keys** (CAIRN-315). Anyone could pair keys for their own agents since 0.11.0,
  but only an administrator could see or revoke them. `/settings/keys`, in the user menu,
  lists your keys grouped by the host they were paired on, and revokes one or a whole host. A
  revoked key is refused on its next request. `GET /api/v1/me/keys` and
  `DELETE /api/v1/me/keys/{keyId}` are for a signed-in person only: an agent key gets 403,
  and another person's key reads as 404.
- **`cairn setup` installs OpenClaw's session sweep** (CAIRN-316). OpenClaw has no session-end
  event, so its sessions are recorded only by the `openclaw-sessions` job. Setup found the
  gateway and paired its key but never installed the job. It now does, deriving the sessions
  directory from the gateway's home, or says which variable to set when it cannot.

### Changed

- **`cairn setup --yes` is gone.** It was accepted and did nothing, since setup asks nothing.

### Fixed

- **An unreachable instance blocked every ref on the others.** With one instance out of reach
  (Dispofi behind an office-only firewall, say), its cached project keys went stale. Every
  command naming a ref another instance owns was then refused: "project ownership data is
  stale". Routing now first tries a short refresh (1.5s, in parallel) of any stale instance.
  - One that answers is used as if it had been fresh.
  - One that cannot be reached blocks only the refs its own last-known keys claim.
  - A single fresh owner then routes, with a note on stderr.
  - An instance never reached at all still blocks the fallback to a default.
- **A write to an archived project is refused** (409, naming the project and how to reach
  where it went). A project moved to another instance leaves an archived copy, and a client
  still routing to the old instance could close or annotate tasks there. Every task write
  checks its home project now (notes, claims, checkpoints, evidence, dependencies,
  attachments, creation); reads are untouched. The CLI's outbox treats the 409 as final.
- **Scheduled jobs on cron are shell-quoted.** `install-cron` joined commands unquoted into
  the crontab, so a path with a space broke a job, and a crafted directory name could run a
  command. Every value is single-quoted and `%` escaped, and names derived for the OpenClaw
  sweep must be plain. `--only` now replaces just those jobs, instead of dropping the others,
  so re-running `cairn setup` on Linux no longer uninstalls `reconcile` and `vitals`.
- **Your agent keys** shows a key disabled by an account-wide reset as revoked, not active.
- **Revoking a key by a malformed id** answered 500 (a Postgres cast error). It is a 404 now.

## [0.11.0] — 2026-09-29

### Added

- **`cairn setup` connects a machine in one command** (CAIRN-314). It replaces four scripts
  and hand copying:
  1. Registers the instance, single or one of several.
  2. Checks the server.
  3. Detects Claude Code, Codex and OpenClaw.
  4. Pairs for any missing keys.
  5. Fetches the release files pinned to its own version, from
     `codeload.github.com/…/v<version>` rather than the raw CDN that serves stale copies for
     minutes after a push.
  6. Installs the CLI into `~/.local/bin`, the skill into each runtime, and the hooks.
  7. Installs the `agent-files` sync job. `reconcile` and `vitals` are workspace chores, so
     they come only with `--maintenance`.
  8. Checks its version against the server's.

  Re-running it is the upgrade path: working keys are kept and unchanged files left alone.
  Flags: `--dry-run`, `--name`, `--runtimes`, `--no-skill`, `--no-hooks`, `--no-jobs`,
  `--maintenance`. `install.sh` at the repository root puts the CLI on PATH and runs it:
  `curl -fsSL https://raw.githubusercontent.com/montytorr/cairn/main/install.sh | sh -s -- --url <instance>`.
- **Browser pairing: a machine gets keys without an admin** (CAIRN-314).
  - `cairn setup` asks `POST /api/v1/connect` for a code and prints `<instance>/connect/<CODE>`.
  - The person approves in the browser where they are signed in, and can untick runtimes.
  - The CLI's `POST /api/v1/connect/poll` then receives keys minted at that moment, once, for
    that person's own agents, each named `<runtime> on <host>`.
  - Device codes are stored hashed and expire in ten minutes. Approval takes a signed-in human
    (an agent key gets 403) and every state change is one conditional `UPDATE`.
  - Admins still manage everyone else's keys. A `maintenance` key releases anyone's claims, so
    only an administrator can approve one, and the role is checked again at minting.
    `cairn setup --maintenance` pairs it on its own, so a member's own keys never wait on it.
  - Against device-code phishing, the approval card says to approve only a `cairn setup` you
    just ran yourself, and flags a request from a different network address than yours. The
    host is shown "as reported" and restricted to hostname characters.
  - Both unauthenticated endpoints are rate-limited per address. A poll reads without a
    transaction, and only a redemption opens one. Consumed requests are kept 90 days as the
    record of who approved which host.
  - Migration 068 adds `connect_requests`.

### Changed

- **The docs and messages send people to `cairn setup`.** The README opens with the
  one-line install, and its key, API, scheduled-job and several-instances sections describe
  pairing. SECURITY.md covers it and its phishing risk, `AGENTS.md` and the skill say a
  person pairs keys with `cairn setup`, and the CLI's "no key" errors name the command.

### Fixed

- **`cairn setup` adding a second instance disconnected the first.** A machine set up for one
  instance keeps its keys in `~/.cairn/env`, which is no longer read once instances are
  configured. Setup now adopts it as an instance of its own, still the default, before
  registering the new one.

- **An expired session lost where it was going.** The middleware lets any request with a
  session cookie through; when the layout then found the session invalid it sent a bare
  `/login`, so signing in landed on `/` instead of, say, a `/connect/<code>` approval. The
  middleware now passes the requested path along and the redirect keeps it.
- **`/login?redirect=` could leave the site.** `/\host`, and a tab or newline after the first
  slash (the URL parser drops them), all read as another host. The destination is now parsed
  the way the browser will parse it and kept only when it stays on this site.

## [0.10.1] — 2026-09-29

### Fixed

- **The home list drew every assignee as "?"** (CAIRN-313). `listAllTasks` returned the
  assignee's id but never the person, so the cross-project list at `/` had nobody to name;
  the project lists and the task page did. It now names them in one query, as they do.
- **The task sidebar scrolled sideways** (CAIRN-313). Its pane set `overflow-y-auto` and
  nothing on x, which the spec turns into `auto`, and several values refused to shrink: labels
  were clipped on the left, long agent labels and dates ran off the right.
- **An empty due date looked like today's date.** WebKit draws a grey placeholder date in an
  empty native date input; the row now reads "No due date".
- **A claim's response names its assignee** instead of carrying the bare user id.

- **A closed or fully shown task names its assignee in one line.** `cairn done`, `cancel`
  and `show --full` printed the nested assignee as four TSV rows (`assignee.id`, `.email`,
  `.name`, `.active`); they now print `assignee<TAB>name`, as `add` and `update` already did.
  `claim`, `beat`, `release`, `checkpoint` and `block` go through the same step. `--json` is
  unchanged.
- **The skill's `cairn block` example was a command the CLI refuses** — the reason was
  positional; it is `--reason "…"`.

### Changed

- **The task sidebar is a property list** (CAIRN-313): label beside value, every value
  truncated with its full text on hover, grouped into properties, relations and a quiet
  footer (created, updated, by whom), 18rem wide. Held by shows the agent alone when its human
  is the assignee, with staleness as a dot rather than a wrapped suffix; Labels always offers
  "Add label"; the due date is a row that opens the picker, turns red when overdue on open
  work, and clears with ×; Blocked by and Blocks say "None" in line.
- **The agent guidance catches up with 0.10.0.** The skill names `cairn people`,
  `check`/`next --assignee` and the briefing's "Assigned to you, nobody on it"; the session
  briefing's rules and the OpenClaw hook's rule say bodies are markdown; `--help` lists
  `show --full` and `update --body`; `AGENTS.md` says `show` is a digest and `claim` exits 9.
- **The OpenAPI document** says what `POST /projects/{id}/tasks` and `PATCH /tasks/{ref}`
  refuse (an agent's wall-of-text description, with `problems`; the create lists its 400),
  that `assignee` reassigns and `dueDate: null` clears, that the digest carries
  `assignee` and `createdBy`, and that `/users` rows carry `openTaskCount`.
- **README**: the API list gains `/branding`, `?assignee=` on `/search` and `/next`, and
  `reassignTo` on disabling a user; the CLI table covers `check --kinds`, `list` filters,
  `projects --archived`, `vitals --notify` and `--version`; the board groups by assignee;
  the MCP section names `cairn_check`'s `assignee`; the examples show the assignee.

## [0.10.0] — 2026-09-29

### Added

- **Every task has a human assignee** (CAIRN-310). A task recorded who filed it (`actor_id`,
  a frozen label) and which agent is executing it (`claimed_by`), but never whose it is — and
  those are three facts: an agent files work for its human, another agent may claim it, and
  the human stays accountable after the claim ends. `tasks.assignee_user_id` is that human, a
  real user and never null (migration 067, backfilled from each task's creator, falling back
  to the project owner; reassignments are an `assignee_changed` activity event).
  - *Default.* A task is assigned to the human behind the caller — for an agent, the user its
    key was issued to. `assignee` names someone else: `me`, an email, a display name or a
    user id; an unknown, ambiguous or inactive user is refused, never guessed.
  - *API.* `assignee` on `POST /projects/{id}/tasks` and `PATCH /tasks/{ref}`,
    `?assignee=` on the task list, and `assignee: {id, email, name, active}` on task rows.
    `show`'s digest carries `assignee` and `createdBy`. `GET /api/v1/people` lists who can be
    assigned, for any authenticated caller, agents included.
  - *CLI.* `add --assignee`, `update <ref> --assignee`, `list --assignee me|<who>`, an
    `assignee` column in `list`, an `assignee` line in what `add` and `update` print, and
    `cairn people`. `--mine` keeps its meaning — what this agent holds now; `--assignee me`
    is what your human owns.
  - *MCP.* `cairn_add` and `cairn_list` take an optional `assignee`.
  - *UI.* The assignee is shown and editable on a task.
  - *Guidance.* The skill, `AGENTS.md`, the OpenClaw block and hook, and the session briefing
    say the rule: assigned to your human unless `--assignee` says otherwise; the assignee owns
    the work, the claim is only which agent is running it.
- **Disabling a user hands their open tasks on** (CAIRN-310). A disabled assignee silently
  orphaned every open task they owned. `DELETE /users/{id}` now refuses a user who is the
  assignee of open tasks (409, `reason: open_tasks`, with `openTaskCount`) until `reassignTo`
  names an active user; the tasks move in the same transaction as the disable, each with an
  `assignee_changed` event carrying `reason: user_deactivated`. On a user already disabled,
  `reassignTo` hands on the tasks orphaned before this rule. `/users` shows each user's open
  task count, and disabling someone who owns work asks who takes it over (you, by default).
- **`cairn next`, `check` and the briefing know whose work it is** (CAIRN-310).
  - *`next`.* Inside a tier, work assigned to your human ranks before anyone else's — ahead
    of priority, since an urgent task is urgent for whoever owns it. Someone else's work is
    still offered, never hidden, and its reason says so (`… · assigned to Julien`). Every pick
    carries `assignee`, and the CLI prints it on each line. `?assignee=` / `--assignee
    me|<who>` narrows the ranking to one person.
  - *`check`.* `--assignee me|<who>` (`?assignee=` on `GET /search`, `assignee` on
    `cairn_check`) keeps only that person's tasks. Like `--type`, it is a statement about
    tasks, so the answer is tasks only; it is chosen from the best 200 matches.
  - *Briefing.* A new "Assigned to you, nobody on it" section: your human's todo, backlog and
    doing tasks in this project with no live claim, five at most, most urgent first, then
    `+N more`. "In flight" and "Started and dropped" name the owner (`· Julien's`) when it is
    not your human, so a dropped task is not picked up as your own by mistake.
    `GET /context` returns `unattended: {tasks, more}` and `inFlight[].assignee`.

- **The task sidebar edits what the API already accepted** (CAIRN-311). Status, priority, type
  and assignee were the only editable fields on a task's page; project, labels, due date and
  parent were readable only, even though `PATCH /api/v1/tasks/{ref}` has taken all four since
  before this change.
  - *Project.* A select like the list view's, moving the task and — since per-project
    numbering means the ref changes — replacing the URL with the task's new one rather than
    leaving the page pointed at a ref that no longer resolves here.
  - *Labels.* The same add/remove popover the list view uses, offering labels already in use
    before a new one.
  - *Due date.* A native date field, clearable.
  - *Parent.* Click-to-edit, taking a ref; empty clears it.
  - `updateTaskSchema`'s `dueDate` now accepts `null` to clear it — it previously had no way
    to represent "no due date" on a PATCH, only "don't mention it."
- **An agent's task body has to read as markdown** (CAIRN-312). Agents filed walls of text —
  `WHY EMPTY TODAY:` in capitals where a heading belonged, one 600-character paragraph, paths
  and calls loose in the prose — and every fact was there but none was findable. The API now
  refuses such a description from an agent on `POST /projects/{id}/tasks` and on
  `PATCH /tasks/{ref}` when the description changes; people typing on the board are not
  checked. The refusal is `validation_failed` with `problems`, one instruction each, which
  `error` repeats for clients that print nothing else:
  - a capitalised label → the heading it should be (`"## Why empty today"`);
  - literal `\n` escapes → real line breaks;
  - a prose paragraph over 600 characters → a list or shorter paragraphs;
  - over 600 characters with no heading, list, table or code block → headings and lists;
  - bare paths (`src/a.js:303`), calls (`search()`), and dotted or snake-case identifiers →
    backticks, naming up to five.

  Code blocks and inline code are never checked, and a body under 200 characters only meets
  the first two rules and the last. The CLI prints the list; the skill, `AGENTS.md`, `--help`
  and the MCP `cairn_add` schema say the rule. Notes, comments and resolutions are not
  checked yet.

### Changed

- **"Unassigned" is now "Unclaimed"** wherever it meant *no agent holds this* — the board's
  agent lanes and filter, and a task's claim field. With a real assignee on every task, the
  old word said the opposite of the truth.


### Fixed

- **A due date read back as the day before, or not at all.** `date` columns came back as a
  local-midnight ISO timestamp: a day early on any host east of UTC, and a value no date input
  can show, so the task page saved a due date and then drew it blank. They are `YYYY-MM-DD`
  again, as PostgREST returned them.

## [0.9.0] — 2026-09-28

### Added

- **An instance can have its own name and colour** (CAIRN-306). Settings → Branding, for
  administrators: the name replaces "Cairn" in the sidebar, breadcrumbs, tab titles, login page
  and link previews, and the accent recolours the interface, the favicon and the home-screen
  icon. One colour is enough — each theme gets the nearest variant that stays readable on its
  background. Stored in the database (migration 066), so it survives a mirror's upstream sync
  and needs no rebuild. `GET`/`PUT /api/v1/branding`.
- **Every tab has a title of its own** — `Board · Cairn`, `HM-716 · Fix the thing · Cairn`
  — instead of fifteen tabs all called "Cairn".

### Changed

- **One pass over the whole interface, flat** (CAIRN-308).
  - *Surfaces.* Solid surfaces and one hairline between regions, with no glow, glass, gradient or
    shadow on anything that sits on the page. Only menus, dialogs and toasts float.
    - Cards, board lanes (with a 2px status-colour top line) and the resolution card are flat
      panels.
    - Status and day bands are solid, marked by a 2px edge in their colour.
    - The controls are flat, with a crisp accent rim on focus.
  - *Motion.* Quick and quiet:
    - pages fade in and the first rows of a list settle one after another;
    - the sidebar's active marker and the view tabs slide;
    - status icons animate between states;
    - pop-ups rise;
    - everything stands still under reduced motion.
  - *Signatures.* The activity feed and a task's work log are trails, a dotted line with a stone
    per event. Empty states are three stones settling, the top one in the accent. The login page's
    cairn is drawn flat in the mark's own geometry.
  - *Fixed along the way.* `ring-ring/*` focus rings rendered nothing, because the colour was
    never registered with Tailwind. A dialog opened from a list row could be trapped inside it.
    The change-key dialog now renders to the page body.
- **The family's type, everywhere** (CAIRN-307). Headings in Inter Tight at Cairn Cloud's
  weight and tracking, text in the system sans, refs and code in the system mono — the same three
  stacks as the site. Instrument Serif and IBM Plex are gone, and with them the italic serif
  headlines the family site had already dropped (MTC-2). Only Inter Tight is downloaded.
- **A new login page.** A panel that says what Cairn is, beside the form, and copy that is
  true: it said "Cairn is single-user; self-service signup is disabled", which stopped being
  the case when administrators could add people. A password can be shown while typing.
- **The sidebar header is the instance, not the person** — its mark and name, where it used to
  repeat the signed-in user's avatar that the menu at the foot already shows.
- **Primary buttons are lit and raised**, and brighten on hover instead of fading.

### Fixed

- **The header's health banner no longer sticks on a cleared alarm.** It read vitals through
  Next's `unstable_cache`, which serves a stale entry and refreshes it after the response; on App
  Runner, whose instances get no CPU between requests, and on a read-only root, where the entry
  cannot be written, that refresh did not land, and the banner kept "No session recorded" long
  after the database said otherwise. It is now a per-process memo that re-reads before answering
  once it is a minute old.

- **Nested task deletion routes to the owning instance** (CAIRN-305). `task delete <ref>` has
  its ref after the subcommand, so it was not included in early routing and could hit the
  configured default. The router now extracts it before making either the confirmation read or
  delete request, refuses stale/ambiguous project ownership even when a default exists, and
  drains oldest outbox shards first, stopping at the first transient failure.

- **A stale session cookie no longer loops between `/` and `/login`.** After a password change,
  an expiry or a revoked session the browser still sends the cookie; the app layout found it
  invalid and redirected to `/login`, and the middleware — which only checks that a cookie is
  present — sent `/login` straight back to `/`. The login page now decides, against the
  database: a real session goes to the app, anything else gets the form.

## [0.8.1] — 2026-09-28

### Fixed

- **Attachments broke on installs older than 2026-09-11** (CAIRN-303). The S3 backend in 0.8.0
  was switched on by `CAIRN_ATTACHMENT_BUCKET`, a name `.env.example` had used for the Supabase
  storage bucket (`=attachments`) until the move to native PostgreSQL. Those installs still
  carry it, so every upload, download and project delete went to an S3 bucket they do not have
  (`Region is missing`). The S3 settings are now `CAIRN_ATTACHMENT_S3_BUCKET`, `_S3_PREFIX` and
  `_S3_REGION`, and the old name is ignored. **If you set up S3 under 0.8.0, rename the
  variables.**
- **A sentence like "…changes the password: update-service without…" is no longer refused as a
  credential.** The prose exemption covered a single word after the key, not a hyphenated one,
  so an agent's handoff note was rejected with `secret_detected`. A hyphenated value alone on
  its line (`password: correct-horse-battery`) is still refused.
- **An archived project no longer claims its refs for instance routing.** When a project
  moves to another instance, the copy left behind is archived; its key still sat in that
  instance's routing cache, so a bare `cairn show HM-716` became ambiguous and fell back to the
  default instead of going where the project now lives. The cache holds active projects and
  the keys they used to have.
- **Security headers no longer depend on a proxy.** HSTS, `X-Frame-Options: DENY`,
  `nosniff` and a referrer policy were added by Traefik on the compose deployment; on a
  platform that terminates TLS itself, such as App Runner, the same image went out without them.
  The app now sets them. The README also notes that App Runner overrides `HOSTNAME`, which has
  to be set back to `0.0.0.0` on the service.

## [0.8.0] — 2026-09-28

### Added

- **Runs on a platform with no disk and no shell** (CAIRN-304) — App Runner, or Fargate
  without a volume. Attachments can live in a private S3 bucket (`CAIRN_ATTACHMENT_BUCKET`),
  still served through the app's signed links. `CAIRN_MIGRATE_ON_START=1` migrates before
  serving, under an advisory lock so containers starting together apply each file once, and
  `CAIRN_BOOTSTRAP_ADMIN_*` creates the first administrator only while there is none, under a
  lock of its own so containers starting together take turns. The
  image carries Amazon RDS's certificate authorities for `sslmode=verify-full`, and
  `CAIRN_SSE_MAX_SECONDS` closes live updates before a platform's request limit.

### Changed

- **The runtime image starts through `scripts/start.mjs`.** With none of the new variables set
  it is `node server.js`, as before. The migration and operator scripts are plain JavaScript
  now (`npm run db:migrate` and `npm run operator:create` are unchanged), so the runtime image
  can run them without a TypeScript loader.
- **The VPS deploy workflow runs only in `montytorr/cairn`**, so a mirror that deploys its own
  way does not queue a job for a runner it does not have.

### Fixed

- **The image failed to start after the App Runner changes** (CAIRN-304). `scripts/start.mjs`
  imported the first-administrator code on every start, and `bcryptjs` exists only inside
  Next's bundled server chunks, so the container exited before serving; the VPS deploy rolled
  it back. The chores are now imported only when asked for, `pg` and `bcryptjs` stay packages
  in the standalone output, and CI builds the image and starts it both ways — plain, and
  migrating and bootstrapping on start — then signs in as the administrator it created.
- **The login limiter trusted an address the client wrote.** It keyed on the first
  `X-Forwarded-For` entry, which behind an ALB or App Runner is whatever the client sent, so
  every attempt could claim a fresh address. It now uses the entry the nearest proxy appended
  (`CAIRN_TRUSTED_PROXY_HOPS`), and failures are also capped per account — at 30 in 15
  minutes, looser than the 8 per address, so knowing someone's email is not enough to lock them
  out cheaply.

## [0.7.0] — 2026-09-26

### Added

- **Setup asks whether to use a default instance or ask** (CAIRN-302). Adding a second
  instance at a terminal asks what a directory with no route should do; `cairn instance
  policy ask | default <name>` changes it later. The skill tells agents what exit 10 means:
  ask the user, save the answer with the `route add` the CLI prints, retry.
- **Maintenance runs once per instance** (CAIRN-301). `reconcile` and `vitals` take
  `--all-instances`, which install-cron now passes: one run per instance under its own
  maintenance key, and exactly the old single run on a one-instance machine; `--json` gives one
  document keyed by instance. `vitals --notify` and the sync's `--notify` accept
  `<instance>:<ref>`, and the sync checks that instance's env for its key. install-cron only
  schedules the flag once the installed CLI knows it; re-run it on a machine that adds instances.
- **Commands find their instance from the directory, the ref or the session** (CAIRN-300).
  `cairn route add <instance> [--folder|--session]` saves which instance a repository (by its
  main checkout, so worktrees follow), a folder or one session belongs to. With no route, a
  command's ref goes to the one instance known to have its project. With no answer anywhere, the command stops with
  exit 10 and prints what to ask — at a terminal it asks — and the session-start briefing
  passes that on to the agent. Sessions that end before anyone answered are parked in
  `~/.cairn/unrouted/` and sent by `route add`.
- **Several Cairn instances on one machine** (CAIRN-299). `~/.cairn/instances.json` names them
  — a personal and a work server, say — and each keeps its own keys, outbox, ownership and
  project map in `~/.cairn/instances/<name>/`. A command uses `--instance`, `CAIRN_INSTANCE` or
  the configured default; with none, and the machine set to ask, it stops with exit 10 before
  any request. A key in the environment, or a URL that disagrees with the chosen instance, is
  refused. `cairn instance [list]` shows them, `cairn instance add <name> --url U [--default]
  [--adopt]` adds one and can move the existing setup into it. Nothing changes on a machine
  without the file.

- **OpenClaw gets its briefing from the repo** (CAIRN-292). `hooks/openclaw/cairn-briefing` is
  an `agent:bootstrap` hook that injects a short lifecycle rule plus live `cairn context --cwd
  <workspace>` (5 s deadline, fails open to the rule alone). `install-hooks.mjs` copies it to
  `~/.cairn/hooks/openclaw/cairn-briefing` and links it with `openclaw hooks install --link …
  --force` (retrying without `--force` on older OpenClaw; `--dry-run` prints the command),
  replacing advice that pointed at a directory OpenClaw never discovers. `sync-agent-files`
  keeps the copy current. `docs/openclaw.md` has the recommended `AGENTS.md` block, why an
  unscoped `learn` is refused from an OpenClaw workspace, and the discovery gotchas
  (`hooks.path` is the webhook path; workspace hooks follow the workspace).
- **The skill is short enough to be read** (CAIRN-293). `skills/cairn/SKILL.md` went from 34 KB
  to under 15 KB, with the whole lifecycle — check, own (agents' `add` claims), record
  (`attempt` for dead ends), checkpoint, in-review, done with `--kind verified` when the fix was
  already there — the sweep rule and "when not to file" in its first 60 lines. The release and
  session-end checkpoint rules now say what the code does. AGENTS.md and the README agree.
- **Secret-shaped strings are refused on every write that is read back** (CAIRN-285). One
  detector (`src/lib/secrets.ts`) runs on knowledge create/relearn, task titles, descriptions
  and resolutions, notes, comments, checkpoints and block reasons: provider token formats
  (`sbp_`, `sk-`/`sk-ant-`, `ghp_`/`gho_`/`github_pat_`, `AKIA`, `xox?-`, private-key blocks,
  JWTs) and `password|secret|token|api_key: <value>` where the value is not a placeholder
  (`<password>`, `***`, `$ENV_VAR`, `process.env.X`, a type, a path). 400 `secret_detected`
  names the field, rule and line, never the value; the CLI adds what to write instead.

- **Knowledge hygiene** (CAIRN-289, migration 064). `learn` records the session
  (`source_session_ref`, resolved to `source_session_id` when the row exists) and the one task
  the session holds; relearn records the editing session on the revision. `learn` lists up to
  three existing entries on the same subject and suggests `unlearn --superseded-by`. Reads
  that are sweeps — declared (`know --sweep`, `CAIRN_SWEEP=1`) or 10+ distinct slugs by one
  actor in a minute — are kept but excluded from recall; history is re-tagged and
  `knowledge_recall_state` rebuilt. `know --unused` says when the store is younger than the
  window. A fact that names no file is marked `unverified Nd` after 14 days unconfirmed,
  worded apart from `stale`. `search_all` ranks with `ts_rank(..., 1|32)` so long imports stop
  crowding out short answers.
- **Vitals can see what it was blind to** (CAIRN-288). The CAIRN-282 audit found every vitals
  number correct and the panel green while 17 of 22 claims had been quiet for over 20h, the
  reaper had released nothing for 13 days, the summariser wrote 1 of 16 sessions, and codex and
  openclaw's scheduled runs had stopped. `cairn_vitals_signals` (migration 065, a new function
  beside `cairn_vitals`, not another rewrite of it) adds: claims with no genuine activity for
  more than 2h / 24h and the quietest ten (`task_genuine_activity_at` is the reaper's
  `lastSignOfLife` in SQL — claim, heartbeat, note, `updated_at`, the holder's evidence events, or any checkpoint but the
  session-end "still held" one — and `src/lib/liveness-fixtures.ts` pins the two together);
  reconcile releases in the window and in 7 days, plus the maintenance identity's last write;
  sessions and summarised share per runtime and host (`macos`, `linux`, `other`, from the
  working directory); runtimes and writers absent for the window and the week before; knowledge never
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

### Changed

- **The README is reorganised and brought up to date.** Agent setup is split into sections
  (keys, skill and hooks, sessions, MCP, what lives on disk, several instances); the command
  table is grouped and covers `recall`, knowledge history, `--unused`, `--sweep`, `project
  create`, `route` and `instance`; the API list matches the routes on disk; the walkthrough
  shows `add` claiming for an agent; and stale passages (three hooks, a file-open briefing,
  the MCP tool count, the data model) are corrected. Historical detail that read as current
  behaviour — how the search arms and the Codex detection came to be — is cut to what
  explains the present. The version badge now follows releases.
- **Bodies are required where they carry the value** (CAIRN-291, CAIRN-289). The API now
  refuses a bug or spike with a description under 40 characters unless `forceEmpty: true`
  (`cairn add --force-empty` sends it), so the UI and MCP meet the rule the CLI enforced.
  Knowledge bodies must be non-blank on create and on relearn.

- **Settings has the header bar every other page has** (CAIRN-279), and its Password
  heading matches Labels and Entities instead of being the one uppercase eyebrow.

- **`GET /next?project=` with a key that names no project is a 404** instead of "nothing
  open" (CAIRN-264). Silence was the answer for a typo and for a renamed project alike, and
  it read as true for both.

### Fixed

- **The `?` shortcut list named the wrong keys.** It said `1`–`4` were Active, Backlog, All
  and Recent; the list has seven: Doing, Todo, Active, Backlog, All, Recent, Closed. `Esc`
  also clears the selection, and now says so.
- **`cairn instance add` no longer deletes saved routes** (CAIRN-302). It rebuilt `instances.json`
  from the instances alone, so adding one deleted the routes.
- **One runtime's queued writes no longer quarantine another's** (CAIRN-298). Every runtime
  on a machine shares `~/.cairn/outbox.jsonl`, and replay moved any item it had not queued
  itself to `outbox.jsonl.rejected`, so a Codex drain threw away notes Claude Code had queued
  during an outage and the reverse. Such an item now waits for its own runtime (or instance),
  and is quarantined only after 30 days nobody replayed it. A write queued under a key its
  runtime no longer holds is still refused, as before. `cairn replay` says how many are waiting.
  Two things this exposed are fixed with it: writes put back after a replay now go in front
  of anything queued meanwhile, so a checkpoint is never sent ahead of an older one; and a
  queue holding only other runtimes' writes no longer sets off a replay on every command.
- **`relearn` can move a fact from a project to an entity** (CAIRN-295). A scope flag only
  touches its own side, so `--entity X` added an entity and kept the project, and nothing
  could clear one side alone: `--project ""` was read as "not given" and dropped without a
  word. `none` now clears a side — `relearn <slug> --entity E --project none` moves it — and
  an empty value is refused with that hint.
- **The installer no longer links OpenClaw for an account that runs no gateway** (CAIRN-296).
  A global install puts `openclaw` on every account's PATH; linking from one without an
  OpenClaw config created a config nobody reads and reported success while the real gateway
  stayed unbriefed. It now links only where the account's OpenClaw config (`OPENCLAW_CONFIG_PATH`
  or `~/.openclaw/openclaw.json`) configures a gateway — a client config that only mirrors
  another gateway's auth does not count — says why it skipped otherwise, `--dry-run` included,
  and `--openclaw` overrides for a gateway not configured yet.

- **Client wiring: identity, host, drift and the per-Read hook** (CAIRN-290).
  `install-hooks.mjs` no longer writes the `PreToolUse(Read)` hook that CCS-40 removed by hand.
  It now takes out its own stale entry and leaves other tools' hooks in place. On Codex it
  lists the hooks that are not Cairn's and flags the ones on `Stop`, which runs every turn.
  A Codex started from a Claude Code shell used to be filed as claude-code because it inherits
  `CLAUDECODE`. When both runtimes' markers are present, the CLI now checks the process tree,
  and `CODEX_THREAD_ID` counts as a Codex marker.
  `CAIRN_AGENT=maintenance` no longer borrows the default key: it exits 3 until the machine has
  a `CAIRN_API_KEY_MAINTENANCE`. The sync job logs the CLI's stderr and exits non-zero when its
  report fails, instead of discarding both.
  On macOS `agent-files` runs at load and every 15 minutes, and the sync retries a network
  failure on wake.
  The drift warning names the newer side, from the release number or the new
  `x-cairn-built-at` header compared with the CLI file's mtime. When the CLI is behind, it
  prints the exact update command. `--version` prints the warning through the same path, once.
  Requests send `x-cairn-host`, and activity events record it in `data.host`. Actor strings are
  unchanged.
- **Recorded sessions get a project** (CAIRN-286). 389 of 389 live sessions had none: the
  server only used a key the caller sent, and neither the hook nor `cairn session end` sent
  one. `session end` now resolves it like `cairn context` — the `~/.cairn/projects.json` map —
  and sends the checkout's `origin`; the server falls back to the remote via `project_repos`,
  then to sessions already attributed in the same cwd, then to a checkout directory named like
  exactly one project's repository, so older CLIs and the OpenClaw sweep are covered. Existing
  rows need a one-off backfill (see the PR).
- **The summariser is never recorded as a session, and its failures are logged and retried**
  (CAIRN-287). 46% of Mac Claude rows were summariser child runs. The hook now exits under
  `QUARRY_SUMMARISER` and `AGENT_MEMORY_SUMMARISER` as well as `CAIRN_SUMMARISER`, sets all
  three in its own child, runs it with `--no-session-persistence` from a scratch directory
  (retrying without the flag on a CLI that predates it), and skips any transcript that opens
  with a summariser prompt unless a person spoke after it. Failures go to
  `~/.cairn/summariser.log` with the summariser's own error, the session is queued in
  `~/.cairn/unsummarised.json`, and the next hook run with a working summariser re-summarises
  up to two queued sessions (four tries, 48 hours) without re-checkpointing held tasks. With no
  summary, `request` is the first real thing a person typed — not a skill expansion, `hello`,
  or OpenClaw's `[OpenClaw conversation info: …]` wrapper, which is now stripped.
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

[Unreleased]: https://github.com/montytorr/cairn/compare/v0.14.4...HEAD
[0.14.4]: https://github.com/montytorr/cairn/compare/v0.14.3...v0.14.4
[0.14.3]: https://github.com/montytorr/cairn/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/montytorr/cairn/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/montytorr/cairn/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/montytorr/cairn/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/montytorr/cairn/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/montytorr/cairn/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/montytorr/cairn/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/montytorr/cairn/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/montytorr/cairn/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/montytorr/cairn/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/montytorr/cairn/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/montytorr/cairn/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/montytorr/cairn/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/montytorr/cairn/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/montytorr/cairn/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/montytorr/cairn/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/montytorr/cairn/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/montytorr/cairn/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/montytorr/cairn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/montytorr/cairn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/montytorr/cairn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/montytorr/cairn/releases/tag/v0.1.0
