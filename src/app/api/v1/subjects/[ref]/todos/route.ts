import type { z } from 'zod'
import { route } from '@/lib/api/handler'
import { failValidation, ok } from '@/lib/api/response'
import { subjectForRoute } from '@/lib/api/lab-route'
import { createSubjectTodoSchema, listTodosQuery } from '@/lib/api/lab-schemas'
import { withAssignees } from '@/lib/api/people'
import { createTaskInProject } from '@/lib/api/task-create'
import { listSubjectTodos, todoProjectFor } from '@/lib/api/subjects'
import { createTaskSchema } from '@/schemas/task'

export const dynamic = 'force-dynamic'

/** The subject's todos and their sub-tasks, open first. */
export const GET = route<{ ref: string }>({
  handler: async ({ params, url }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const parsed = listTodosQuery.safeParse(Object.fromEntries(url.searchParams))
    if (!parsed.success) return failValidation(parsed.error.issues)
    const statuses = parsed.data.status?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
    return ok(await withAssignees(await listSubjectTodos(found.subject.id, statuses)))
  },
})

/**
 * Files a todo: an ordinary task, in the subject's project or the Lab home
 * project, through the path every task takes.
 */
export const POST = route<{ ref: string }, z.infer<typeof createSubjectTodoSchema>>({
  schema: createSubjectTodoSchema,
  secretFields: ['title', 'description'],
  handler: async ({ actor, params, body }) => {
    const found = await subjectForRoute(params.ref)
    if ('response' in found) return found.response
    const { subject } = found

    const task = createTaskSchema.safeParse({
      title: body.title,
      description: body.description,
      priority: body.priority,
      type: body.type,
      status: body.status,
      assignee: body.assignee,
      parentRef: body.parent,
    })
    if (!task.success) return failValidation(task.error.issues)

    const project = await todoProjectFor(actor, subject)
    if (!project.ok) return project.response

    const created = await createTaskInProject(actor, project.value, task.data, {
      subjectId: subject.id,
      retry: `cairn subject todo ${subject.ref} "<title>" --body -`,
    })
    if (!created.ok) return created.response
    const [todo] = await withAssignees([created.task])
    return ok(todo, { status: 201 })
  },
})
