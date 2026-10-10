# The Lab

The Lab is where an instance explores and proves ideas before they become committed work. Its
unit is a **subject** (`LAB-12`): a technology to evaluate, a proof of concept, an idea. A
subject moves through curated **stages**, carries a write-up, an append-only **log**, people's
**notes**, **files** and curated **tags**, and ends with a **conclusion**. Its **todos** are
ordinary Cairn tasks.

It came from Croft (a fork of Cairn 0.12.1), folded back in by CAIRN-365 and built in
CAIRN-366. Everything here is the contract the CLI, the web UI and the Croft importer build
against.

Conventions are Cairn's own: every route lives under `/api/v1`, takes a bearer key or a
session cookie, and answers `{ "success": true, "data": … }` or
`{ "success": false, "error": "<sentence>", "code": "<code>", …extra }`. Field names in
responses are `snake_case` (rows); request bodies are `camelCase` where a field has two
words, as task routes already are.

## The switch: `lab_enabled`

The Lab is per instance and **off by default**. An instance that upgrades gets the tables,
empty, and nothing lab-shaped anywhere.

- Stored in a one-row table `lab_settings` (like `instance_branding`), read through a
  30-second in-process cache that a write invalidates.
- Read: `GET /api/v1/lab/settings`, any signed-in caller, **whether the Lab is on or off**.
- Toggle: `PUT /api/v1/lab/settings` with `{ "enabled": true }`. A **human administrator**
  only (`canAdministerUsers`, the same rule as branding). Agent keys are refused with
  `forbidden`, even an admin's.
- When it is off:
  - every Lab route below answers **404 `lab_disabled`**, except `/lab/settings`;
  - `search_all` returns no `subject` rows, and a `LAB-12` query resolves to nothing;
  - the activity feed shows no subject rows;
  - `buildContext` has no `lab` field;
  - the pulse still fingerprints the lab tables (cheap, and nothing listens);
  - the linkifier leaves `LAB-12` as text (the UI passes `lab: false`).
- Turning it off hides; it never deletes. Turning it back on shows everything as it was.
- Task-side Lab fields (`subject` on a task, `subject` filters) are ignored on input and
  absent on output while it is off. **Hand-off is not a Lab feature** and works either way
  (see below).

```http
GET /api/v1/lab/settings
→ 200 { "success": true, "data": {
        "enabled": false,
        "home_project": null,            // { "id", "key", "title" } once set or created
        "updated_at": "2026-10-10T20:00:00.000Z" | null } }

PUT /api/v1/lab/settings            (human admin)
{ "enabled": true,                  // optional
  "homeProject": "LT" | "<uuid>" | null }   // optional; null = back to the default
→ 200 same shape
errors: 403 forbidden · 400 validation_failed (unknown or archived project) · 401
```

## Refs

- A subject's ref is `LAB-<n>`, `n` ≥ 1. Output is always upper case. Input is accepted as
  `LAB-12`, `lab-12` or `12` on subject routes (`/subjects/{ref}`), and as a UUID.
- **`LAB` is reserved** in the project-key namespace, on every instance, whether or not the Lab
  is on, so a ref never means two things. Creating or renaming a project to `LAB` is refused
  with 400 `validation_failed` (`field: "key"`, `"LAB is reserved for Lab subjects"`), and a
  database check on `projects.key` and `project_former_keys.key` is the floor. Migration 071
  stops with a readable error if an instance already has a project keyed `LAB` (none of the
  known instances does).
- **Numbers are never reused.** A counter (`subject_number_counter`, one row) only goes up,
  as `projects.task_counter` does for tasks. Deleting `LAB-15` leaves a hole; the next subject
  is `LAB-16`. A failed insert rolls the counter back, so the only holes are deletions.
- An explicit `number` on create (the importer, admins only) is accepted if free, and moves the
  counter past it.
- `GET /api/v1/tasks/LAB-12` answers 404 `not_found` with
  `{ "subject": "LAB-12", "href": "/api/v1/subjects/LAB-12" }` when the Lab is on, so a CLI
  `show` can follow it. The task-ref parser does not otherwise change.
- In the UI a subject lives at `/lab/subjects/<n>` (the linkifier's target; P3 owns the page).

## Data model

Migrations 071 and up. Every table is instance-wide: there is no row-level visibility, and every
subject is visible to every user of the instance (Croft's 076 visibility half is not ported).

### `lab_settings` (one row)

| column | type | notes |
|---|---|---|
| `id` | boolean pk, `check (id)` | the single row |
| `enabled` | boolean not null default false | the switch |
| `home_project_id` | uuid → `projects` on delete set null | the todo home, see Todos |
| `updated_at`, `updated_by` | timestamptz, uuid → `app_users` | |

### `lab_stages`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `name` | text, 1–40, unique on `lower(name)` | `exploring` and `Exploring` are one stage |
| `category` | `planned` · `active` · `completed` · `dropped` | what the product reasons about |
| `color` | `^#[0-9a-f]{6}$` | |
| `position` | int | board order |
| `created_at`, `updated_at` | | touch trigger |

Seeded once, in order, by 071 (on conflict nothing):

| position | name | category | color |
|---|---|---|---|
| 0 | to explore | planned | `#8a8792` |
| 1 | exploring | active | `#6b7fa6` |
| 2 | done | completed | `#5f8a63` |
| 3 | rejected | dropped | `#a0685f` |
| 4 | to implement | planned | `#8f8a74` |
| 5 | implementing | active | `#a88a4e` |
| 6 | internal testing | active | `#86709e` |
| 7 | ready for rollout | active | `#4f8c86` |
| 8 | rolled out | completed | `#4e7f5a` |

An **idea** is a subject in a `planned` stage. There is no idea entity. The default stage for
a new subject is the first `planned` stage by position (`to explore`).

### `lab_tags`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `name` | text, 1–40, stored lower-cased and trimmed, unique | |
| `color` | `^#[0-9a-f]{6}$`, default `#8a8792` | |
| `position` | int | |
| `created_at`, `updated_at` | | |

Curated by administrators. Subjects only; task labels are untouched. `subject_tags (subject_id,
tag_id)` is the join, cascading on both sides; adding or removing a tag touches the subject.

### `subjects`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `number` | int not null unique | from the counter, by trigger |
| `title` | text, 1–300 | weight A |
| `body` | text null, ≤ 200 000 | the write-up, markdown, anyone edits; weight B |
| `stage_id` | uuid → `lab_stages` **on delete restrict** | a stage in use cannot be deleted |
| `owner_user_id` | uuid → `app_users` on delete set null | |
| `project_id` | uuid → `projects` **on delete set null** | optional, a real Cairn project |
| `conclusion` | text null, ≤ 20 000 | weight A: it is the recorded answer |
| `concluded_at` | timestamptz null | set entering a completed/dropped stage, cleared leaving |
| `position` | int | order within a stage |
| `actor_type`, `actor_id` | | who filed it |
| `created_at`, `updated_at`, `archived_at` | | `updated_at` moves on edits, log notes, human notes, files and tags |
| `search_vector` | generated tsvector | title A, conclusion A, body B |

### `subject_notes` (the log)

Append-only. `id, subject_id (cascade), kind, note (1–100 000), actor_type, actor_id, user_id,
content_hash, created_at`, unique `(subject_id, content_hash)`.

- Kinds: `note`, `finding`, `decision`, `attempt`, `handoff`, `stage`.
- Callers may write `note`, `finding`, `decision`, `attempt` and `handoff`. **`stage` is the
  server's**: written in the same transaction as every stage move, text `from → to`.
- The hash is `sha256(kind + "\n" + note)` (first 32 hex), so a retry writes nothing. Stage notes
  hash the moment too, so A → B → A → B is three notes.

### `subject_human_notes`

People's editable cards: `id, subject_id (cascade), body (markdown, 1–100 000), user_id (the
author, set null on user delete), actor_type, actor_id, created_at, updated_at`.
Only the author edits; the author or an administrator deletes. An agent's key writes as its
human: the author is `user_id`, so the human and their agents are one author.

### `subject_attachments`

Files on the subject itself, in Cairn's attachment store (disk or S3, signed links, the same
size, MIME and extension rules as task files): `id, subject_id (cascade), filename, mime_type,
size_bytes, storage_path (unique), sha256, uploaded_by (actor label), user_id, created_at`.
Stored under `lab/subjects/<subject_id>/<uuid>-<name>`.

### `subject_mentions`

`LAB-12` written in a task's description, resolution, note or comment is a mention of the
subject, kept by the same triggers that keep `task_mentions` (059):
`target_subject_id, source_task_id, source, note_id, comment_id, ref_as_written, created_at`.
Mentions written while the Lab is off are kept, and appear once it is on.

### Tasks

- `tasks.subject_id uuid → subjects on delete set null`: the task is a todo of that subject.
- Hand-off columns: `handoff_tracker`, `handoff_ref`, `handoff_url`, `handoff_status`,
  `handoff_synced_at` (see Hand-off).

### Projects

`projects.handoff_tracker` and `projects.handoff_target`: where this project's tasks are handed
off by default. Both or neither.

### Activity events

`task_activity_events.subject_id uuid` (no foreign key, so a deleted subject's history stays,
as task events outlive their task). New events: `subject_created`, `subject_stage_changed`,
`subject_archived`, `subject_restored`, `subject_deleted`, `handed_off`, `handoff_taken_back`.
`data` always carries `{ ref, title }` so a tombstone still reads.

## Response shapes

```ts
type Stage = { id: string; name: string; category: 'planned' | 'active' | 'completed' | 'dropped'
               color: string; position: number }
type Tag = { id: string; name: string; color: string; position: number }
type Person = { id: string; name: string }
type ProjectRef = { id: string; key: string; title: string }

type SubjectSummary = {
  id: string; ref: string /* LAB-12 */; number: number; title: string
  stage: Stage; tags: Tag[]; project: ProjectRef | null; owner: Person | null
  conclusion: string | null; concluded_at: string | null
  todos: { open: number; done: number }          // done = done or cancelled
  position: number; actor_type: 'human' | 'agent'; actor_id: string
  created_at: string; updated_at: string; archived_at: string | null
}
type Subject = SubjectSummary & { body: string | null }

type SubjectNote = { id: string; kind: string; note: string; actor_type: string; actor_id: string
                     created_at: string }
type HumanNote = { id: string; body: string; author: Person | null; actor_type: string
                   actor_id: string; created_at: string; updated_at: string }
type Attachment = { id: string; filename: string; mime_type: string; size_bytes: number
                    uploaded_by: string; created_at: string
                    preview_url: string; download_url: string   // signed, 1 hour
                    content_url: string }                       // /api/v1/attachments/{id}/content
type Handoff = { tracker: string; ref: string; url: string | null; status: string | null
                 synced_at: string | null }
type Todo = { id: string; ref: string; number: number; title: string; status: string
              priority: string; type: string; claimed_by: string | null
              assignee: Person | null; handoff: Handoff | null; updated_at: string }
```

Every task response (`GET/PATCH /tasks/{ref}`, lists, create) gains:

- `subject: { ref, title } | null`, while the Lab is on (absent while off);
- `handoff: Handoff | null`, always. The raw `handoff_*` columns are never returned.

## Routes

All Lab routes answer **404 `lab_disabled`** while the Lab is off, before anything else
(after authentication). "Admin" below means `role = admin`, a human or one of an admin's agent
keys, since stages and tags are shared configuration, not credentials. `/lab/settings` is the
one exception that needs a human admin.

Common errors on every route: 401 `unauthorized`, 400 `validation_failed` (zod `issues`),
429 `rate_limited`, 404 `lab_disabled`.

### Settings

`GET /api/v1/lab/settings` and `PUT /api/v1/lab/settings`, above.

### Stages

| method | path | who | body | response |
|---|---|---|---|---|
| GET | `/lab/stages` | anyone | | `Stage[]` by position |
| POST | `/lab/stages` | admin | `{ name, category, color?, position? }` | 201 `Stage` (last when no position) |
| PATCH | `/lab/stages/{id}` | admin | any of `{ name, category, color, position }` | `Stage` |
| DELETE | `/lab/stages/{id}` | admin | | `{ id, deleted: true }` |
| POST | `/lab/stages/reorder` | admin | `{ ids: uuid[] }`, every stage exactly once | `Stage[]` |

Errors: 403 `forbidden`; 404 `not_found`; 409 `conflict` (duplicate name, case-insensitive;
deleting the last stage); 409 **`stage_in_use`** `{ subjects: n }` when any subject, archived
included, is in the stage; 400 `validation_failed` (reorder ids not exactly the set).
Changing a stage's category does not re-check its subjects' conclusions.

### Tags

| method | path | who | body | response |
|---|---|---|---|---|
| GET | `/lab/tags` | anyone | | `Tag[]` by position, then name |
| POST | `/lab/tags` | admin | `{ name, color?, position? }` | 201 `Tag` |
| PATCH | `/lab/tags/{id}` | admin | any of `{ name, color, position }` | `Tag` |
| DELETE | `/lab/tags/{id}` | admin | | `{ id, deleted: true, subjects: n }` (taken off n subjects) |

Errors: 403, 404, 409 `conflict` (duplicate name).

### Subjects

#### `GET /api/v1/subjects`

Query, all optional:

| param | meaning |
|---|---|
| `stage` | stage name or id, or a comma list |
| `category` | `planned,active,completed,dropped`, comma list. `category=planned` is the Ideas filter |
| `tag` | tag name, or a comma list: subjects carrying any |
| `owner` | `me`, a user id, an email or a display name |
| `project` | a project key or id, `none`, or a comma list |
| `q` | full-text over title, conclusion and body |
| `archived` | omitted/`exclude`: live only · `include` · `only` |
| `limit` | 1–500, default 200 |

→ `SubjectSummary[]`, ordered by stage position, then `position`, then `number`.
Errors: 400 `validation_failed` naming the unknown stage, tag or project and listing the valid ones.

#### `POST /api/v1/subjects`

```json
{ "title": "Evaluate pgvector for recall",
  "body": "markdown",                      // optional
  "stage": "exploring",                    // optional, name or id; default: first planned stage
  "tags": ["search"],                      // optional, curated names
  "owner": "me",                           // optional; default the caller's human; null = nobody
  "project": "CAIRN",                      // optional, key or id; null/omitted = none
  "conclusion": "…",                       // required only when filing into completed/dropped
  "number": 12 }                           // optional, admin only (the importer)
```

→ 201 `Subject`, writes a `subject_created` event.
Errors: 400 `validation_failed` (unknown stage, tag, owner or archived/unknown project; `number`
from a non-admin is 403 `forbidden`); 400 **`conclusion_required`** `{ stage, category }`;
409 `conflict` (`number` already taken).

`cairn idea "<title>"` is this route with no stage.

#### `GET /api/v1/subjects/{ref}`

→ `Subject`. 404 `not_found`: `No subject LAB-99.`

#### `PATCH /api/v1/subjects/{ref}`

Any of, at least one:

```json
{ "title": "…", "body": "…" | null, "stage": "done", "conclusion": "…" | null,
  "tags": ["a", "b"],          // replaces the set
  "owner": "me" | null, "project": "CAIRN" | null,
  "position": 3, "archived": true | false }
```

Rules:

- **The conclusion rule.** Moving into a `completed` or `dropped` stage needs a conclusion, sent
  with the move or already on the subject; so does clearing or changing the conclusion while
  the subject sits in one. Otherwise 400 `conclusion_required`. A subject already in a
  concluding stage without one (an admin changed the stage's category later) can still have
  its title and other fields edited.
- `concluded_at` is set on the way into a concluding stage, kept while moving between
  concluding stages, and cleared on the way out. The conclusion text itself is kept when the
  subject moves back out (it is history), and can be cleared with `conclusion: null`.
- A stage move writes a `stage` log note (`exploring → done`) and a `subject_stage_changed`
  event `{ ref, title, from, to, category }` in the same transaction.
- `archived: true` sets `archived_at` (off the board, still searchable and addressable) and
  writes `subject_archived`; `false` clears it and writes `subject_restored`.
- Changing `project` does not move existing todos; new todos go to the new project.

→ `Subject`. Errors: 400 `validation_failed`, 400 `conclusion_required`, 404 `not_found`.

#### `DELETE /api/v1/subjects/{ref}?confirm=LAB-12[&todos=detach]`

See [Deleting a subject](#deleting-a-subject). Owner or admin.
→ `{ deleted: true, ref, id, todos_detached: n, files_removed: n }`.
Errors: 400 `validation_failed` (missing or wrong `confirm`); 403 `forbidden`;
409 **`subject_has_todos`** `{ todos: n, open: n }`.

#### Log: `/api/v1/subjects/{ref}/notes`

| method | body | response |
|---|---|---|
| GET | query `kind?` (comma list), `limit?` 1–500 (default 200) | `SubjectNote[]`, newest first |
| POST | `{ note, kind? = "note" }`, kind in `note·finding·decision·attempt·handoff` | 201 `SubjectNote`; a retry of the same kind and text is 200 with `duplicate: true` |

POST with `kind: "stage"` is 400 `validation_failed`.

#### People's notes: `/api/v1/subjects/{ref}/human-notes`

| method | path | who | body | response |
|---|---|---|---|---|
| GET | `…/human-notes` | anyone | | `HumanNote[]`, newest first |
| POST | `…/human-notes` | anyone | `{ body }` | 201 `HumanNote` |
| PATCH | `…/human-notes/{id}` | the author | `{ body }` | `HumanNote` |
| DELETE | `…/human-notes/{id}` | the author or an admin | | `{ id, deleted: true }` |

Errors: 403 `forbidden` (not the author), 404 `not_found` (no such note on this subject).

#### Files: `/api/v1/subjects/{ref}/attachments`

| method | path | body | response |
|---|---|---|---|
| GET | `…/attachments` | | `Attachment[]`, oldest first |
| POST | `…/attachments` | multipart, field `file` | 201 `Attachment` |
| DELETE | `…/attachments/{id}` | | `{ id, deleted: true }` |

Same limits and refusals as task attachments (400 `validation_failed` for size, type or
extension). Anyone may delete a subject's file, as anyone may a task's.

The generic file routes cover both kinds:

- `GET /api/v1/attachments/{id}`: a task's file answers as it does today; a subject's answers
  `Attachment & { subject: "LAB-12" }` (404 while the Lab is off).
- **`GET /api/v1/attachments/{id}/content`** (new): the stable address markdown embeds,
  `![shot](/api/v1/attachments/<id>/content)`. It authenticates the viewer and answers
  **302** to a freshly signed preview URL (relative `Location`, `cache-control: private,
  no-store`). Works for task and subject files. 404 `not_found` otherwise.
- `DELETE /api/v1/attachments/{id}` stays task-only; a subject's file is removed through its
  subject.

#### Todos: `/api/v1/subjects/{ref}/todos`

| method | body | response |
|---|---|---|
| GET | query `status?` (comma list) | `Todo[]`: open first, then by position and number. Includes sub-tasks of todos |
| POST | `{ title, description?, priority? = "medium", type? = "chore", status? = "todo", assignee?, parent? }` | 201 the created task (full task shape), `subject` set |

Errors: 400 `validation_failed` (the task-create rules); 409 `conflict` when the home project
must be created and its key is taken (see Todos and the home project).

#### Mentions: `GET /api/v1/subjects/{ref}/mentions`

→ `{ total, items: [{ ref, title, status, source, excerpt, at }] }`, the tasks whose text
mentions this subject, newest first (`limit?` 1–100, default 20).

### Todos and the home project

- A todo is an ordinary task with `subject_id` set. Every task verb works on it unchanged.
- **Where a new todo is filed:** the subject's project when it has one (and it is not
  archived); otherwise the instance's **Lab home project**.
- **The home project** is `lab_settings.home_project_id`. When unset, the first todo creates it
  as an ordinary project keyed **`LT`** ("Lab todos"), owned by the caller, and records it.
  If `LT` is already taken by an unrelated project, nothing is guessed: the todo is refused with
  409 `conflict` asking an admin to choose one with `PUT /lab/settings { homeProject }`.
  `LAB` cannot be the home key (it is reserved for subjects).
- Linking an existing task: `PATCH /api/v1/tasks/{ref}` with `{ "subject": "LAB-12" }`, or
  `null` to unlink. Creating a task with `{ "subject": "LAB-12" }` on
  `POST /api/v1/projects/{id}/tasks` links it in place, in that project. Each writes nothing
  else; the task stays where it is.
- A sub-task created under a todo inherits its parent's subject, unless the body names another.
- `GET /api/v1/projects/{id}/tasks` accepts `subject=LAB-12` (or `none`). Every subject's
  todos, across projects, are `GET /subjects/{ref}/todos`.

### Deleting a subject

Archiving is the normal way to retire a subject: it keeps everything and stays searchable.
Deleting is for mistakes and duplicates, and **never destroys task history**:

1. `?confirm=LAB-12` is required (the same guard as deleting a task).
2. Owner or admin only.
3. If any task, open or closed, is a todo of the subject, the delete is refused with
   **409 `subject_has_todos`** `{ todos, open }` unless the caller adds **`todos=detach`**.
   There is no option that deletes the todos. To get rid of one, delete it as a task, with that
   route's own guards.
4. With `todos=detach`, each todo keeps its project, number, status, notes, comments, files and
   events. Its `subject_id` is cleared, and a note is written on it in the same transaction:
   `Was a todo of LAB-12 (<title>), which was deleted.`
5. The subject's log, people's notes, tag links and mentions are deleted with it; its files are
   removed from storage first. A `subject_deleted` event `{ ref, title, todos_detached }`
   stays in the feed.
6. The number is not reused (the counter).
7. The `on delete set null` on `tasks.subject_id` is the floor beneath the API rule, never the
   path.

## Hand-off

A task handed to another tracker or another Cairn instance: Cal's personal Cairn, GitHub. The
tracker is data (`cairn`, `github`, `linear`…); the server never calls it. The CLI's adapters
(P2) create the task there, then record the link here.

Not a Lab feature: it works on any task, whether or not the Lab is on. When the task is a
todo, its subject's log records it.

### States

| state | columns | who owns the status |
|---|---|---|
| **none** | all `handoff_*` null | Cairn |
| **open** | tracker and ref set; `handoff_status` null or not `done`/`cancelled` | **the tracker**: status changes are refused here |
| **ended** | `handoff_status` is `done` or `cancelled` | Cairn again; the task was closed with the outcome |

Shapes: `handoff_tracker` matches `^[a-z][a-z0-9-]{1,31}$`; `handoff_ref` 1–200 characters with
no whitespace; `handoff_url` http(s) or null; tracker and ref are both set or both null.

### `POST /api/v1/tasks/{ref}/handoff`: link, re-link or sync

```json
{ "tracker": "cairn", "ref": "KDP-41", "url": "https://…",     // url optional
  "status": "doing",                       // optional: what the tracker says now
  "resolution": "…", "resolutionKind": "fixed" }   // with a done/cancelled status
```

- **Link** (no link yet) or **re-link** (a different tracker or ref): writes the columns and
  `handoff_synced_at = now()`, releases any claim (a `doing` task goes back to `todo`), writes a
  `handed_off` event and, for a todo, a `handoff` log note
  `LT-41 handed off to cairn as KDP-41`.
- **Sync** (same tracker and ref): records `status` (and `url` if sent) and `synced_at`. This is
  how `cairn sync` records what the other side said. Nothing else is written unless the status
  ends it.
- **Ending:** a `done` or `cancelled` status closes the task once, with that status,
  `resolution: "Closed in cairn as KDP-41: <their resolution>"` and `resolution_kind` (theirs
  if it is one of Cairn's kinds, else `verified`). For a todo the subject's log gets
  `KDP-41 done: <resolution>` (a finding for done, a note for cancelled), deduplicated on
  tracker, ref and status, so syncing again adds nothing. A task already closed is left as it is.
- The task's project must not be archived (409, as other task writes).

→ `{ ref, id, subject: "LAB-12" | null, handoff: Handoff, status, noted: boolean, closed: boolean }`.
Errors: 400 `validation_failed`; 404 `not_found`; 409 `conflict` (archived project).

### `DELETE /api/v1/tasks/{ref}/handoff`: take it back

Clears the link. Nothing is done in the other tracker. Writes `handoff_taken_back` and, for a
todo, `LT-41 taken back from cairn (KDP-41)`. → the task. 409 `conflict` when it is not
handed off.

### `GET /api/v1/handoffs`

What `cairn sync` walks: `?state=open|ended|all` (default `open`), `tracker?`, `project?`.
→ `[{ ref, title, status, subject: "LAB-12" | null, handoff: Handoff }]`.

### 409 `handed_off`

While the hand-off is **open**, these are refused with **409 `handed_off`**
`{ tracker, handoffRef, url }` and a message that names where the task lives now and how to
take it back:

- `POST /tasks/{ref}/claim`, and an implicit claim by `POST /tasks/{ref}/checkpoint`;
- `POST /tasks/{ref}/release`;
- `PATCH /tasks/{ref}` with `status`, `resolution` or `resolutionKind` (closing, cancelling,
  reopening, any status move). Title, description, priority, labels, assignee, subject and the
  other fields stay editable; notes and comments are always allowed.

The one path that closes an open hand-off's task is the ending sync above. Once ended, the task
is an ordinary closed task and can be reopened as usual.

### Project defaults

`PATCH /api/v1/projects/{id}` accepts `{ "handoffTracker": "github", "handoffTarget":
"montytorr/kdp" }` (both or neither; `null` clears both). Project responses carry
`handoff_tracker` and `handoff_target`. The target matches `^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`.
The CLI uses them when `cairn handoff` is given no `--to`.

## Search

- `search_all` gains a `subject` kind. Title and conclusion are weight A, body weight B. The row:
  `kind: "subject"`, `ref: "LAB-12"`, `title`, `subtitle` (the conclusion's first 120 characters),
  `project_key` (the subject's project, or null), `status` (the stage name), `type: "subject"`,
  `answered` (has a conclusion).
- A project-scoped search includes subjects of that project.
- `GET /api/v1/search?q=LAB-12` resolves the subject directly and puts it first.
- `kinds=subject` filters to subjects; the default (all kinds) includes them.
- None of this happens while the Lab is off.

## Live updates and activity

- `cairn_pulse` (the SSE fingerprint) also moves on any change to subjects, the log, people's
  notes, files, tags on subjects, stages, tags and the Lab settings. Project-scoped pulses stay
  tasks-only, as before; Lab pages subscribe unscoped.
- The activity feed (`GET /api/v1/activity`) gains, while the Lab is on:
  - the subject events above, as `kind: "event"` rows with `ref: "LAB-12"`, the subject's title
    and `detail` the event name (a stage move's detail is `exploring → done`);
  - log notes, as `kind: "note"` rows with `ref: "LAB-12"`.
  - A project filter matches subjects of that project. Subjects are never the activity of a
    `kinds` filter that names only task kinds.

## The briefing

`buildContext` (`GET /api/v1/context`) gains `lab` when the Lab is on, and omits it when off:

```ts
lab?: {
  stages: Array<Stage & { count: number }>   // live (not archived) subjects per stage, every stage, by position
  mine: SubjectSummary[]                      // ≤ 3: live subjects the caller's human owns in an
                                              // active or planned stage, active first, then most recently updated
}
```

## Mentions and links

- The markdown linkifier (`remarkTaskRefs`) takes `{ keys, lab }`. With `lab: true`, `LAB-12`
  becomes a link to `/lab/subjects/12` carrying `data-subject-ref="LAB-12"`. Task refs are
  unchanged.
- `task_mentions_refresh` also records `LAB-n` in task text into `subject_mentions`
  (`GET /subjects/{ref}/mentions`). Subject text mentioning tasks is not indexed in this
  release.

## Error codes added

| code | status | when |
|---|---|---|
| `lab_disabled` | 404 | any Lab route while the Lab is off |
| `conclusion_required` | 400 | entering or staying in a completed/dropped stage without a conclusion |
| `stage_in_use` | 409 | deleting a stage that holds subjects |
| `subject_has_todos` | 409 | deleting a subject with todos, without `todos=detach` |
| `handed_off` | 409 | a status change on a task whose hand-off is open |

## Migrations

| file | what |
|---|---|
| `071_lab_core.sql` | `lab_settings`, stages (seeded), tags, subjects, the number counter, `subject_tags`, the log, people's notes, files, `tasks.subject_id`, the `LAB` reservation, `task_activity_events.subject_id` and the event list |
| `072_handoff.sql` | `tasks.handoff_*`, `projects.handoff_*`, checks and index |
| `073_lab_search.sql` | `search_all` transformed in place (055's transform-and-assert) |
| `074_lab_pulse_activity.sql` | `cairn_pulse` redefined; `activity_feed` transformed in place |
| `075_subject_mentions.sql` | `subject_mentions` and `task_mentions_refresh` |

Each is idempotent: `if not exists`, guarded constraint adds, and a marker check before every
function transform.
