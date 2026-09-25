import { z } from 'zod'
import {
  createNoteSchema,
  createActivityEvidenceSchema,
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

/**
 * What a knowledge write says when its `[[refs]]` do not resolve.
 *
 * The ordinary failure envelope plus the half that makes it actionable. 63% of
 * the dangling references already in the store point at a fact Cairn holds
 * under a different slug, so "that does not exist" is true and useless; the
 * names that nearly are it are the answer. `error` repeats all of it in prose,
 * because the CLI prints that field and drops everything beside it.
 */
const referenceRefusalResponse = {
  description:
    'A `[[reference]]` in the body points at no entry. `code` is `validation_failed`. ' +
    'Nothing was written.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          success: { const: false },
          error: {
            type: 'string',
            description:
              'The whole refusal, in prose: which reference missed, the slug it probably ' +
              'meant, and how to record it anyway if it really is new.',
          },
          code: { const: 'validation_failed' },
          unresolvedReferences: {
            type: 'array',
            description:
              'Every reference that resolved to nothing, whether or not it is what caused ' +
              'the refusal — only the ones with a near-named entry do that.',
            items: {
              type: 'object',
              properties: {
                slug: {
                  type: 'string',
                  description: 'Normalised: lowercased, underscores read as hyphens.',
                },
                raw: { type: 'string', description: 'As the author spelled it.' },
                suggestions: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Existing slugs that are close, closest first, at most three. Often empty.',
                },
                certain: {
                  type: 'boolean',
                  description:
                    'A suggestion is close enough to call this a misspelt name rather than a ' +
                    'fact nobody has written yet. This is what the refusal is for; send ' +
                    '`allowUnresolvedRefs` to record it anyway.',
                },
              },
            },
          },
          taskReferences: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Task refs somebody put in wiki brackets — `[[CAI-42]]`. Refused outright and ' +
              'not covered by `allowUnresolvedRefs`: inside `[[...]]` it reads as a knowledge ' +
              'slug and points at an entry that will never exist. Write it bare.',
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

/**
 * How a lookup was reached when it went through a key the project no longer
 * has. Present only then — a current key or ref changes nothing (CAIRN-264).
 */
const keyRename = {
  type: 'object',
  description:
    'Present only when the key asked for is one the project used to have. The answer ' +
    'is for the live project; this says so, so a caller holding an old ref can tell ' +
    'it reached the same thing.',
  properties: {
    key: { type: 'string', example: 'AC', description: 'The retired key that was asked for.' },
    to: { type: 'string', example: 'HOL', description: 'The live key — use this from now on.' },
    at: { type: 'string', format: 'date-time', description: 'When `key` was retired.' },
    by: { type: ['string', 'null'], description: 'Who retired it; null for renames recorded before this was kept.' },
  },
  required: ['key', 'to', 'at', 'by'],
}

const formerKey = {
  type: 'object',
  properties: {
    key: { type: 'string', example: 'AC' },
    retired_at: { type: 'string', format: 'date-time' },
    retired_by: { type: ['string', 'null'] },
    new_key: {
      type: ['string', 'null'],
      description: 'What the key was renamed to at the time, which after a second rename is not the live key.',
    },
  },
}

const formerKeys = {
  type: 'array',
  items: formerKey,
  description: 'Keys this project used to have, oldest first. Refs under each still resolve.',
}

/**
 * The stored entry, and the one thing about it that is not a column.
 *
 * A reference resolving to nothing with nothing close to it is accepted rather
 * than refused — two entries that cite each other cannot both be written first
 * — so the write succeeds and says so anyway. Absent when there is nothing to
 * say, which is the usual case.
 */
const knowledgeEntry = {
  type: 'object',
  description: 'The stored row.',
  properties: {
    slug: { type: 'string' },
    title: { type: 'string' },
    body: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Accepted, and still worth saying: one line per `[[reference]]` that points at no ' +
        'entry, naming any close matches. Silence is what let 70 of these accumulate.',
    },
  },
}

const counts = (properties: Record<string, unknown>) => ({ type: 'object', properties })

const integer = (description: string) => ({ type: 'integer', description })

/**
 * The vital signs, spelled out rather than left as "an object".
 *
 * Worth the space because two of these have already been read wrong from the
 * outside. `tasks.closedWithoutTrace` was `closedUnclaimed` until migration
 * 054 and counts something different now, so a consumer reading the old key
 * gets `undefined` rather than a wrong number — deliberately. And `memory` is
 * nullable, not optional-shaped-like-a-zero: this endpoint is the monitor, and
 * a monitor that fails outright because one of its two questions is
 * unanswerable has stopped answering the other one too.
 */
const vitalsReport = {
  type: 'object',
  properties: {
    windowHours: integer('The window these counts cover.'),
    sessions: counts({
      recent: integer('Sessions recorded in the window.'),
      recentWithFiles: integer('Of those, how many name a file.'),
      recentSummarised: integer(
        'Of those, how many have the prose half. The summariser costs a model call and ' +
          'the hook keeps the row when it cannot reach one, so this is where it shows.',
      ),
      baseline: integer('The same count over the week before, unscaled.'),
      baselineWithFiles: integer('The same, for sessions naming a file.'),
    }),
    tasks: counts({
      opened: integer('Filed in the window.'),
      closed: integer('Moved to done or cancelled in the window.'),
      stalled: integer('Open, and nothing has happened on them.'),
      held: integer('Under a live claim.'),
      closedWithoutTrace: {
        type: 'integer',
        description:
          'Closed by a runtime with nothing recorded between filing and close that anyone ' +
          'was on it: no claim, no checkpoint, no status move off the status it was filed ' +
          'in, no commit, no push, no test run. **Renamed from `closedUnclaimed`**, which ' +
          'asked a narrower question and answered it wrongly — nine of ten tasks it flagged ' +
          'had moved to in-review hours earlier, several with commits against them. Absent ' +
          'from a server older than migration 054; treat absent as unknown rather than zero, ' +
          'because one on 051 sends the old key under the old meaning.',
      },
    }),
    autoReleased: integer('Claims released by the backstop rather than by their holder.'),
    knowledgeWritten: integer('Entries learned or corrected in the window.'),
    agents: {
      type: 'array',
      description: 'Who wrote anything, against the week before. Not a leaderboard.',
      items: counts({
        agent: { type: 'string' },
        actorType: {
          type: 'string',
          description: 'Absent on a server older than migration 050. A person is not a runtime that has gone quiet.',
        },
        recent: { type: 'integer' },
        baseline: { type: 'integer' },
      }),
    },
    memory: {
      type: ['object', 'null'],
      description:
        'Whether anybody consults what is already known. Every other number here describes ' +
        'what was written; none described whether any of it was read, and a store nobody ' +
        'queries is an expensive way to write into a drawer. **Null when the aggregate ' +
        'cannot be read** — the rest of the report is still served.',
      properties: {
        windowHours: integer('The window, which is the same one as above.'),
        searches: integer(
          'Searches in the window. Direct reads by slug are counted separately, in ' +
            'directReads — pooling them would make widened and zeroResults unreadable, ' +
            'since a slug lookup has no second pass and its empty result means the ' +
            'opposite of an empty search.',
        ),
        widened: integer(
          'Of those, how many fell back from the precise AND pass to OR because the first ' +
            'came back thin. A high share means the phrasing is missing on the first try.',
        ),
        zeroResults: integer('Of those, how many returned nothing at all.'),
        byAgent: {
          type: 'array',
          description: 'Who is doing the searching. An agent absent here is one not checking.',
          items: counts({ agent: { type: 'string' }, searches: { type: 'integer' } }),
        },
        tasksFiled: integer('Tasks filed in the window.'),
        tasksFiledWithoutChecking: integer(
          'Of those, how many were filed with no search beforehand — work begun without ' +
            'asking whether it had already been done.',
        ),
        recentMisses: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Recent subjects that were searched for and found nothing. Each is either a ' +
            'gap in the memory or a phrasing the index does not match.',
        },
        directReads: integer(
          'Facts looked up by slug rather than searched for — `cairn know <slug>`, the ' +
            'MCP tool, and every browser read. Absent from a server before migration ' +
            '053, which is not the same as zero.',
        ),
        directReadMisses: integer(
          'Of those, how many named a slug that does not exist. This is the interesting ' +
            'one: it is a dangling reference being followed in real time rather than ' +
            'found later by a diagnostic nobody is obliged to run.',
        ),
        recentSlugMisses: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The slugs behind those misses. Two thirds of the dangling references in the ' +
            'store point at a fact that exists under another name, so these are usually a ' +
            'handle spelled wrong rather than knowledge nobody has written.',
        },
      },
    },
    findings: {
      type: 'array',
      description:
        'The counts that should not be what they are, already judged against the week ' +
        'before. Empty is the healthy answer, and the reason this can drive a job that ' +
        'speaks only when there is something to say.',
      items: counts({
        code: { type: 'string', example: 'no-sessions' },
        severity: { type: 'string', enum: ['alarm', 'warning'] },
        message: { type: 'string', description: 'What was seen, in full. Not a template to fill in.' },
      }),
    },
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
          'One API key per agent (`sk_live_…`). The key\'s agent name and owning user are ' +
          'recorded on every write, which keeps the shared log attributable.',
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
              renamed_from: { ...keyRename, description: 'Set when `project` was a retired key; the search ran on the live one.' },
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
                    requestedRef: {
                      type: 'string',
                      description: 'Exact-ref hit only, when the ref asked for used a retired key (e.g. AC-113 for HOL-113).',
                    },
                    renamedFrom: keyRename,
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
        description:
          'Archived projects are omitted unless `?archived=1`. Each carries `former_keys`, ' +
          'last in the row: the keys it used to have, which still resolve.',
        parameters: [
          { name: 'archived', in: 'query', schema: { type: 'string', enum: ['1'] } },
        ],
        responses: {
          '200': okResponse('Projects.', {
            type: 'array',
            items: { type: 'object', properties: { key: { type: 'string' }, former_keys: formerKeys } },
          }),
          '401': errorResponse,
        },
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
          description: 'Project key (CAI), a key it used to have, or uuid. A retired key acts on the live project and the response carries `renamed_from`.' },
      ],
      get: {
        summary: 'Read a project, with its task count and former keys',
        responses: {
          '200': okResponse('Project.', {
            type: 'object',
            properties: {
              key: { type: 'string' },
              task_count: { type: 'integer' },
              former_keys: formerKeys,
              renamed_from: keyRename,
            },
          }),
          '404': errorResponse,
        },
      },
      patch: {
        summary: 'Rename a project, or change its key',
        requestBody: body({
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: ['string', 'null'] },
            key: {
              type: 'string',
              description:
                'Changing this changes every task ref. The former key is retained and keeps resolving, so refs already written into commits and notes still find the task; the response carries `former_key`, and the retirement records who made it and what the key became (`former_keys`). A key retired by another project is refused, because reusing it would make those refs ambiguous. `cairn project rekey <KEY> <NEW>` is the CLI for this.',
            },
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
    '/projects/{id}/repos': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' },
          description: 'Project key (CAI) or uuid.' },
      ],
      get: { summary: 'List the repositories claimed by a project', responses: { '200': okResponse('Repositories.') } },
      post: {
        summary: 'Claim a repository for this project',
        description:
          'How `/context` resolves a project without anything stored on the machine ' +
          'asking. The remote is normalised server-side, so ssh and https spellings of ' +
          'one repository reach one row. Idempotent, so a fresh clone can re-run it.',
        requestBody: body({
          type: 'object',
          properties: {
            remote: { type: 'string', description: 'Origin remote, any spelling.' },
            rootCommit: {
              type: 'string',
              description:
                'Optional. Repairs a claim after a rename or transfer. Never an identity ' +
                'on its own: a fork shares it, and a shallow clone reports the wrong one.',
            },
          },
          required: ['remote'],
        }),
        responses: { '200': okResponse('Claimed.'), '400': errorResponse },
      },
      delete: {
        summary: 'Release a repository claim',
        parameters: [{ name: 'remote', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': okResponse('Released.'), '400': errorResponse },
      },
    },
    '/projects/{id}/tasks': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' },
          description: 'Project key, a key it used to have, or UUID. A retired key lists the live project and the response carries `renamed_from`.' },
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
          'is 2KB and the 90th percentile 5KB, so the body is what a digest has to clip. ' +
          'A ref through a key the project used to have (AC-113 after AC became HOL) returns ' +
          'the task with `requested_ref` and `renamed_from`; a current ref has neither. ' +
          '`former_refs` lists the refs the task was actually issued under — only keys retired ' +
          'after it was created, so a task filed after a rename claims none. A retired-key ref ' +
          'to a task created after the rename is a 404 that names the live ref, because that ' +
          'old ref was never issued.',
        parameters: [
          { name: 'view', in: 'query', schema: { type: 'string', enum: ['full', 'digest'], default: 'full' } },
        ],
        responses: {
          '200': okResponse('Task.', {
            ...taskSummary,
            properties: {
              ...taskSummary.properties,
              requested_ref: { type: 'string', example: 'AC-113', description: 'The ref as asked for, when it used a retired key.' },
              renamed_from: keyRename,
              former_refs: {
                type: 'array',
                items: { type: 'string' },
                example: ['AC-113'],
                description: 'Refs this task was issued under before its project was renamed.',
              },
            },
          }),
          '404': errorResponse,
        },
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
      delete: {
        summary: 'Delete a task permanently',
        description:
          'For junk that should never have existed. Refused if the task has children, ' +
          'notes, comments or dependencies in either direction — cancel it instead, which ' +
          'keeps the record and the reason. Requires `?confirm=<REF>`.',
        parameters: [{ name: 'confirm', in: 'query', required: true, schema: { type: 'string' },
          description: 'The task ref, repeated back.' }],
        responses: { '200': okResponse('Deleted.'), '400': errorResponse, '404': errorResponse },
      },
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
      post: {
        summary: 'Record git delivery or command-run evidence',
        description:
          'Appends a structured git_commit, git_push, or run_result event to the task history.',
        requestBody: body(json(createActivityEvidenceSchema)),
        responses: { '201': okResponse('Evidence recorded.'), '404': errorResponse },
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
    '/tasks/{ref}/notes/{id}': {
      parameters: [
        refParam,
        { name: 'id', in: 'path', required: true, schema: { type: 'string' },
          description: 'Note id.' },
      ],
      delete: {
        summary: 'Withdraw a note you wrote',
        description:
          'Only the note\'s own author may remove it: a work log is the record of what was ' +
          'tried, and letting one agent erase another\'s would make it untrustworthy. Exists ' +
          'so a note written by mistake can be taken back, and so a scratch task that ' +
          'acquired one is not left permanently undeletable.',
        responses: { '200': okResponse('Withdrawn.'), '403': errorResponse, '404': errorResponse },
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
    '/activity': {
      get: {
        summary: 'One timeline of everything that happened',
        description:
          'A union across tasks filed, what changed on them, work-log notes, comments, ' +
          'sessions and knowledge written or corrected — ordered together rather than ' +
          'per-store, because the newest rows *of each kind* are not the newest rows. ' +
          'Paged by `before`, a keyset cursor: the feed grows from the head, so an OFFSET ' +
          'page drifts as soon as an agent writes anything. The response hands back ' +
          '`nextBefore` so the caller does not have to dig for it.',
        parameters: [
          { name: 'before', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'actor', in: 'query', schema: { type: 'string' } },
          {
            name: 'kinds',
            in: 'query',
            description: 'Comma-separated subset of task,event,note,comment,session,knowledge.',
            schema: { type: 'string', example: 'note,knowledge' },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
        ],
        responses: { '200': okResponse('The timeline.'), '400': errorResponse },
      },
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
          {
            name: 'unused',
            in: 'query',
            description:
              'Instead of the index: current entries no search returned and no direct read ' +
              'fetched in this many days, never-recalled first, leaving out entries younger ' +
              'than the window. The session briefing and `cairn recall` record nothing and are ' +
              'not counted; `counted` in the response says so.',
            schema: { type: 'integer', minimum: 1, maximum: 365 },
          },
        ],
        responses: {
          '200': okResponse(
            'Knowledge index. Each row carries `recalled`: searches that returned it plus direct ' +
              'reads in the last `recallWindowDays` days.',
          ),
        },
      },
      post: {
        summary: 'Record what we now know',
        description:
          'Omit `projects` and `entities` for a fact that is true everywhere. The slug is ' +
          'derived from the title when not given, and must be unique.\n\n' +
          '`[[refs]]` in the body are resolved before the row is written, not audited ' +
          'afterwards. One naming an entry that does not exist while a near-named one does ' +
          'is refused with the slug it probably meant; one naming nothing close is recorded ' +
          'with a `warning`. `allowUnresolvedRefs` records the refused case anyway, for the ' +
          'fact that genuinely has not been written yet.',
        requestBody: body(json(knowledgeCreate)),
        responses: {
          '201': okResponse('Recorded.', knowledgeEntry),
          '400': referenceRefusalResponse,
          '409': errorResponse,
        },
      },
    },
    '/knowledge/gaps': {
      get: {
        summary: 'Where the memory has holes',
        description:
          'Entries joined to nothing, references pointing at entries nobody ever wrote, ' +
          'and the sizes of the separate islands the corpus has fallen into. None of it ' +
          'appears in a list of knowledge, because a list shows what is there. Returns no ' +
          'coordinates: a reader with a screen needs somewhere to draw each node, a reader ' +
          'without one needs the facts.',
        responses: { '200': okResponse('Orphans, dangling references and island sizes.') },
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
          'and is marked.\n\n' +
          'A changed `body` runs the same reference check as the write, and refuses or warns ' +
          'the same way — otherwise the check is reachable in one hop: write a clean entry, ' +
          'then edit a dangling `[[ref]]` into it with nothing looking. A body that is not ' +
          'being changed is not re-checked, so a rename or a `verified` does not fail on a ' +
          'reference the entry has carried for weeks.',
        requestBody: body(json(knowledgeUpdate)),
        responses: {
          '200': okResponse('Updated.', knowledgeEntry),
          '400': referenceRefusalResponse,
          '404': errorResponse,
        },
      },
      delete: { summary: 'Forget it', responses: { '200': okResponse('Deleted.'), '404': errorResponse } },
    },
    '/tasks/{ref}/recall': {
      parameters: [
        { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'decisions', in: 'query', schema: { type: 'integer', default: 8, maximum: 30 } },
        { name: 'knowledge', in: 'query', schema: { type: 'integer', default: 8, maximum: 30 } },
      ],
      get: {
        summary: 'What already bears on this task',
        description:
          'Two lists, each line with `why` it was picked. `decisions`: resolutions and ' +
          'decision/finding notes on related tasks — ones that name this task (and the note ' +
          'that does), ones it names, its parent, sub-tasks, blockers, and answered tasks with ' +
          'a similar title. `knowledge`: current entries linked to files this task touched, ' +
          'learned on it or a related task, or matching its terms within its project, with ' +
          'their stale mark. `omitted` says how many lines each limit cut.',
        responses: { '200': okResponse('{ ref, title, decisions, knowledge, omitted }.'), '404': errorResponse },
      },
    },
    '/tasks/{ref}/mentions': {
      parameters: [
        { name: 'ref', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
      ],
      get: {
        summary: 'Where other tasks named this one',
        description:
          'Every note, comment, description and resolution on another task that writes this ' +
          'task\'s ref — through a retired key too — with the text around it. Decisions, ' +
          'findings and resolutions first, then handoffs and descriptions, then the rest; ' +
          'newest first within each. Indexed from what was written, not guessed: a mention is ' +
          'something somebody wrote. The digest carries the first five as `mentionedIn`.',
        responses: { '200': okResponse('{ total, mentions }.'), '404': errorResponse },
      },
    },
    '/knowledge/{slug}/history': {
      parameters: [
        { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
      ],
      get: {
        summary: 'What it used to say',
        description:
          'Every version an edit replaced, newest first: its title, body, labels and scope as ' +
          'they stood, and who replaced it, when, and why. `version` is the live row\'s ' +
          'number, so revision N is version N and the live row is `version`. A `verified` ' +
          'alone, or a PATCH that changes nothing, is not a new version.',
        responses: { '200': okResponse('The versions.'), '404': errorResponse },
      },
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
        summary: 'Checkpoint an ongoing session or record a finished session',
        description:
          'Set `ongoing: true` for an in-progress checkpoint: `ended_at` stays null, ' +
          'held tasks are not checkpointed, and a closed session cannot be reopened (409). ' +
          'Omit `ongoing` for the existing session-end behavior. Idempotent on ' +
          '(platformSource, externalId), which is a correctness requirement rather than a ' +
          'nicety: Codex has no session-end event so its writer runs on Stop, which fires ' +
          'every turn. `checkpointHeld` also checkpoints any task the agent still holds, ' +
          'so a claim it walked away from stops looking like live work.',
        requestBody: body(json(sessionUpsert)),
        responses: { '200': okResponse('Recorded.'), '409': errorResponse },
      },
    },
    '/next': {
      get: {
        summary: 'What to pick up next, ranked',
        description:
          'Finishing beats starting: work you already hold, then work dropped with a ' +
          'checkpoint, then dropped without one, then in-review, todo and backlog. ' +
          'Anything blocked, waiting on an unfinished task, or actively held by another ' +
          'agent is absent rather than ranked last. Each pick carries the reason it won. ' +
          'A `project` that is a retired key ranks the live project and returns `renamed_from`; ' +
          'one that names no project at all is a 404 rather than "nothing open".',
        parameters: [
          { name: 'project', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' },
            description: 'How many runners-up to return (default 5).' },
        ],
        responses: { '200': okResponse('A pick, the runners-up, and what was considered.') },
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
          { name: 'scope', in: 'query', schema: { type: 'string', enum: ['all', 'project'] },
            description: 'Defaults to all. Project scope limits held work, stale claims, and the last session; requires a resolved project.' },
          { name: 'repo', in: 'query', schema: { type: 'string' },
            description:
              'Origin remote. Resolves the project where a path cannot: a second clone, ' +
              'a moved directory, a worktree. Outranks `cwd`, yields to `project`.' },
        ],
        responses: {
          '200': okResponse('The briefing.', {
            type: 'object',
            properties: {
              project: { type: ['string', 'null'], description: 'Always the live key.' },
              projectRenamed: { ...keyRename, description: 'Set when `project` was a retired key.' },
              held: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    ref: { type: 'string' },
                    was: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Refs from before a rename in the last 30 days, e.g. ["AC-113"] beside HOL-113.',
                    },
                  },
                },
              },
            },
          }),
          '400': errorResponse,
          '404': errorResponse,
        },
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
    '/vitals': {
      get: {
        summary: "Cairn's own vital signs, and what looks wrong",
        description:
          'Counts for the last `hours` (default 24, max 720) against the week before, plus ' +
          '`findings` — the ones worth acting on. Separate from `/health`, which reports on ' +
          'the process: that probe stayed green through two days of recording no sessions ' +
          'at all. Intended for a scheduled job that speaks only when findings are present.\n\n' +
          'Two things here will break a consumer written against an older server. ' +
          '`tasks.closedWithoutTrace` replaces `closedUnclaimed` and answers a different ' +
          'question, so a reader of the old key now gets nothing rather than a number that ' +
          'means something else. And `memory` is new: whether agents *read* the store, ' +
          'which until now reached only a person with the Vitals page open — and the things ' +
          'that write knowledge here cannot open a browser. It is nullable by design.',
        parameters: [
          {
            name: 'hours',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 720, default: 24 },
          },
        ],
        responses: { '200': okResponse('Vital signs, memory use, and findings.', vitalsReport) },
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
    '/users': {
      get: {
        summary: 'List users (administrator browser session only)',
        responses: { '200': okResponse('Users.'), '403': errorResponse },
      },
      post: {
        summary: 'Create a user with an initial password',
        requestBody: body({
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', minLength: 12 },
            role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
          },
          required: ['email', 'displayName', 'password'],
        }),
        responses: { '201': okResponse('User created.'), '403': errorResponse, '409': errorResponse },
      },
    },
    '/users/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      patch: {
        summary: 'Edit a user',
        requestBody: body({
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
            role: { type: 'string', enum: ['admin', 'member'] },
          },
          minProperties: 1,
        }),
        responses: { '200': okResponse('User updated.'), '403': errorResponse, '409': errorResponse },
      },
      delete: {
        summary: 'Disable a user and revoke sessions and active keys',
        responses: { '200': okResponse('User disabled.'), '403': errorResponse, '409': errorResponse },
      },
    },
    '/users/{id}/restore': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: { summary: 'Restore a disabled user', responses: { '200': okResponse('User restored.'), '403': errorResponse } },
    },
    '/users/{id}/password': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      post: {
        summary: 'Reset a user password and revoke browser sessions',
        requestBody: body({
          type: 'object',
          properties: { password: { type: 'string', minLength: 12 } },
          required: ['password'],
        }),
        responses: { '200': okResponse('Password reset.'), '403': errorResponse },
      },
    },
    '/users/{id}/keys': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: { summary: 'List a user’s agent keys (never the hash)', responses: { '200': okResponse('Keys.'), '403': errorResponse } },
      post: {
        summary: 'Create an agent key for an active user',
        requestBody: body({
          type: 'object',
          properties: {
            agentName: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,40}$' },
            name: { type: 'string', minLength: 1, maxLength: 100 },
          },
          required: ['agentName', 'name'],
        }),
        responses: { '201': okResponse('Created; includes the plaintext key.'), '403': errorResponse, '409': errorResponse },
      },
    },
    '/users/{id}/keys/{keyId}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'keyId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      delete: { summary: 'Revoke one of a user’s agent keys', responses: { '200': okResponse('Key revoked.'), '403': errorResponse } },
    },
  },
  'x-resolution-kinds': [...RESOLUTION_KINDS],
})
