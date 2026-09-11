import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openapiSpec } from './openapi'
import { TASK_STATUSES, TASK_TYPES } from '@/schemas/task'

/**
 * The point of generating the spec from the Zod schemas is that it cannot
 * drift. These tests assert that the generation actually happened, rather
 * than that someone remembered to update a literal.
 */
describe('openapi spec', () => {
  const spec = openapiSpec()

  it('is OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('Cairn API')
  })

  it('documents every route group the CLI depends on', () => {
    const paths = Object.keys(spec.paths)
    for (const p of [
      '/search', '/projects', '/projects/{id}/tasks', '/tasks/{ref}',
      '/tasks/{ref}/claim', '/tasks/{ref}/beat', '/tasks/{ref}/checkpoint',
      '/tasks/{ref}/release', '/tasks/{ref}/notes', '/tasks/{ref}/comments',
      '/tasks/{ref}/attachments', '/attachments/{id}', '/keys',
      '/tasks/{ref}/dependencies', '/projects/{id}', '/tasks/{ref}/activity', '/tasks/{ref}/children', '/labels',
    ]) {
      expect(paths).toContain(p)
    }
  })

  it('derives the create-task body from the Zod schema', () => {
    const schema = spec.paths['/projects/{id}/tasks'].post.requestBody.content[
      'application/json'
    ].schema as { properties: Record<string, { enum?: string[] }>; required: string[] }

    // If these fall out of step with schemas/task.ts, the generation broke.
    expect(schema.properties.type?.enum).toEqual([...TASK_TYPES])
    expect(schema.properties.status?.enum).toEqual([...TASK_STATUSES])
    expect(schema.required).toContain('title')
  })

  it('does not mark PATCH fields as required', () => {
    const schema = spec.paths['/tasks/{ref}'].patch.requestBody.content[
      'application/json'
    ].schema as { required?: string[] }
    expect(schema.required ?? []).toEqual([])
  })

  // The shared route wrapper does not parse DELETE bodies, so a documented
  // DELETE requestBody is a promise the API cannot keep. It shipped once.
  it('never documents a request body on DELETE', () => {
    for (const [path, methods] of Object.entries(spec.paths)) {
      const del = (methods as Record<string, { requestBody?: unknown }>).delete
      if (del) expect(del.requestBody, `${path} DELETE`).toBeUndefined()
    }
  })

  it('declares bearer auth and applies it by default', () => {
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
    expect(spec.security).toEqual([{ bearerAuth: [] }])
  })

  it('leaves the health probe unauthenticated', () => {
    expect(spec.paths['/health'].get.security).toEqual([])
  })

  it('documents suggestedResolution on the failure envelope', () => {
    const err = spec.paths['/tasks/{ref}'].patch.responses['400'].content['application/json']
      .schema as { properties: Record<string, unknown> }
    expect(err.properties).toHaveProperty('suggestedResolution')
  })

  /**
   * The hand-written list below it says which routes matter. THIS says the
   * spec covers all of them — which is the check that was missing when five
   * routes (knowledge, sessions, context, entities, reconcile) shipped and
   * /api-docs kept describing the surface without them.
   */
  it('documents every route that exists on disk', () => {
    const root = join(process.cwd(), 'src/app/api/v1')

    const walk = (dir: string, prefix = ''): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
          const segment = entry.name.startsWith('[')
            ? `{${entry.name.slice(1, -1)}}`
            : entry.name
          return walk(join(dir, entry.name), `${prefix}/${segment}`)
        }
        return entry.name === 'route.ts' && prefix ? [prefix] : []
      })

    // openapi.json documents the spec itself; there is nothing to say about it.
    const routes = walk(root).filter((r) => r !== '/openapi.json')
    const documented = new Set(Object.keys(spec.paths))

    expect(routes.filter((r) => !documented.has(r))).toEqual([])
  })
})
