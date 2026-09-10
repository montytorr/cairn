#!/usr/bin/env node
/**
 * MCP facade over the `cairn` CLI.
 *
 * It holds ZERO logic. Every tool shells out to the same binary a human or a
 * shell-capable agent would run, so there is exactly one implementation of
 * every behaviour. Anything that ends up here and not in the CLI is a bug.
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
    return { text: stdout.trim() || stderr.trim() || 'ok', isError: false }
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
      'of prior tasks — open and closed — showing whether each carries a recorded ' +
      'answer and roughly what it costs to open. Do not re-debug something already ' +
      'answered. Then use cairn_show on the ones that look relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What you are about to work on.' },
        project: { type: 'string', description: 'Optional project key, e.g. CAI.' },
      },
      required: ['subject'],
    },
    run: (a) => ['check', a.subject, ...(a.project ? ['--project', a.project] : [])],
  },
  {
    name: 'cairn_show',
    description: 'Full detail of one task, including its resolution if it has one.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'e.g. CAI-42' } },
      required: ['ref'],
    },
    run: (a) => ['show', a.ref],
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
      },
      required: ['project'],
    },
    run: (a) => [
      'list', '--project', a.project,
      ...(a.status ? ['--status', a.status] : []),
      ...(a.type ? ['--type', a.type] : []),
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
        body: { type: 'string', description: 'Markdown description.' },
      },
      required: ['title', 'project'],
    },
    run: (a) => [
      'add', a.title, '--project', a.project,
      ...(a.type ? ['--type', a.type] : []),
      ...(a.priority ? ['--priority', a.priority] : []),
      ...(a.body ? ['--body', a.body] : []),
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
