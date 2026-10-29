# Cairn in Herdr

Herdr's sidebar can show, for each agent pane, the Cairn task that agent holds. Two parts
make it work: the CLI publishes the task, and a Herdr plugin turns it into labels. The Herdr
desktop app (`herdr-app`, terminals run by herdr-core) has no plugins: there the CLI writes a
terminal label and a mod displays it, see [The Herdr app](#the-herdr-app).

## What the pane shows

In order, the first that exists:

1. the Cairn task the pane's agent has claimed: `ABC-12 · Label each pane…`
2. the agent's own session title (Codex and Pi, read from their session files)
3. the terminal title
4. the agent name

The same title goes on the pane border (one line), in the sidebar (wrapped over two rows,
`title_l1` / `title_l2`), and on the pane's tab while that pane has focus. A plain shell
with no agent is left alone.

## The CLI half

Inside a Herdr pane (`HERDR_PANE_ID` set), `cairn claim`, a claiming `cairn add`,
`cairn beat` and `cairn checkpoint` run `herdr pane report-metadata --source cairn --token cairn_task=<REF> · <title>`
with a two-hour TTL, the same two hours after which the maintenance sweep releases a silent
claim. `done`, `cancel`, `release` and `session end` clear it; a release of a different task
than the one shown leaves it. The call is detached, silent and ignores every failure, so a
missing `herdr` costs nothing. `CAIRN_HERDR=0` turns it off.

Inside a herdr-core terminal (`HC_TERMINAL_ID` set) the same events run
`hc label "$HC_TERMINAL_ID" "cairn.task=<REF> · <title>"` and clear it with
`hc label "$HC_TERMINAL_ID" cairn.task=`. A label has no TTL: a crash that skips the clear
leaves it until the next claim, release or `session end` in that terminal. When both
variables are set, one was inherited from an enclosing session, and the label wins; an
invalid `HC_TERMINAL_ID` shows nothing rather than falling back to the pane.

## The plugin

`hooks/herdr/pane-title/` is a Herdr plugin (`cairn.pane-title`, Node, no dependencies).
`cairn setup` links it when `herdr` is on PATH, from a copy in
`~/.cairn/hooks/herdr/pane-title`, so re-running setup upgrades it. `cairn setup --no-herdr`
skips it. By hand:

```bash
herdr plugin link ~/.cairn/hooks/herdr/pane-title   # or the checkout's hooks/herdr/pane-title
```

If another plugin that writes `title_l1` / `title_l2` is installed, setup says so and does
not remove it; two of them overwrite each other on every event. Remove it yourself with
`herdr plugin unlink <id>`, or `herdr plugin uninstall <id>` if it was installed rather than
linked.

It runs a full sync on startup, `pane.agent_status_changed`,
`pane.agent_detected`, `pane.focused`, `tab.focused` and `pane.created`, and through the
`sync` action, which the CLI invokes after each token change. It writes only what changed, always exits 0, and when a pane's agent exits it
clears the border label and sidebar rows it set. A leftover `cairn_task` token expires on its
own TTL.

Widths go in `config.json` in the plugin's config dir (`herdr plugin config-dir
cairn.pane-title`); the plugin runs under the Herdr server, so shell variables rarely reach it:

```json
{ "paneTitleMax": 44, "sidebarTitleWidth": 24, "tabTitleMax": 28 }
```

Those are the defaults. `sidebarTitleWidth` is characters per sidebar row: keep it two below
`ui.sidebar_width` in Herdr's `config.toml`. `HERDR_PANE_TITLE_MAX`,
`HERDR_SIDEBAR_TITLE_WIDTH` and `HERDR_TAB_TITLE_MAX` are read when the file sets nothing.

### Tab labels

A tab takes its focused pane's title, but only when its label is Herdr's default (its number),
empty, or the last label this plugin wrote (kept in the plugin's state directory). A name you
typed is never replaced. A tab whose focused pane is a plain shell keeps its label.

## Showing the rows

`cairn setup` does not edit Herdr's `config.toml`. The sidebar shows the rows only if the
config lists them, for example:

```toml
[ui.sidebar.agents]
rows = [["state_icon", { token = "workspace", fg = "#7195ba" }], [{ token = "$title_l1", fg = "#abb2bf" }], [{ token = "$title_l2", fg = "#abb2bf" }]]
```

Check it with `herdr config check`, then `herdr server reload-config`.

## The Herdr app

The app keeps the CLI half and drops the plugin: labels on a terminal are visible to every
mod through `terminals()`, which mirrors `hc ls --json`, so nothing has to resync. Check one
with `hc get "$HC_TERMINAL_ID" --json | jq .labels`.

No shipped panel shows a custom label yet. To put the task in the agents list, duplicate the
shipped `agents` mod (`mod.clone`, from the command palette or `herdr-app do`), point a
personal copy of the layout at it, and pick the row title from the label, falling back to the
agent's own title:

```js
import { terminals } from "herdr";

// Called on every render: labels change while the mod runs.
const rowTitle = (agent) => {
  const task = terminals().find((t) => t.address === agent.address)?.labels?.["cairn.task"];
  return task || agent.title || agent.program?.name || "";
};
```

`~/.config/herdr-app/AGENTS.md`, which the app rewrites on every start, documents mods,
layouts and `herdr-app check`.
