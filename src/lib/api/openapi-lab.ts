import type { z } from 'zod'
import {
  createStageSchema,
  createSubjectNoteSchema,
  createSubjectSchema,
  createSubjectTodoSchema,
  createTagSchema,
  handoffSchema,
  humanNoteSchema,
  labSettingsSchema,
  listHandoffsQuery,
  listSubjectNotesQuery,
  listSubjectsQuery,
  listTodosQuery,
  mentionsQuery,
  reorderSchema,
  updateStageSchema,
  updateSubjectSchema,
  updateTagSchema,
} from './lab-schemas'
import { STAGE_CATEGORIES, SUBJECT_NOTE_KINDS } from './lab-shape'

/**
 * The Lab's half of the spec (docs/lab.md). Bodies and queries come from the
 * Zod schemas the routes validate with; response shapes follow the contract.
 */

type Schema = Record<string, unknown>

export type OpenapiHelpers = {
  json: (schema: z.ZodType) => Schema
  body: (schema: Schema) => unknown
  okResponse: (description: string, data?: Schema) => unknown
  errorResponse: unknown
}

const nullable = (shape: Schema) => ({ ...shape, type: ['object', 'null'] })

export const handoffShape = {
  type: 'object',
  description: 'Where the task was handed off to. The tracker owns its status while this is open.',
  properties: {
    tracker: { type: 'string', example: 'github' },
    ref: { type: 'string', example: 'montytorr/kdp#41' },
    url: { type: ['string', 'null'] },
    status: { type: ['string', 'null'], description: 'What the tracker said at the last sync. `done` or `cancelled` ends the hand-off.' },
    synced_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['tracker', 'ref', 'url', 'status', 'synced_at'],
}

export const taskSubjectShape = {
  type: ['object', 'null'],
  description: 'The subject this task is a todo of. Present only while the Lab is on.',
  properties: { ref: { type: 'string', example: 'LAB-12' }, title: { type: 'string' } },
  required: ['ref', 'title'],
}

const stage = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', example: 'exploring' },
    category: { type: 'string', enum: [...STAGE_CATEGORIES] },
    color: { type: 'string', example: '#6b7fa6' },
    position: { type: 'integer' },
  },
  required: ['id', 'name', 'category', 'color', 'position'],
}

const tag = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string', description: 'Lower case.' },
    color: { type: 'string' },
    position: { type: 'integer' },
  },
  required: ['id', 'name', 'color', 'position'],
}

const labPerson = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
  required: ['id', 'name'],
}

const projectRef = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' }, key: { type: 'string' }, title: { type: 'string' } },
  required: ['id', 'key', 'title'],
}

const subjectSummaryProperties = {
  id: { type: 'string', format: 'uuid' },
  ref: { type: 'string', example: 'LAB-12' },
  number: { type: 'integer' },
  title: { type: 'string' },
  stage,
  tags: { type: 'array', items: tag },
  project: nullable(projectRef),
  owner: nullable(labPerson),
  conclusion: { type: ['string', 'null'], description: 'The recorded answer.' },
  concluded_at: { type: ['string', 'null'], format: 'date-time' },
  todos: {
    type: 'object',
    properties: { open: { type: 'integer' }, done: { type: 'integer', description: 'Done or cancelled.' } },
    required: ['open', 'done'],
  },
  position: { type: 'integer' },
  actor_type: { type: 'string', enum: ['human', 'agent'] },
  actor_id: { type: 'string' },
  created_at: { type: 'string', format: 'date-time' },
  updated_at: { type: 'string', format: 'date-time' },
  archived_at: { type: ['string', 'null'], format: 'date-time' },
}

const subjectSummary = {
  type: 'object',
  properties: subjectSummaryProperties,
  required: Object.keys(subjectSummaryProperties),
}

const subject = {
  type: 'object',
  properties: { ...subjectSummaryProperties, body: { type: ['string', 'null'], description: 'The write-up, markdown.' } },
  required: [...Object.keys(subjectSummaryProperties), 'body'],
}

const subjectNote = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: [...SUBJECT_NOTE_KINDS] },
    note: { type: 'string' },
    actor_type: { type: 'string' },
    actor_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'kind', 'note', 'actor_type', 'actor_id', 'created_at'],
}

const humanNote = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    body: { type: 'string' },
    author: nullable(labPerson),
    actor_type: { type: 'string' },
    actor_id: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'body', 'author', 'actor_type', 'actor_id', 'created_at', 'updated_at'],
}

const labAttachment = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    filename: { type: 'string' },
    mime_type: { type: 'string' },
    size_bytes: { type: 'integer' },
    uploaded_by: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    preview_url: { type: 'string', description: 'Signed, valid for an hour.' },
    download_url: { type: 'string', description: 'Signed, valid for an hour.' },
    content_url: { type: 'string', description: 'The stable address, `/api/v1/attachments/{id}/content`.' },
  },
  required: ['id', 'filename', 'mime_type', 'size_bytes', 'uploaded_by', 'created_at', 'preview_url', 'download_url', 'content_url'],
}

const todo = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    ref: { type: 'string', example: 'LT-41' },
    number: { type: 'integer' },
    title: { type: 'string' },
    status: { type: 'string' },
    priority: { type: 'string' },
    type: { type: 'string' },
    claimed_by: { type: ['string', 'null'] },
    assignee: nullable(labPerson),
    handoff: nullable(handoffShape),
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'ref', 'number', 'title', 'status', 'priority', 'type', 'claimed_by', 'assignee', 'handoff', 'updated_at'],
}

const labSettings = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    home_project: { ...nullable(projectRef), description: 'Where todos of a subject with no project are filed. Null until set or created.' },
    updated_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['enabled', 'home_project', 'updated_at'],
}

const deleted = (extra: Schema = {}) => ({
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' }, deleted: { const: true }, ...extra },
  required: ['id', 'deleted', ...Object.keys(extra)],
})

const arrayOf = (items: Schema) => ({ type: 'array', items })

const subjectRefParam = {
  name: 'ref',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'Subject reference: `LAB-12`, `lab-12`, `12`, or a UUID.',
}

const uuidParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
  description,
})

const LAB_OFF = 'Answers 404 `lab_disabled` while the Lab is off.'

export const labPaths = ({ json, body, okResponse, errorResponse }: OpenapiHelpers) => {
  /** Query parameters straight from a route's Zod query schema. */
  const queryParams = (schema: z.ZodType, descriptions: Record<string, string> = {}) =>
    Object.entries((json(schema).properties ?? {}) as Record<string, Schema>).map(([name, s]) => ({
      name,
      in: 'query',
      schema: s,
      ...(descriptions[name] ? { description: descriptions[name] } : {}),
    }))

  return {
    '/lab/settings': {
      get: {
        summary: 'Read the Lab switch',
        description: 'Any signed-in caller, whether the Lab is on or off. The one Lab route that never answers `lab_disabled`.',
        responses: { '200': okResponse('Lab settings.', labSettings), '401': errorResponse },
      },
      put: {
        summary: 'Turn the Lab on or off, or choose its home project',
        description:
          'A human administrator signed in to the web app only; agent keys are refused with 403, even ' +
          'an admin\'s. Turning it off hides, it never deletes. `homeProject` is where todos of a subject ' +
          'with no project are filed; `null` goes back to the default (`LT`, created on the first todo). ' +
          'Enabling is refused with 409 `conflict` while a project, live or by a former key, is `LAB`: ' +
          'the error names the project to rekey first. When turning it on cannot add the database\'s ' +
          '`LAB` reservation, it is turned on anyway and the answer carries a `warning`.',
        requestBody: body(json(labSettingsSchema)),
        responses: {
          '200': okResponse('Lab settings, plus `warning` when the LAB reservation could not be added.', {
            ...labSettings,
            properties: { ...(labSettings as { properties?: object }).properties, warning: { type: 'string' } },
          }),
          '400': errorResponse,
          '401': errorResponse,
          '403': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/lab/stages': {
      get: {
        summary: 'List stages, by position',
        description: `${LAB_OFF} An idea is a subject in a \`planned\` stage.`,
        responses: { '200': okResponse('Stages.', arrayOf(stage)), '404': errorResponse },
      },
      post: {
        summary: 'Add a stage (admin)',
        description: `Placed last when no \`position\` is sent. Names are unique, case-insensitive. ${LAB_OFF}`,
        requestBody: body(json(createStageSchema)),
        responses: {
          '201': okResponse('Created.', stage),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/lab/stages/{id}': {
      parameters: [uuidParam('id', 'Stage id.')],
      patch: {
        summary: 'Change a stage (admin)',
        description: `Changing a stage's category does not re-check its subjects' conclusions. ${LAB_OFF}`,
        requestBody: body(json(updateStageSchema)),
        responses: {
          '200': okResponse('Updated.', stage),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
      delete: {
        summary: 'Delete a stage (admin)',
        description:
          'Refused with 409 `stage_in_use` `{ subjects }` while any subject, archived included, is in it, ' +
          `and with 409 \`conflict\` for the last stage. ${LAB_OFF}`,
        responses: {
          '200': okResponse('Deleted.', deleted()),
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/lab/stages/reorder': {
      post: {
        summary: 'Reorder every stage (admin)',
        description: `\`ids\` must name every stage exactly once, else 400 \`validation_failed\`. ${LAB_OFF}`,
        requestBody: body(json(reorderSchema)),
        responses: {
          '200': okResponse('Stages in their new order.', arrayOf(stage)),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/lab/tags': {
      get: {
        summary: 'List tags, by position then name',
        description: `Curated by administrators; subjects only, task labels are separate. ${LAB_OFF}`,
        responses: { '200': okResponse('Tags.', arrayOf(tag)), '404': errorResponse },
      },
      post: {
        summary: 'Add a tag (admin)',
        description: `Names are stored lower-cased and are unique. ${LAB_OFF}`,
        requestBody: body(json(createTagSchema)),
        responses: {
          '201': okResponse('Created.', tag),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/lab/tags/{id}': {
      parameters: [uuidParam('id', 'Tag id.')],
      patch: {
        summary: 'Change a tag (admin)',
        description: LAB_OFF,
        requestBody: body(json(updateTagSchema)),
        responses: {
          '200': okResponse('Updated.', tag),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
      delete: {
        summary: 'Delete a tag (admin)',
        description: `Takes it off every subject carrying it; \`subjects\` says how many. ${LAB_OFF}`,
        responses: {
          '200': okResponse('Deleted.', deleted({ subjects: { type: 'integer' } })),
          '403': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/subjects': {
      get: {
        summary: 'List subjects',
        description:
          'Ordered by stage position, then position, then number. An unknown stage, tag or project is ' +
          `400 \`validation_failed\` listing the valid ones. ${LAB_OFF}`,
        parameters: queryParams(listSubjectsQuery, {
          stage: 'Stage name or id, or a comma list.',
          category: 'Comma list of planned, active, completed, dropped. `planned` is the Ideas filter.',
          tag: 'Tag name, or a comma list: subjects carrying any.',
          owner: '`me`, a user id, an email or a display name.',
          project: 'A project key or id, `none`, or a comma list.',
          q: 'Full-text over title, conclusion and body.',
          archived: 'Omitted or `exclude`: live only.',
        }),
        responses: { '200': okResponse('Subjects.', arrayOf(subjectSummary)), '400': errorResponse, '404': errorResponse },
      },
      post: {
        summary: 'File a subject',
        description:
          'Defaults to the first `planned` stage and the caller\'s human as owner. Filing into a ' +
          '`completed` or `dropped` stage needs a `conclusion`, else 400 `conclusion_required` ' +
          '`{ stage, category }`. `number` is for the importer: admins only (403 otherwise), 409 ' +
          `\`conflict\` when taken. Numbers are never reused. ${LAB_OFF}`,
        requestBody: body(json(createSubjectSchema)),
        responses: {
          '201': okResponse('Created.', subject),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}': {
      parameters: [subjectRefParam],
      get: {
        summary: 'Get a subject',
        description: LAB_OFF,
        responses: { '200': okResponse('Subject.', subject), '404': errorResponse },
      },
      patch: {
        summary: 'Update a subject',
        description:
          'Omitted fields are left alone; `tags` replaces the set. Moving into a `completed` or ' +
          '`dropped` stage needs a conclusion, sent with the move or already on the subject, and so ' +
          'does clearing or changing it while there; otherwise 400 `conclusion_required`. ' +
          '`concluded_at` is set on the way in and cleared on the way out; the conclusion text is ' +
          'kept. A stage move writes a `stage` log note. `archived: true` takes it off the board, ' +
          'still searchable; `false` restores it. Changing `project` does not move existing todos. ' +
          LAB_OFF,
        requestBody: body(json(updateSubjectSchema)),
        responses: { '200': okResponse('Updated.', subject), '400': errorResponse, '404': errorResponse },
      },
      delete: {
        summary: 'Delete a subject (owner or admin)',
        description:
          'For mistakes and duplicates; archive to retire one. Requires `?confirm=<REF>`. A subject ' +
          'with todos, open or closed, is refused with 409 `subject_has_todos` `{ todos, open }` ' +
          'unless `todos=detach`, which keeps each todo where it is, clears its subject and notes why. ' +
          'Todos are never deleted here. The log, people\'s notes and files go with the subject. ' +
          LAB_OFF,
        parameters: [
          { name: 'confirm', in: 'query', required: true, schema: { type: 'string' }, description: 'The subject ref, repeated back.' },
          { name: 'todos', in: 'query', schema: { type: 'string', enum: ['detach'] } },
        ],
        responses: {
          '200': okResponse('Deleted.', {
            type: 'object',
            properties: {
              deleted: { const: true },
              ref: { type: 'string' },
              id: { type: 'string', format: 'uuid' },
              todos_detached: { type: 'integer' },
              files_removed: { type: 'integer' },
            },
            required: ['deleted', 'ref', 'id', 'todos_detached', 'files_removed'],
          }),
          '400': errorResponse,
          '403': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}/notes': {
      parameters: [subjectRefParam],
      get: {
        summary: 'Read the subject\'s log, newest first',
        description: LAB_OFF,
        parameters: queryParams(listSubjectNotesQuery, { kind: 'Comma list of kinds.' }),
        responses: { '200': okResponse('Log notes.', arrayOf(subjectNote)), '404': errorResponse },
      },
      post: {
        summary: 'Append to the subject\'s log',
        description:
          'Append-only. `stage` notes are the server\'s, written on every stage move, and cannot be ' +
          'posted. A retry of the same kind and text writes nothing and answers 200 with ' +
          `\`duplicate: true\`. ${LAB_OFF}`,
        requestBody: body(json(createSubjectNoteSchema)),
        responses: {
          '201': okResponse('Created.', subjectNote),
          '200': okResponse('Duplicate; nothing written.'),
          '400': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/subjects/{ref}/human-notes': {
      parameters: [subjectRefParam],
      get: {
        summary: 'People\'s notes on a subject, newest first',
        description: LAB_OFF,
        responses: { '200': okResponse('Notes.', arrayOf(humanNote)), '404': errorResponse },
      },
      post: {
        summary: 'Add a note card',
        description: `An agent's key writes as its human: they are one author. ${LAB_OFF}`,
        requestBody: body(json(humanNoteSchema)),
        responses: { '201': okResponse('Created.', humanNote), '400': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/{ref}/human-notes/{id}': {
      parameters: [subjectRefParam, uuidParam('id', 'Note id.')],
      patch: {
        summary: 'Edit a note card (the author)',
        description: LAB_OFF,
        requestBody: body(json(humanNoteSchema)),
        responses: { '200': okResponse('Updated.', humanNote), '400': errorResponse, '403': errorResponse, '404': errorResponse },
      },
      delete: {
        summary: 'Delete a note card (the author or an admin)',
        description: LAB_OFF,
        responses: { '200': okResponse('Deleted.', deleted()), '403': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/{ref}/attachments': {
      parameters: [subjectRefParam],
      get: {
        summary: 'List a subject\'s files, oldest first',
        description: LAB_OFF,
        responses: { '200': okResponse('Files.', arrayOf(labAttachment)), '404': errorResponse },
      },
      post: {
        summary: 'Upload a file to a subject',
        description: `The same size, type and extension rules as task attachments. ${LAB_OFF}`,
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
        responses: { '201': okResponse('Uploaded, with signed URLs.', labAttachment), '400': errorResponse, '404': errorResponse },
      },
    },
    '/subjects/{ref}/attachments/{id}': {
      parameters: [subjectRefParam, uuidParam('id', 'Attachment id.')],
      delete: {
        summary: 'Delete a subject\'s file',
        description: `Anyone may, as with a task's file. ${LAB_OFF}`,
        responses: { '200': okResponse('Deleted.', deleted()), '404': errorResponse },
      },
    },
    '/subjects/{ref}/todos': {
      parameters: [subjectRefParam],
      get: {
        summary: 'A subject\'s todos, across projects',
        description: `Open first, then by position and number. Includes sub-tasks of todos. ${LAB_OFF}`,
        parameters: queryParams(listTodosQuery, { status: 'Comma list of task statuses.' }),
        responses: { '200': okResponse('Todos.', arrayOf(todo)), '400': errorResponse, '404': errorResponse },
      },
      post: {
        summary: 'File a todo',
        description:
          'A todo is an ordinary task with its `subject` set. It is filed in the subject\'s project, ' +
          'or else the Lab home project, which the first todo creates as `LT` when none is set. If `LT` ' +
          'is taken by an unrelated project the todo is refused with 409 `conflict`: an admin chooses ' +
          `one with \`PUT /lab/settings\`. ${LAB_OFF}`,
        requestBody: body(json(createSubjectTodoSchema)),
        responses: {
          '201': okResponse('The created task, in the full task shape.'),
          '400': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
    },
    '/subjects/{ref}/mentions': {
      parameters: [subjectRefParam],
      get: {
        summary: 'Tasks whose text mentions this subject, newest first',
        description: `Descriptions, resolutions, notes and comments that write \`LAB-12\`. ${LAB_OFF}`,
        parameters: queryParams(mentionsQuery),
        responses: {
          '200': okResponse('Mentions.', {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              items: arrayOf({
                type: 'object',
                properties: {
                  ref: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string' },
                  source: { type: 'string' },
                  excerpt: { type: 'string' },
                  at: { type: 'string', format: 'date-time' },
                },
              }),
            },
            required: ['total', 'items'],
          }),
          '404': errorResponse,
        },
      },
    },
    '/tasks/{ref}/handoff': {
      parameters: [
        { name: 'ref', in: 'path', required: true, schema: { type: 'string' }, description: 'Task reference — `CAI-42`, or a raw UUID.' },
      ],
      post: {
        summary: 'Hand a task off to another tracker, re-link it, or sync it',
        description:
          'Not a Lab feature: works on any task, Lab on or off. The server never calls the tracker; ' +
          'this records the link. A new or different tracker and ref links: any claim is released ' +
          'and a `doing` task goes back to `todo`. The same tracker and ref syncs: it records `status`. ' +
          'A `done` or `cancelled` status ends the hand-off and closes the task once with that outcome. ' +
          'A `cairn` tracker needs `url`, the destination task\'s absolute https URL (a sync may omit ' +
          'it). While open, status changes, claim and release are refused with 409 `handed_off`. 409 ' +
          '`conflict` when the task\'s project is archived.',
        requestBody: body(json(handoffSchema)),
        responses: {
          '200': okResponse('Linked or synced.', {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              id: { type: 'string', format: 'uuid' },
              subject: { type: ['string', 'null'], example: 'LAB-12' },
              handoff: handoffShape,
              status: { type: 'string', description: 'The task\'s own status.' },
              noted: { type: 'boolean', description: 'A line was written to the subject\'s log.' },
              closed: { type: 'boolean', description: 'This sync ended the hand-off and closed the task.' },
            },
            required: ['ref', 'id', 'subject', 'handoff', 'status', 'noted', 'closed'],
          }),
          '400': errorResponse,
          '404': errorResponse,
          '409': errorResponse,
        },
      },
      delete: {
        summary: 'Take a hand-off back',
        description:
          'Clears the link; nothing is done in the other tracker. 409 `conflict` when the task is not ' +
          'handed off.',
        responses: { '200': okResponse('The task.'), '404': errorResponse, '409': errorResponse },
      },
    },
    '/handoffs': {
      get: {
        summary: 'Handed-off tasks, for a sync to walk',
        description: 'Not a Lab feature. `state` defaults to `open`.',
        parameters: queryParams(listHandoffsQuery, { project: 'A project key or id.' }),
        responses: {
          '200': okResponse('Hand-offs.', arrayOf({
            type: 'object',
            properties: {
              ref: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
              subject: { type: ['string', 'null'], example: 'LAB-12' },
              handoff: handoffShape,
            },
            required: ['ref', 'title', 'status', 'subject', 'handoff'],
          })),
          '400': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/attachments/{id}/content': {
      parameters: [uuidParam('id', 'Attachment id, a task\'s or a subject\'s.')],
      get: {
        summary: 'The stable address of a file, for markdown to embed',
        description:
          'Authenticates the viewer and redirects to a freshly signed preview URL, so a write-up can ' +
          'embed `![shot](/api/v1/attachments/<id>/content)` where a signed link would expire. A ' +
          'subject\'s file is 404 while the Lab is off.',
        responses: {
          '302': {
            description: 'Redirect to a signed preview. `Location` is relative; `cache-control: private, no-store`.',
            headers: { Location: { schema: { type: 'string' } } },
          },
          '404': errorResponse,
        },
      },
    },
  }
}
