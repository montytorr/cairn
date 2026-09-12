#!/bin/sh
# Make the runtime nameable, for `cairn`.
#
# The API key is the identity, and the CLI picks its key from whichever runtime
# it can see itself running under. Codex is the one runtime that leaves no
# trace: it reads CODEX_HOME but does not necessarily set it, so a `cairn` call
# from inside a Codex session looked like a call from nowhere and fell back to
# the machine's default key, which belongs to whichever runtime got there first.
#
# This does NOT set CAIRN_AGENT=codex, which was the obvious thing to do and is
# wrong: OpenClaw runs Codex underneath, with a CODEX_HOME of its own, so
# forcing the name here would relabel all of OpenClaw's work as Codex — the
# same misattribution, pointing the other way. Exporting CODEX_HOME instead
# leaves the decision where it belongs: a CODEX_HOME under an OpenClaw path is
# OpenClaw, any other is Codex, and an explicit CAIRN_AGENT still wins.
#
# Installed at /usr/local/bin/codex, which precedes /usr/bin on PATH.
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export CODEX_HOME
exec /usr/bin/codex "$@"
