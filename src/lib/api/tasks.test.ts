import { describe, expect, it } from 'vitest'
import { TASK_FIELDS, TASK_LIST_FIELDS } from './tasks'

/**
 * The owner filter in findTask reaches through the embedded `projects`
 * relation. PostgREST needs that relation in the select or the query matches
 * nothing AND returns no error — indistinguishable from "no such task".
 *
 * This shipped: three callers passed a narrow field list, and sub-task
 * creation, re-parenting and the duplicate pointer all reported the target
 * task as missing. findTask now appends the join, so the guarantee that
 * matters is that the two shared field lists still carry it.
 */
describe('task field lists', () => {
  it.each([
    ['TASK_FIELDS', TASK_FIELDS],
    ['TASK_LIST_FIELDS', TASK_LIST_FIELDS],
  ])('%s embeds projects with an inner join', (_name, fields) => {
    expect(fields).toContain('projects!inner')
  })

  it.each([
    ['TASK_FIELDS', TASK_FIELDS],
    ['TASK_LIST_FIELDS', TASK_LIST_FIELDS],
  ])('%s selects the columns the owner scope needs', (_name, fields) => {
    expect(fields).toMatch(/projects!inner\([^)]*owner_user_id/)
  })

  // Columns added by later migrations that the API reads back.
  it.each(['duplicate_of', 'parent_id', 'resolution', 'resolution_kind'])(
    'TASK_FIELDS selects %s',
    (column) => {
      expect(TASK_FIELDS).toContain(column)
    },
  )
})
