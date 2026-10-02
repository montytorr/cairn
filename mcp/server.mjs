#!/usr/bin/env node
/**
 * MCP facade over the `cairn` CLI.
 *
 * It holds ZERO logic. Every tool shells out to the same binary a human or a
 * shell-capable agent would run, so there is exactly one implementation of
 * every behaviour. Anything that ends up here and not in the CLI is a bug.
 *
 * The reverse is not a bug but it is a cost, and it was never policed: this
 * exposed no knowledge tools at all for as long as knowledge has existed, so
 * an MCP-only agent could not read or write the memory half of the product
 * and was not told it existed. Worse, `cairn_check` returns knowledge rows
 * and described itself as an index of tasks, sending agents to `cairn_show`
 * with a slug it cannot open. When a verb is deliberately left out, say so
 * here rather than leaving its absence to be discovered.
 *
 * Why bother, given the CLI exists: Codex's [mcp_servers.*] gives per-tool
 * timeouts and approval modes, Claude Code enforces the tool schemas so the
 * model cannot invent flags, and OpenClaw can reach it through mcporter.
 *
 * Requires `cairn` on PATH, plus CAIRN_BASE_URL and CAIRN_API_KEY (or
 * ~/.cairn/env, which the CLI reads itself).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const run = promisify(execFile)

const CAIRN_BIN = process.env.CAIRN_BIN || 'cairn'

/** Never interpolate into a shell — execFile takes an argv array. */
const cairn = async (args) => {
  try {
    const { stdout, stderr } = await run(CAIRN_BIN, args, {
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    })
    // stderr as well, ahead of stdout. It carries what the CLI says ABOUT an
    // answer rather than the answer — "AC-113 is now HOL-113, project AC was
    // renamed HOL" (CAIRN-264), "nothing found", what a digest withheld — and
    // returning stdout alone meant an MCP caller asked for AC-113, got HOL-113
    // and was never told why. The shell caller always saw both.
    const text = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
    return { text: text || 'ok', isError: false }
  } catch (error) {
    // Exit 9 is the CLI's "another agent holds this". Surface it as text
    // rather than a protocol error, so the model can act on it.
    const detail = [error.stderr, error.stdout].filter(Boolean).join('\n').trim()
    return {
      text: detail || error.message,
      isError: error.code !== 9,
    }
  }
}

const TOOLS = [
  {
    name: 'cairn_check',
    description:
      'ALWAYS CALL THIS FIRST, before starting work on any subject. Returns an index ' +
      'of prior TASKS, work-log NOTES, KNOWLEDGE and SESSIONS — showing whether each ' +
      'carries a recorded answer and roughly what it costs to open. Do not re-debug ' +
      'something already answered. Open a task row with cairn_show; open a knowledge ' +
      'row with cairn_know, whose ref is a slug rather than a KEY-123.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What you are about to work on.' },
        project: { type: 'string', description: 'Optional project key, e.g. CAI.' },
        assignee: {
          type: 'string',
          description: 'Only tasks assigned to this person: "me", an email, a name or a user id.',
        },
      },
      required: ['subject'],
    },
    run: (a) => [
      'check', a.subject,
      ...(a.project ? ['--project', a.project] : []),
      ...(a.assignee ? ['--assignee', a.assignee] : []),
    ],
  },
  {
    name: 'cairn_show',
    description:
      'Full detail of one task, including its resolution if it has one. Takes a task ' +
      'ref like CAI-42 — for a knowledge slug from cairn_check, use cairn_know.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'e.g. CAI-42' } },
      required: ['ref'],
    },
    run: (a) => ['show', a.ref],
  },
  {
    name: 'cairn_recall',
    description:
      'What already bears on one task: resolutions, decision and finding notes on the tasks ' +
      'around it (ones that name it, ones it names, parent, sub-tasks, blockers, similar ' +
      'titles) and the knowledge that applies (linked to files it touched, learned on it or ' +
      'a related task, or matching its terms). Every line says why it was picked. Use it when ' +
      'picking a task up, before starting the work.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'e.g. CAI-42' },
        limit: { type: 'number', description: 'Lines per section, default 8, at most 30.' },
      },
      required: ['ref'],
    },
    run: (a) => ['recall', a.ref, ...(a.limit !== undefined ? ['--limit', String(a.limit)] : [])],
  },
  {
    name: 'cairn_know',
    description:
      'Read what is known. With a slug, returns that entry; with a phrase, searches ' +
      'knowledge; with nothing, lists what applies to this project. Knowledge is what ' +
      'outlives the task it was learned on, so this answers "what do we already know ' +
      'about this" where cairn_check answers "has this been worked on".',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'A slug to read, or a phrase to search. Omit to list what applies here.',
        },
        project: { type: 'string', description: 'Optional project key, e.g. CAI.' },
        history: {
          type: 'boolean',
          description:
            'With a slug: every version of the entry, who changed it and why, instead of ' +
            'the current text.',
        },
        unusedDays: {
          type: 'number',
          description:
            'Instead: current entries no search or direct read returned in this many days — ' +
            'dead, or titled so nothing finds them. The session briefing is not counted.',
        },
      },
    },
    run: (a) =>
      a.unusedDays !== undefined
        ? ['know', '--unused', '--days', String(a.unusedDays)]
        : [
            'know',
            ...(a.subject ? [a.subject] : []),
            ...(a.project ? ['--project', a.project] : []),
            ...(a.history ? ['--history'] : []),
          ],
  },
  {
    name: 'cairn_gaps',
    description:
      'Where the memory has holes: entries joined to nothing, references pointing at ' +
      'entries nobody ever wrote, and how many separate islands the corpus has fallen ' +
      'into. None of it shows in a list of knowledge, because a list shows what is there. ' +
      'Use it before writing a reference, and when deciding what is worth connecting.',
    inputSchema: {
      type: 'object',
      properties: {
        show: {
          type: 'string',
          enum: ['summary', 'orphans', 'dangling'],
          description:
            'summary counts everything; orphans lists entries nothing links to; dangling ' +
            'lists references pointing at entries that do not exist, and who points at them.',
        },
      },
    },
    run: (a) => [
      'know',
      a.show === 'orphans' ? '--orphans' : a.show === 'dangling' ? '--dangling' : '--gaps',
    ],
  },
  {
    name: 'cairn_learn',
    description:
      'Record something that will still be true next month — infra, a convention, a ' +
      'gotcha. Scope it: project for one codebase, entity for a business or a stack, ' +
      'global for true everywhere. Given none of those it takes the current ' +
      'directory\'s project and refuses if there is none, because a fact filed global ' +
      'sits in front of every project permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The claim itself, as a sentence.' },
        body: { type: 'string', description: 'Markdown: what it means and how it was found.' },
        project: { type: 'string', description: 'True of this project only.' },
        entity: { type: 'string', description: 'True of this grouping — see cairn_entities.' },
        global: { type: 'boolean', description: 'True everywhere. Say so on purpose.' },
        label: { type: 'string', description: 'Comma-separated labels.' },
        task: { type: 'string', description: 'The task it was learned on, e.g. CAI-42.' },
        files: {
          type: 'string',
          description:
            'Comma-separated paths it is about, beyond the backticked ones its body names. ' +
            'Linked so a later lookup by file finds it, and so it ages when they change.',
        },
        allowDangling: {
          type: 'boolean',
          description:
            'Keep a [[reference]] the store cannot resolve. The write is refused when a ' +
            'near-named entry already exists, and the refusal names it — retry with that ' +
            'slug instead. This is for the case it gets wrong: a genuinely new fact whose ' +
            'name resembles an existing one.',
        },
      },
      required: ['title', 'body'],
    },
    run: (a) => [
      'learn', a.title, '--body', a.body,
      ...(a.project ? ['--project', a.project] : []),
      ...(a.entity ? ['--entity', a.entity] : []),
      ...(a.global ? ['--global'] : []),
      ...(a.label ? ['--label', a.label] : []),
      ...(a.task ? ['--task', a.task] : []),
      ...(a.files ? ['--files', a.files] : []),
      ...(a.allowDangling ? ['--allow-dangling'] : []),
    ],
  },
  {
    name: 'cairn_relearn',
    description:
      'Correct a fact that has changed, in place. Prefer this to filing a second ' +
      'entry: the failure mode of every memory store is accumulation without ' +
      'correction, and two entries disagreeing is worse than one that is wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        body: { type: 'string', description: 'The corrected body.' },
        title: { type: 'string', description: 'A corrected title, if the claim itself changed.' },
        project: { type: 'string', description: 'Re-scope it to this project only.' },
        entity: { type: 'string', description: 'Re-scope it to this grouping — see cairn_entities.' },
        global: {
          type: 'boolean',
          description:
            'Re-scope it to true everywhere, clearing both project and entity. Not combinable ' +
            'with project or entity.',
        },
        allowDangling: {
          type: 'boolean',
          description:
            'Keep a [[reference]] the store cannot resolve. An edit runs the same check as ' +
            'a write, so a correction can be refused the same way.',
        },
        reason: {
          type: 'string',
          description: 'Why it changed. Kept with the version this replaces.',
        },
        files: {
          type: 'string',
          description:
            'Comma-separated paths it is about. Replaces those named explicitly before; ' +
            'paths in the body are linked on their own.',
        },
      },
      required: ['slug'],
    },
    run: (a) => [
      'relearn', a.slug,
      ...(a.body ? ['--body', a.body] : []),
      ...(a.title ? ['--title', a.title] : []),
      ...(a.project ? ['--project', a.project] : []),
      ...(a.entity ? ['--entity', a.entity] : []),
      ...(a.global ? ['--global'] : []),
      ...(a.allowDangling ? ['--allow-dangling'] : []),
      ...(a.reason ? ['--reason', a.reason] : []),
      ...(a.files ? ['--files', a.files] : []),
    ],
  },
  {
    name: 'cairn_unlearn',
    description:
      'Mark a fact as superseded — it was wrong, or something replaced it. It stays ' +
      'findable and marked, and ranks below its replacement, so a correction beats ' +
      'the claim it corrects wherever both match.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        supersededBy: { type: 'string', description: 'Slug of the entry that replaces it.' },
        reason: { type: 'string', description: 'Why it was superseded. Needs supersededBy.' },
        allowDangling: {
          type: 'boolean',
          description:
            'Without supersededBy this deletes the entry, and the delete is refused while ' +
            'live entries [[reference]] it — the refusal names them. Prefer supersededBy, ' +
            'or fix the referrers; this deletes anyway and leaves their references dangling.',
        },
      },
      required: ['slug'],
    },
    run: (a) => [
      'unlearn', a.slug,
      ...(a.supersededBy ? ['--superseded-by', a.supersededBy] : []),
      ...(a.supersededBy && a.reason ? ['--reason', a.reason] : []),
      // Only on the delete path: the CLI reads it nowhere else, and would
      // refuse it as an ignored flag beside --superseded-by.
      ...(!a.supersededBy && a.allowDangling ? ['--allow-dangling'] : []),
    ],
  },
  {
    name: 'cairn_verify',
    description:
      'Confirm a fact is still true, having actually checked. Clears the stale mark ' +
      'a fact gets when the files it names have been reworked since it was last ' +
      'confirmed, without making you restate it.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
    },
    run: (a) => ['verify', a.slug],
  },
  {
    name: 'cairn_entities',
    description:
      'The groupings a fact can be true of — a business, a stack, a subsystem — and ' +
      'the projects in each. Use before cairn_learn --entity, to find the right key.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ['entities'],
  },
  {
    name: 'cairn_list',
    description: 'List tasks in a project, optionally filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', enum: ['backlog', 'todo', 'doing', 'in-review', 'done', 'cancelled'] },
        type: { type: 'string', enum: ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs'] },
        assignee: {
          type: 'string',
          description: 'Whose tasks: "me" (the human behind this key), an email, a name or a user id.',
        },
      },
      required: ['project'],
    },
    run: (a) => [
      'list', '--project', a.project,
      ...(a.status ? ['--status', a.status] : []),
      ...(a.type ? ['--type', a.type] : []),
      ...(a.assignee ? ['--assignee', a.assignee] : []),
    ],
  },
  {
    name: 'cairn_add',
    description:
      'File a new task. Warns if similar work already exists — read that warning ' +
      'before continuing rather than filing a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        project: { type: 'string' },
        type: { type: 'string', enum: ['feature', 'bug', 'improvement', 'chore', 'spike', 'docs'] },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
        body: {
          type: 'string',
          description:
            'Markdown: "## " headings, "- " lists, paths and identifiers in backticks. ' +
            'A wall of text is refused, with a list of what to fix.',
        },
        assignee: {
          type: 'string',
          description:
            'The human who owns it: an email, a name or a user id. Omit it and the task is ' +
            'assigned to the human behind this key. Owning is not claiming: the claim is ' +
            'which agent is executing it now.',
        },
      },
      required: ['title', 'project'],
    },
    run: (a) => [
      'add', a.title, '--project', a.project,
      ...(a.type ? ['--type', a.type] : []),
      ...(a.priority ? ['--priority', a.priority] : []),
      ...(a.body ? ['--body', a.body] : []),
      ...(a.assignee ? ['--assignee', a.assignee] : []),
    ],
  },
  {
    name: 'cairn_note',
    description:
      'Append to a task\'s work log: what you tried, found, or decided. Record dead ' +
      'ends too — "tried X, no difference" saves the next agent an hour and is as ' +
      'valuable as a fix. Safe to retry; duplicate notes are ignored.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        note: { type: 'string' },
        kind: { type: 'string', enum: ['note', 'finding', 'decision', 'attempt', 'handoff'] },
      },
      required: ['ref', 'note'],
    },
    run: (a) => ['note', a.ref, a.note, ...(a.kind ? ['--kind', a.kind] : [])],
  },
  {
    name: 'cairn_log',
    description: 'Read a task\'s work log — what has already been tried.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['log', a.ref],
  },
  {
    name: 'cairn_claim',
    description:
      'Claim a task before working it, so agents do not collide. If this reports the ' +
      'task is already held, PICK DIFFERENT WORK rather than forcing it.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['claim', a.ref],
  },
  {
    name: 'cairn_checkpoint',
    description:
      'Record where work stopped, so another agent can resume without reading your ' +
      'transcript. Leave one before you stop.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, summary: { type: 'string' } },
      required: ['ref', 'summary'],
    },
    run: (a) => ['checkpoint', a.ref, '--summary', a.summary],
  },
  {
    name: 'cairn_release',
    description: 'Drop a claim without closing the task.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['release', a.ref],
  },
  {
    name: 'cairn_done',
    description:
      'Close a task. A resolution is REQUIRED: say what was actually done and why. ' +
      'A closed task with no recorded answer is invisible to everyone who comes later.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        resolution: { type: 'string', description: 'What was actually done, and why.' },
        kind: {
          type: 'string',
          enum: ['fixed', 'wont-fix', 'duplicate', 'not-reproducible', 'superseded', 'answered'],
        },
      },
      required: ['ref', 'resolution'],
    },
    run: (a) => ['done', a.ref, '--resolution', a.resolution, ...(a.kind ? ['--kind', a.kind] : [])],
  },
  {
    name: 'cairn_deps',
    description:
      'What blocks this task, and what it blocks. Check before claiming — a task ' +
      'with open blockers is not ready to start whatever its status says.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' } },
      required: ['ref'],
    },
    run: (a) => ['deps', a.ref],
  },
  {
    name: 'cairn_link',
    description:
      'Record that one task must finish before another. Prefer this over writing ' +
      '"waiting on CAI-40" in a note: a link is visible from both tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        blockedBy: { type: 'string', description: 'The task that must finish first.' },
        remove: { type: 'boolean', description: 'Remove the link instead of adding it.' },
      },
      required: ['ref', 'blockedBy'],
    },
    run: (a) => [a.remove ? 'unblockedby' : 'blockedby', a.ref, a.blockedBy],
  },
  {
    name: 'cairn_comment',
    description: 'Leave a comment for the human. Findings for other agents go in the work log.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' } },
      required: ['ref', 'text'],
    },
    run: (a) => ['comment', a.ref, a.text],
  },
]

const server = new Server(
  { name: 'cairn', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name)
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool. Available: ${TOOLS.map((t) => t.name).join(', ')}` }],
      isError: true,
    }
  }

  const { text, isError } = await cairn(tool.run(request.params.arguments ?? {}))
  return { content: [{ type: 'text', text }], isError }
})

await server.connect(new StdioServerTransport())
