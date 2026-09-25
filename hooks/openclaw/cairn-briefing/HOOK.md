---
name: cairn-briefing
description: "Inject the Cairn lifecycle rule and a live `cairn context` briefing at agent bootstrap"
homepage: https://github.com/montytorr/cairn/blob/main/docs/openclaw.md
metadata: { "openclaw": { "events": ["agent:bootstrap"] } }
---

# Cairn briefing

Puts Cairn in front of every OpenClaw agent session, the way Claude Code and Codex get it
from their `SessionStart` hook.

## What It Does

- Listens for `agent:bootstrap`.
- Runs `cairn context --cwd <workspaceDir>` with `CAIRN_AGENT=openclaw` (unless already
  set) and a 5 second deadline.
- Adds one bootstrap file, `CAIRN.md`: a short rule (check → own → note → checkpoint →
  in-review → done with a kind; one claimed task per sweep; scoped `learn`) followed by
  the live briefing.
- Fails open. If the CLI is missing, slow or errors, the rule is injected alone; if
  anything else goes wrong, the session starts exactly as it would have without this hook.

## Requirements

- The `cairn` CLI on the gateway's PATH, or `CAIRN_CLI` set to its absolute path.
- A Cairn key for OpenClaw in `~/.cairn/env` (`CAIRN_API_KEY_OPENCLAW`, or the plain
  `CAIRN_API_KEY`).

## Configuration

Install it by linking, so upgrades to the linked copy take effect without reinstalling:

```bash
openclaw hooks install --link ~/.cairn/hooks/openclaw/cairn-briefing --force
# then restart the gateway
```

`node scripts/install-hooks.mjs` in the Cairn repository copies this directory to
`~/.cairn/hooks/openclaw/cairn-briefing` and runs that command for you when `openclaw` is on
PATH. `scripts/sync-agent-files.mjs` keeps the copy current.

Environment: `CAIRN_CLI` (default `cairn`), `CAIRN_HOOK_TIMEOUT_MS` (default 5000).

See `docs/openclaw.md` in the Cairn repository for the recommended AGENTS.md block and the
discovery gotchas.
