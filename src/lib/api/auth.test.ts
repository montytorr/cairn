import { describe, expect, it } from 'vitest'

/**
 * Regression guard for a bug that made a whole feature inert.
 *
 * `last_used_at` never updated because the code was `void <query builder>`.
 * A builder is a lazy thenable: nothing is sent until something subscribes,
 * so `void` type-checks, reads as fire-and-forget, and does nothing at all.
 * This asserts the shape of the mistake so it cannot come back unnoticed.
 */
describe('lazy thenables', () => {
  const makeLazyBuilder = () => {
    let ran = false
    const builder = {
      get ran() {
        return ran
      },
      then(resolve?: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        ran = true
        return Promise.resolve({ error: null }).then(resolve, reject)
      },
    }
    return builder
  }

  it('void does NOT execute a lazy thenable', () => {
    const builder = makeLazyBuilder()
    void builder
    expect(builder.ran).toBe(false)
  })

  it('.then() does execute it', async () => {
    const builder = makeLazyBuilder()
    await builder.then(
      () => undefined,
      () => undefined,
    )
    expect(builder.ran).toBe(true)
  })
})
