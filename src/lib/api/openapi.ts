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
          'Returns an index, never bodies. Hits carrying a resolution rank first. ' +
          'Note that matching is keyword-based (Postgres FTS ANDs terms), so a ' +
          'paraphrase can miss.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
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
                    ref: { type: 'string' },
                    title: { type: 'string' },
                    type: { type: 'string', enum: [...TASK_TYPES] },
                    status: { type: 'string', enum: [...TASK_STATUSES] },
                    resolved: { type: 'boolean', description: 'Whether an answer is recorded.' },
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
      get: { summary: 'Get a task', responses: { '200': okResponse('Task.', taskSummary), '404': errorResponse } },
      patch: {
        summary: 'Update a task',
        description:
          'Omitted fields are left alone. Moving to `done` or `cancelled` requires ' +
          '`resolution`, otherwise the request is refused with `resolution_required`.',
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
