import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { refuseUnreadableBody } from './task-body'

const WALL = 'WHY EMPTY TODAY: call.controller.search returns nothing for CS users.'
const agent = { actorType: 'agent' as const }
const human = { actorType: 'human' as const }

describe('refuseUnreadableBody (CAIRN-312)', () => {
  it('refuses an agent\'s unreadable body with every problem, in the field and in the message', async () => {
    const refused = refuseUnreadableBody(agent, WALL, 'cairn update ACME-42 --body -')
    expect(refused?.status).toBe(400)
    const payload = await refused!.json()
    expect(payload.code).toBe('validation_failed')
    expect(payload.field).toBe('description')
    expect(payload.problems).toEqual([
      '"WHY EMPTY TODAY:" is a label shouted in capitals — make it a heading on its own line: "## Why empty today".',
      'Wrap `call.controller.search` in backticks — it is code.',
    ])
    // A client that prints only `error` still gets the remedy and the list.
    expect(payload.error).toContain('`cairn update ACME-42 --body -` reads the body from stdin')
    for (const problem of payload.problems) expect(payload.error).toContain(`  - ${problem}`)
  })

  it('lets a readable agent body through', () => {
    expect(refuseUnreadableBody(agent, '## Why\n\n`call.controller.search` returns nothing.', 'x')).toBeNull()
  })

  it('never blocks a person typing in the board', () => {
    expect(refuseUnreadableBody(human, WALL, 'x')).toBeNull()
  })

  it('has nothing to say about an absent or cleared body', () => {
    expect(refuseUnreadableBody(agent, undefined, 'x')).toBeNull()
    expect(refuseUnreadableBody(agent, null, 'x')).toBeNull()
  })

  it.each([
    // Every create — a project's task and a Lab subject's todo — goes through task-create.ts.
    ['create', 'src/lib/api/task-create.ts'],
    ['update', 'src/app/api/v1/tasks/[ref]/route.ts'],
  ])('is applied where a task body is written: %s', (_verb, file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    expect(source).toMatch(/const unreadable = refuseUnreadableBody\(actor, body\.description,/)
    expect(source).toMatch(/if \(unreadable\) return (unreadable|\{ ok: false, response: unreadable \})/)
  })

  it('files every new task through task-create.ts', () => {
    for (const file of ['src/app/api/v1/projects/[id]/tasks/route.ts', 'src/app/api/v1/subjects/[ref]/todos/route.ts']) {
      expect(readFileSync(join(process.cwd(), file), 'utf8')).toContain('createTaskInProject(')
    }
  })
})
