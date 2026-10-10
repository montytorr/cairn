# Importing Croft into a Lab instance

Croft was the lab product: a fork of Cairn 0.12.1 that held subjects (`S-12`), their log and
todos (`T-41`). Its lab now lives in Cairn (see [lab.md](lab.md)), and
`scripts/import-croft.mjs` moves a Croft database into a Cairn database that has the Lab.

It reads Croft, writes the target in **one transaction**, and keeps the original authors,
actors, timestamps and numbers. It is dry-run by default: a dry run is the whole import,
checked against the target's real constraints and triggers, then rolled back.

## What comes across

| Croft | Cairn | Notes |
|---|---|---|
| `app_users`, `user_profiles` | same | Matched by email. A new user keeps their id, password hash, role, ban and deactivation. A user already in the target is reused as it is (their password and role stay); their work is attributed to them. |
| `api_keys`, `app_sessions`, reset tokens, pairing requests | not copied | People pair their agents again and sign in again. |
| `subject_stages` | `lab_stages` | Matched by name, whatever the case. The seeded nine are reconciled (category, colour and position follow Croft); a stage only Croft has is added; one only the target has is kept and reported. |
| `tags` | `lab_tags` | Matched by name; new ones keep colour and position. |
| `lab_projects` | `projects` | One Cairn project each, with `handoff_tracker` and `handoff_target` kept. The key is the hand-off target when the tracker is `cairn` (`TRIG`, `CROFT`); anything else needs `--project-key`. Archived lab projects become archived projects. |
| `subjects` | `subjects` | `S-n` becomes `LAB-n` with the same number. Every field, archived subjects included. The counter ends past the highest number Croft ever handed out, deleted ones included. |
| `subject_tags` | `subject_tags` | |
| `subject_notes` | `subject_notes` | Kinds carry over; Croft's `visibility` becomes `note`. Content hashes are kept. |
| `subject_human_notes` | `subject_human_notes` | Author, actor and both times kept. |
| `subject_attachments` | `subject_attachments` | The bytes are copied between stores (see [Attachments](#attachments)). The path moves under `lab/subjects/`. |
| `subject_members`, subject `visibility` | not copied | The Lab has no row-level visibility. A subject that is not `lab`-visible stops the import (see below). |
| `tasks` in project `T` | `tasks` | See below. |
| `task_notes`, `task_comments`, `task_attachments` | same | Kept with their authors and times. |
| `task_activity_events` | same | Kept, with the subject. An event the target does not know is skipped and reported. The event of a deleted todo keeps its place in the feed. |

### Todos

Each todo becomes a task in **its subject's project**, or in the Lab home project (`LT`,
"Lab todos") when its subject has no project, or no subject. They are numbered from 1 in each
project, in Croft's order, so `T-13` may become `TRIG-1`. The mapping file records every one.

- Kept: title, description, type, status, priority, labels, due date, position, author, actor,
  assignee, resolution (kind, time, who), checkpoint, blocked state, sub-task parent,
  duplicate-of, timestamps.
- Cleared: claims (`claimed_by`, `claimed_at`, heartbeat, session). A `doing` todo whose claim
  is cleared goes back to `todo`, unless a hand-off is open: then the tracker owns its status
  and it stays as it was.
- `external_ref` is set to `croft:<croft-host>/T-n`. A reference it replaces is kept in a note
  on the todo.
- Hand-off (`tracker`, `ref`, `status`, `synced_at`, `url`) comes across. A `cairn` link with no
  URL is given `<--cairn-url>/projects/<KEY>/tasks/<n>` from its ref, because a cairn hand-off
  must name its instance.
- `S-n` and `T-n` written in prose are not changed unless you pass `--rewrite-refs`
  ([below](#rewriting-refs-in-prose)).

## Before you start

1. **A fresh target.** A Cairn instance, migrated to the Lab (`npm run db:migrate`, migrations
   071 and up), holding **no subjects**. The importer refuses anything else. See
   [Accounts and passwords](#accounts-and-passwords) for who may already exist on it.
2. **Croft at migration 081.** The importer says which table or column is missing if not.
3. **A database user that owns the target's tables**, which is the user the migrations ran as.
   The importer disables the touch triggers on `subjects` and `tasks` for one statement each, to
   put back their original `updated_at`.
4. **No traffic.** Do the import before the instance takes requests. It takes the migration
   lock, but nothing stops a user creating a subject or a task while it runs, and a number they
   take first fails the import.
5. **Backups.** Of Croft (it is only read, but it is the only copy of a retired product) and of
   the target if it holds anything you care about. Rolling back an applied import means
   restoring the target.
6. **Connection strings** for both. They are arguments and nothing else: the script has no
   idea where production is.

## Before the real run

The real run is Cal's decision and happens once. In this order:

1. **Take a fresh backup of Croft** (`croft-backup` on clawdius) and check that the file exists
   and restores. The importer only reads Croft, but it is the only copy of a retired product.
2. **Put Croft in read-only mode, or stop its writes, for the duration.** A subject or todo
   made after the dump would be left behind, and a number taken after the dry run would not be
   in its mapping.
3. **Dry run against a restored copy of the real dump first** (see [Rehearsing](#rehearsing)),
   not against the live database. Read the report, settle the decisions in
   [step 2](#2-decide), and **paste the report to Cal** before anything is applied.
4. Run the apply with the same options the rehearsal used, against the real target, with
   `--mapping-file`. Keep the mapping file: it is the only record of `T-n` to new ref.
5. **After the apply, the personal-Cairn `external_ref` rewrite is a separate step**, run from
   the mapping file, and approved by Cal on its own. This importer does not do it, and nothing
   here changes a personal Cairn.

## Accounts and passwords

A person's account arrives with the password hash it has in Croft, so they sign in with the
password they already use. Their role is the one they had (`admin` or `member`), and a ban or a
deactivation stays. **Agent keys are not copied**: every agent is paired again
(`cairn setup`), and sessions are not copied, so people sign in again.

Users are matched **by email**, and a user the target already has is never changed:

- **On a fresh instance, run the import before anyone else signs up.** Then every account is
  created by the import and Croft's hashes carry over.
- **If a bootstrap admin must exist first** (the instance needs one to start, or
  `npm run operator:create` was run), create it with **the same email Cal uses in Croft**. The
  import then attributes Cal's subjects, notes and todos to that account, and keeps that
  account's *new* password and role: expect Cal to sign in with the bootstrap password, not the
  Croft one. Nothing from Croft's account (hash, role, profile) overwrites it.
- A bootstrap account under a different email is left alone, and Cal's Croft account arrives as
  a second user beside it.

The report lists each user as `insert` (arrives from Croft) or `reuse` (already there).

## Steps

### 1. Dry run

```bash
node scripts/import-croft.mjs \
  --croft  'postgresql://…/croft' \
  --target 'postgresql://…/cairn' \
  --mapping-file ./croft-mapping.json
```

It prints the report and exits `0` when an `--apply` would succeed, `1` when blocked. Nothing
is written to either database. Read:

- **Blocked** lists what must change before an apply.
- **Rows per table**: source, written, reused, updated, skipped. `subjects` should be
  Croft's subject count; `tasks` its todo count.
- **Users**: who is new and who was already there.
- **Projects created**, with their keys and where each todo goes.
- **Subjects**: the highest number, the counter it ends at, and the numbers that were never
  used or were deleted.
- **Todos**: statuses, hand-offs, claims cleared.
- **Refs in prose**: the counts and the sample of ten rewrites described below.
- **Not carried across, or changed on the way.**
- **Checked against the target (rolled back)**: counts, numbers, times and counters, checked
  after the write.

`--json` prints the report as JSON; `--report-file` writes it.

### 2. Decide

| If the report says… | Do |
|---|---|
| a lab project has no Cairn key | `--project-key "Trig=TRG"` (repeatable) |
| a key is taken in the target | `--project-key "<name>=<other>"`, or `--home-key` for the home project |
| private or members-only subjects | Look at them in Croft first. The Lab shows every subject to every user. `--allow-private` imports them as visible to all. |
| prose still names `S-n` and `T-n` | `--rewrite-refs`: they become `LAB-n` and the new todo ref, so they link and show up under "Mentioned in" (see below). Without it the text is exactly as written. |
| projects owned by the wrong person | `--owner someone@example.com` (default: Croft's first active admin) |
| attachments | give both stores (below) |

### 3. Apply

The same command with `--apply`:

```bash
node scripts/import-croft.mjs --croft … --target … --apply \
  --mapping-file ./croft-mapping.json --rewrite-refs
```

The mapping file is written only after the commit, and the importer refuses to overwrite a
file that is there. If the import fails, the target is as it was and so are the files it
had copied.

### 4. After

- Open the Lab, check a subject and a todo.
- People sign in with their Croft passwords. Agents pair again (`cairn setup`).
- The lab is switched on by the import. `--no-enable-lab` leaves it off; turn it on with
  `PUT /api/v1/lab/settings`.
- The mapping file is the input to the later step that rewrites the personal-Cairn tasks whose
  `external_ref` points at Croft. This importer does not do that step.

## Rewriting refs in prose

`--rewrite-refs` changes `S-12` and `T-41` written in subject titles, bodies and conclusions,
log notes, people's notes, and todo titles, descriptions, resolutions, notes and comments. It is
timid on purpose:

- only a ref **in the mapping** is rewritten (a deleted `S-15` or a `T-999` is left as written
  and listed), and only as a whole token: `T-shirts`, `TLS-1`, `S-120` and `S-12.md` are not refs;
- **never** inside inline code, a fenced block or an indented code block;
- **never** inside a URL, a markdown link target or reference definition, an autolink or an HTML
  tag, nor right after `/`, `#`, `@`, `=`, `?`, `&`, `:` or `.` (a path, an anchor, a query, a file name). The text of a link
  (`[S-12](https://…)`) is prose and is rewritten; its target is not.

Dry run and apply print the same table: per table, how many refs are rewritten, how many were
left in code or links, and how many name nothing in the mapping, then **ten rewrites spread
across the tables** with the text before and after, so they can be read by eye. Without the flag
the report shows the same table as "would rewrite" and the text is untouched.

## The mapping file

```json
{
  "applied": true,
  "source_host": "croft.montytorr.com",
  "generated_at": "2026-10-10T20:00:00.000Z",
  "subjects": { "S-1": "LAB-1", "S-2": "LAB-2" },
  "todos": { "T-1": "LT-1", "T-13": "TRIG-1" },
  "external_refs": { "croft:croft.montytorr.com/T-13": "TRIG-1" }
}
```

A deleted subject (`S-15`) has no entry. A dry run writes the same file with `"applied": false`.

## Attachments

Croft's attachment store and the target's are separate, so the files are copied:

| | directory | S3 |
|---|---|---|
| Croft | `--croft-files-dir <dir>` | `--croft-files-s3-bucket <bucket> [--croft-files-s3-prefix <p>]` |
| target | `--target-files-dir <dir>` | `--target-files-s3-bucket <bucket> [--target-files-s3-prefix <p>]` |

S3 takes its region and credentials from the environment (`AWS_REGION`, the SDK's default
chain). **The S3 path has not been run**: it is a thin mirror of the app's own store code and
the directory path is what the tests cover, which is acceptable because the real Croft has no
attachments. Rehearse an S3 copy before trusting it with files. The dry run reads every file and checks it against its row (size and `sha256`), so a
missing or damaged file is found before anything is written. An apply copies each file without
replacing one that is there, and removes what it copied, and any directory it made, if the
transaction later fails. With no
attachments neither store is needed.

## It refuses when

- the target already holds a subject;
- the target has no Lab tables, or lacks a column the importer writes (run the migrations);
- Croft is not at 081, or is not a Croft database;
- both connection strings name one database;
- a subject is not `lab`-visible and `--allow-private` is not given;
- a lab project has no key, or its key is `LAB`, taken, or retired in the target;
- a `cairn` hand-off has no URL and a ref that is not `KEY-n`, or has an `http` URL;
- the mapping file exists;
- the target refuses a row (the report names the constraint).

## What it does to the target's triggers

Subjects are inserted with their Croft numbers, and `subjects_assign_number` moves the counter
to follow. Because each child insert touches its subject (and each note touches its task),
the importer puts the original `updated_at` back as its last step, with the touch trigger
disabled for that statement and enabled again straight after. A Croft counter higher than
every surviving subject (the last subjects were deleted) raises the target's counter to match.

## Rehearsing

Rehearse on a throwaway database built from a restore of Croft's nightly dump, never on the
live one:

```bash
createdb croft_rehearsal && pg_restore -d croft_rehearsal croft.dump
createdb cairn_rehearsal && DATABASE_URL=postgresql://…/cairn_rehearsal npm run db:migrate
node scripts/import-croft.mjs --croft postgresql://…/croft_rehearsal --target postgresql://…/cairn_rehearsal
```

The integration test (`tests/integration/croft-import.test.ts`) does the same from a vendored
Croft schema and a fixture shaped like the real database; `npm run test:integration` runs it.
