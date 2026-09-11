import { z } from 'zod'
import {
  createNoteSchema,
  createTaskSchema,
  updateTaskSchema,
  NOTE_KINDS,
  RESOLUTION_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '@/schemas/task'
import { knowledgeCreate, knowledgeUpdate } from '@/schemas/knowledge'
import { sessionUpsert } from '@/schemas/session'

/**
 * The spec is generated from the same Zod schemas the routes validate with,
 * so it cannot drift. a2a-comms went the other way — a hand-written 1,055-line
 * docs page plus 110KB of prose — and prose is exactly what goes stale.
 */
const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<string, unknown>

const envelope = (dataSchema: Record<string, unknown>) => ({
  type: 'object',
  properties: { success: { const: true }, data: dataSchema },
  required: ['success', 'data'],
})

const errorResponse = {
  description: 'Failure. `code` is machine-readable; enum errors list the valid values.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { const: false },
          error: { type: 'string' },
          code: {
            type: 'string',
            enum: [
              'unauthorized', 'forbidden', 'not_found', 'validation_failed',
              'conflict', 'already_claimed', 'resolution_required',
              'rate_limited', 'internal_error',
            ],
          },
          suggestedResolution: {
            type: 'string',
            description:
              'Present on resolution_required. Drawn from the last checkpoint or most ' +
              'recent finding note, so the caller can confirm rather than invent.',
          },
        },
        required: ['success', 'error', 'code'],
      },
    },
  },
}

const refParam = {
  name: 'ref',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Task reference — `CAI-42`, or a raw UUID.',
}

const body = (schema: Record<string, unknown>) => ({
  required: true,
  content: { 'application/json': { schema } },
})

const okResponse = (description: string, data: Record<string, unknown> = { type: 'object' }) => ({
  description,
  content: { 'application/json': { schema: envelope(data) } },
})

const taskSummary = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    number: { type: 'integer' },
    ref: { type: 'string', example: 'CAI-42' },
    title: { type: 'string' },
    type: { type: 'string', enum: [...TASK_TYPES] },
    status: { type: 'string', enum: [...TASK_STATUSES] },
    priority: { type: 'string', enum: [...TASK_PRIORITIES] },
    labels: { type: 'array', items: { type: 'string' } },
    claimed_by: { type: ['string', 'null'] },
    resolution: { type: ['string', 'null'] },
  },
}

export const openapiSpec = () => ({
  openapi: '3.1.0',
  info: {
    title: 'Cairn API',
    version: '0.1.0',
    description: [
      'Agent-first task tracker whose tasks double as shared memory.',
      '',
      '## The contract',
      '',
      '`check → show → act`. Call `GET /search` **before** starting work on a subject:',
      'it returns an index of prior tasks, whether each carries a recorded answer, and',
      'an estimated token cost, so you can open only what matters. Do not re-debug',
      'something already answered.',
      '',
      '## Closing a task',
      '',
      '`done` and `cancelled` are refused without a `resolution`. The rejection includes',
      'a `suggestedResolution` drawn from the last checkpoint, so confirming is usually',
      'enough. A closed task with no recorded answer is invisible to whoever comes next.',
      '',
      '## Claiming',
      '',
      '`POST /tasks/{ref}/claim` is a single conditional update. A 409 means another',
      'agent holds it — pick different work. A lease whose heartbeat has been silent for',
      '15 minutes can be taken over.',
    ].join('\n'),
    license: { name: 'MIT' },
  },
  servers: [{ url: '/api/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'One API key per agent (`sk_live_…`). The key\'s agent name is recorded as the ' +
          'actor on every write it makes, which is what makes the shared log attributable.',
      },
    },
  },
  paths: {
    '/health': {
      get: {
        summary: 'Liveness probe',
        security: [],
        responses: { '200': okResponse('Service is up.') },
      },
    },
    '/search': {
      get: {
        summary: 'Find prior work — call this first',
        description:
          'Searches four stores at once: tasks, work-log notes, knowledge and recorded ' +
          'sessions. Returns an index, never bodies. Hits carrying an answer rank first. ' +
          'Matching is keyword-based (Postgres FTS ANDs terms, widening to OR when the ' +
          'precise pass comes back thin), so a paraphrase can still miss. ' +
          'A `type` or `status` filter is a statement about tasks and narrows to them.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
          {
            name: 'kinds',
            in: 'query',
            description: 'Comma-separated subset of task,note,knowledge,session. Default: all.',
            schema: { type: 'string', example: 'task,knowledge' },
          },
          { name: 'tasksOnly', in: 'query', schema: { type: 'boolean', default: false } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: [...TASK_TYPES] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: [...TASK_STATUSES] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: {
          '200': okResponse('Search index.', {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string', enum: ['task', 'note', 'knowledge', 'session'] },
                    ref: {
                      type: 'string',
                      description:
                        'A task ref for tasks and notes, a slug for knowledge, a date for sessions.',
                    },
                    title: { type: 'string' },
                    type: { type: 'string' },
                    status: { type: 'string' },
                    resolved: {
                      type: 'boolean',
                      description:
                        'An answer is recorded: a resolution on a task, a finding or decision ' +
                        'on a note, next steps on a session, verified on knowledge.',
                    },
                    tokens: { type: 'integer', description: 'Rough cost of opening this.' },
                  },
                },
              },
            },
          }),
          '401': errorResponse,
        },
      },
    },
    '/projects': {
      get: {
        summary: 'List projects',
        description: 'Archived projects are omitted unless `?archived=1`.',
        parameters: [
          { name: 'archived', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: { '200': okResponse('Projects.'), '401': errorResponse },
      },
      post: {
        summary: 'Create a project',
        requestBody: body({
          type: 'object',
          properties: {
            key: { type: 'string', pattern: '^[A-Z][A-Z0-9]{1,9}$', example: 'CAI' },
            title: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['key', 'title'],
        }),
        responses: { '201': okResponse('Created.'), '409': errorResponse },
      },
    },
    '/projects/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' },
          description: 'Project key (CAI) or uuid.' },
      ],
      get: { summary: 'Read a project, with its task count', responses: { '200': okResponse('Project.') } },
      patch: {
        summary: 'Rename a project, or change its key',
        requestBody: body({
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: ['string', 'null'] },
            key: { type: 'string', description: 'Changing this changes every task ref.' },
            status: { type: 'string', enum: ['active', 'archived'] },
          },
        }),
        responses: { '200': okResponse('Updated.'), '400': errorResponse },
      },
      delete: {
        summary: 'Delete a project and every task in it',
        description:
          'Irreversible, and it destroys recorded resolutions. Requires ' +
          '`?confirm=<PROJECT_KEY>`; without it the call fails and reports how many ' +
          'tasks would be lost.',
        parameters: [{ name: 'confirm', in: 'query', schema: { type: 'string' } }],
        responses: { '200': okResponse('Deleted.'), '400': errorResponse },
      },
    },
    '/projects/{id}/tasks': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Project key or UUID.' },
      ],
      get: {
        summary: 'List tasks in a project',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: [...TASK_STATUSES] } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: [...TASK_TYPES] } },
          { name: 'label', in: 'query', schema: { type: 'string' } },
          { name: 'claimed_by', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { '200': okResponse('Tasks.'), '404': errorResponse },
      },
      post: {
        summary: 'Create a task',
        requestBody: body(json(createTaskSchema)),
        responses: { '201': okResponse('Created.', taskSummary), '404': errorResponse },
      },
    },
    '/tasks/{ref}': {
      parameters: [refParam],
      get: {
        summary: 'Get a task',
        description:
          '`?view=digest` returns a cheap read instead: the resolution in full, findings ' +
          'and decisions from the log, a clipped body, and a count of what was withheld ' +
          'with the token cost of fetching it. Measured against real data, the median body ' +
          'is 2KB and the 90th percentile 5KB, so the body is what a digest has to clip.',
        parameters: [
          { name: 'view', in: 'query', schema: { type: 'string', enum: ['full', 'digest'], default: 'full' } },
        ],
        responses: { '200': okResponse('Task.', taskSummary), '404': errorResponse },
      },
      patch: {
        summary: 'Update a task',
        description:
          'Omitted fields are left alone. Moving to `done` or `cancelled` requires ' +
          '`resolution`, otherwise the request is refused with `resolution_required`. ' +
          '`project` moves the task: per-project numbering means it is renumbered and ' +
          'its ref changes, so anything referring to the old ref goes stale.',
        requestBody: body(json(updateTaskSchema)),
        responses: {
          '200': okResponse('Updated.', taskSummary),
          '400': errorResponse,
          '404': errorResponse,
        },
      },
      delete: { summary: 'Delete a task', responses: { '200': okResponse('Deleted.'), '404': errorResponse } },
    },
    '/tasks/{ref}/claim': {
      parameters: [refParam],
      post: {
        summary: 'Claim a task',
        description: 'A 409 means another agent holds it. Pick different work.',
        responses: { '200': okResponse('Claimed.'), '409': errorResponse },
      },
    },
    '/tasks/{ref}/beat': {
      parameters: [refParam],
      post: { summary: 'Heartbeat a claim', responses: { '200': okResponse('Beaten.'), '409': errorResponse } },
    },
    '/tasks/{ref}/checkpoint': {
      parameters: [refParam],
      post: {
        summary: 'Record where work stopped',
        description: 'Only the latest is kept — it is the payload another agent resumes from.',
        requestBody: body({
          type: 'object',
          properties: { summary: { type: 'string' }, payload: { type: 'object' } },
          required: ['summary'],
        }),
        responses: { '200': okResponse('Saved.'), '404': errorResponse },
      },
    },
    '/tasks/{ref}/release': {
      parameters: [refParam],
      post: { summary: 'Drop a claim', responses: { '200': okResponse('Released.') } },
    },
    '/tasks/{ref}/block': {
      parameters: [refParam],
      post: {
        summary: 'Block or unblock',
        description: 'Omit `reason`, or send null, to unblock.',
        requestBody: body({ type: 'object', properties: { reason: { type: ['string', 'null'] } } }),
        responses: { '200': okResponse('Updated.') },
      },
    },
    '/tasks/{ref}/children': {
      parameters: [refParam],
      get: {
        summary: 'Direct sub-tasks, with a closed/total rollup',
        description:
          'Counts closed rather than done: a cancelled sub-task is decided, and a parent ' +
          'reported as permanently incomplete because one piece was dropped is useless.',
        responses: { '200': okResponse('{count, closed, children}.'), '404': errorResponse },
      },
    },
    '/tasks/{ref}/activity': {
      parameters: [refParam],
      get: {
        summary: 'The audit trail: what changed, when, and who changed it',
        description:
          'Distinct from /notes, which is what an agent chose to say. This is what ' +
          'actually happened, whether anyone narrated it or not. Newest first.',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }],
        responses: { '200': okResponse('Events.'), '404': errorResponse },
      },
    },
    '/tasks/{ref}/dependencies': {
      parameters: [refParam],
      get: {
        summary: 'List what blocks this task, and what it blocks',
        description:
          'Check this before claiming: a task whose blockers are open is not ready to start.',
        responses: { '200': okResponse('Relations, each with a `direction`.') },
      },
      post: {
        summary: 'Link two tasks',
        description:
          "`blocked-by` (the default) means the other task must finish first. " +
          'Direct cycles and self-links are refused.',
        requestBody: body({
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The other task, as a ref or uuid.' },
            direction: { type: 'string', enum: ['blocked-by', 'blocks'], default: 'blocked-by' },
          },
          required: ['ref'],
        }),
        responses: { '201': okResponse('Linked.'), '400': errorResponse, '404': errorResponse },
      },
      delete: {
        summary: 'Remove a link',
        description: 'Arguments go in the query string; DELETE bodies are not read.',
        parameters: [
          { name: 'ref', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'direction',
            in: 'query',
            schema: { type: 'string', enum: ['blocked-by', 'blocks'], default: 'blocked-by' },
          },
        ],
        responses: { '200': okResponse('Removed.'), '404': errorResponse },
      },
    },
    '/tasks/{ref}/notes': {
      parameters: [refParam],
      get: {
        summary: 'Read the work log',
        parameters: [{ name: 'kind', in: 'query', schema: { type: 'string', enum: [...NOTE_KINDS] } }],
        responses: { '200': okResponse('Notes.') },
      },
      post: {
        summary: 'Append to the work log',
        description:
          'Idempotent on content — a retry after a timeout returns `{duplicate:true}` ' +
          'as a success rather than creating a second note. Record dead ends too.',
        requestBody: body(json(createNoteSchema)),
        responses: { '201': okResponse('Created.'), '200': okResponse('Duplicate; nothing written.') },
      },
    },
    '/tasks/{ref}/comments': {
      parameters: [refParam],
      get: { summary: 'List comments', responses: { '200': okResponse('Comments.') } },
      post: {
        summary: 'Add a comment (for the human to read)',
        requestBody: body({
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
        }),
        responses: { '201': okResponse('Created.') },
      },
    },
    '/tasks/{ref}/attachments': {
      parameters: [refParam],
      get: { summary: 'List attachments', responses: { '200': okResponse('Attachments.') } },
      post: {
        summary: 'Upload an attachment',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
        responses: { '201': okResponse('Uploaded, with signed URLs.'), '400': errorResponse },
      },
    },
    '/attachments/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { summary: 'Get an attachment with fresh signed URLs', responses: { '200': okResponse('Attachment.') } },
      delete: { summary: 'Delete an attachment', responses: { '200': okResponse('Deleted.') } },
    },
    '/events': {
      get: {
        summary: 'Change stream (SSE)',
        description:
          'Server-sent events, for a UI that wants to know when something moved. Polls a ' +
          '`max(updated_at):count` fingerprint every four seconds and lives ten minutes, ' +
          'rather than holding a Realtime subscription open — the stack is shared and a ' +
          'poll that cheap is not worth a websocket.',
        parameters: [{ name: 'project', in: 'query', schema: { type: 'string' } }],
        responses: { '200': okResponse('An event stream.') },
      },
    },
    '/knowledge': {
      get: {
        summary: 'What we know that applies here',
        description:
          'Scoped three ways, narrowest first: to a project, to an entity (a grouping of ' +
          'projects), or to nothing at all, which means everywhere. A project-scoped read ' +
          'deliberately includes both of the wider scopes — the question is "what do we ' +
          'know that applies here", and an infra gotcha applies here.',
        parameters: [
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'label', in: 'query', schema: { type: 'string' } },
          {
            name: 'superseded',
            in: 'query',
            description: 'Include rows that have been replaced. Hidden by default.',
            schema: { type: 'boolean', default: false },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
        ],
        responses: { '200': okResponse('Knowledge index.') },
      },
      post: {
        summary: 'Record what we now know',
        description:
          'Omit `projects` and `entities` for a fact that is true everywhere. The slug is ' +
          'derived from the title when not given, and must be unique.',
        requestBody: body(json(knowledgeCreate)),
        responses: { '201': okResponse('Recorded.'), '409': errorResponse },
      },
    },
    '/knowledge/{slug}': {
      parameters: [
        { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
      ],
      get: { summary: 'Read one', responses: { '200': okResponse('The fact.'), '404': errorResponse } },
      patch: {
        summary: 'Correct it, or mark it superseded',
        description:
          'Correcting knowledge is the point: two contradictory claims, equally findable, ' +
          'with no way to tell which is current, is how a memory store stops being worth ' +
          'reading. `supersededBy` points at what replaced this; the row stays findable ' +
          'and is marked.',
        requestBody: body(json(knowledgeUpdate)),
        responses: { '200': okResponse('Updated.'), '404': errorResponse },
      },
      delete: { summary: 'Forget it', responses: { '200': okResponse('Deleted.'), '404': errorResponse } },
    },
    '/entities': {
      get: {
        summary: 'Groupings a fact can be true of',
        description:
          'A business, a stack, a subsystem. Many-to-many with projects, because a project ' +
          'belongs to more than one at a time and a fact can be true of it for either reason.',
        responses: { '200': okResponse('Entities and their projects.') },
      },
      post: { summary: 'Create one', responses: { '201': okResponse('Created.'), '409': errorResponse } },
      patch: {
        summary: 'Add or remove projects',
        description:
          'Additive and subtractive rather than a wholesale replacement: assigning one ' +
          'project must not silently unassign thirty others.',
        responses: { '200': okResponse('Membership changed.'), '404': errorResponse },
      },
    },
    '/sessions': {
      get: {
        summary: 'What happened, newest first',
        parameters: [
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
        ],
        responses: { '200': okResponse('Sessions.') },
      },
      post: {
        summary: 'Record a finished session',
        description:
          'Written by a session-end hook, not by hand. Idempotent on ' +
          '(platformSource, externalId), which is a correctness requirement rather than a ' +
          'nicety: Codex has no session-end event so its writer runs on Stop, which fires ' +
          'every turn. `checkpointHeld` also checkpoints any task the agent still holds, ' +
          'so a claim it walked away from stops looking like live work.',
        requestBody: body(json(sessionUpsert)),
        responses: { '200': okResponse('Recorded.') },
      },
    },
    '/context': {
      get: {
        summary: 'The briefing a session opens with',
        description:
          'What you are still holding, what is in flight around you, where the last session ' +
          'in this directory stopped, and what is known here. Index only, never bodies. ' +
          'With `file`, it answers the narrower question instead: what is known about that ' +
          'path. Read by a hook that has milliseconds and no way to recover from a failure, ' +
          'so it stays cheap and must never be why a session does not start.',
        parameters: [
          { name: 'cwd', in: 'query', schema: { type: 'string' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'file', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': okResponse('The briefing.') },
      },
    },
    '/reconcile': {
      post: {
        summary: 'Release your own abandoned claims',
        description:
          'The backstop for runtimes with no session-end event. Releases claims held by ' +
          'the calling agent that have shown no sign of life — heartbeat, note, checkpoint ' +
          'or edit — for `olderThanMinutes` (default 120, deliberately far longer than the ' +
          '15-minute claim lease, because agents barely heartbeat and a release is not as ' +
          'recoverable as a takeover). Never closes anything: a task with a resolution ' +
          'nobody meant is worse than one plainly still open.',
        requestBody: body({
          type: 'object',
          properties: {
            olderThanMinutes: { type: 'integer', minimum: 5, maximum: 1440, default: 120 },
            dryRun: { type: 'boolean', default: false },
          },
        }),
        responses: { '200': okResponse('What was released.') },
      },
    },
    '/labels': {
      get: {
        summary: 'Every label in use, with a task count',
        responses: { '200': okResponse('Labels, busiest first.') },
      },
      patch: {
        summary: 'Rename, merge or delete a label across every task',
        description:
          'Renaming onto a label that already exists merges the two. `to: null` deletes ' +
          'the label instead. Returns how many tasks changed — a rename that matched ' +
          'nothing otherwise looks identical to one that worked.',
        requestBody: body({
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: ['string', 'null'] },
          },
          required: ['from', 'to'],
        }),
        responses: { '200': okResponse('Applied.'), '400': errorResponse },
      },
    },
    '/keys': {
      get: { summary: 'List API keys (never the hash)', responses: { '200': okResponse('Keys.') } },
      post: {
        summary: 'Create an API key',
        description: 'The plaintext key is returned exactly once and never stored.',
        requestBody: body({
          type: 'object',
          properties: {
            agentName: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$', example: 'claude-code' },
            name: { type: 'string' },
          },
          required: ['agentName', 'name'],
        }),
        responses: { '201': okResponse('Created; includes the plaintext key.') },
      },
    },
    '/keys/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      delete: { summary: 'Revoke a key', responses: { '200': okResponse('Revoked.') } },
    },
  },
  'x-resolution-kinds': [...RESOLUTION_KINDS],
})
