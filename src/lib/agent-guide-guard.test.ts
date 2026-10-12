import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * AGENTS.md is hand-written, read by every agent at session start, and held
 * under 8KB by CI because a guide nobody can afford to read is not a guide.
 * The cap is a cost budget, not a runtime limit (Codex's is 32 KiB in total):
 * the detail lives in the skill's reference.md, read on demand.
 *
 * `next dev` appends a 679-byte block to it on every start. Committing that is
 * the path of least resistance — the block argues for itself, in the file — and
 * the cost lands later, on an unrelated pull request, as a byte budget blown
 * for a reason that appears nowhere in its diff. `agentRules: false` is the
 * only switch; there is no environment variable.
 *
 * Two things can quietly undo this, so both are pinned: the setting going
 * missing, and an upgrade changing the mechanism it depends on.
 */
describe('the agent guide stays ours to write', () => {
  it('turns off Next.js agent-rules generation', () => {
    const config = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf8')
    expect(config).toMatch(/agentRules:\s*false/)
  })

  it('leaves room to say more, with the generated block accounted for', () => {
    // CI enforces the 8192 limit; this is the earlier warning. It sits at 6000
    // so growth past the trimmed guide is a conscious decision, not the next
    // sentence that happens to fit.
    const bytes = readFileSync(join(process.cwd(), 'AGENTS.md')).byteLength
    expect(bytes).toBeLessThanOrEqual(8192)
    expect(bytes, 'AGENTS.md is past 6000 bytes: move detail to skills/cairn/reference.md').toBeLessThan(6000)
  })

  it('still depends on the upstream switch it thinks it does', () => {
    // A tripwire on somebody else's code. If an upgrade renames or drops the
    // gate, generation resumes silently and the first symptom is a byte budget
    // failing on an unrelated change — which is how this was found.
    const gate = join(process.cwd(), 'node_modules/next/dist/server/lib/start-server.js')
    if (!existsSync(gate)) return // dependency not installed; CI installs it
    expect(readFileSync(gate, 'utf8')).toContain('agentRules !== false')
  })
})
