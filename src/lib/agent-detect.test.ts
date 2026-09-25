import { describe, expect, it } from 'vitest'

/**
 * Which runtime is this, and therefore whose key signs the write.
 *
 * A live Codex session was found running as `node /usr/bin/codex --yolo` with
 * no CODEX_HOME — the wrapper installed to set it had simply been bypassed —
 * so detection returned nothing, the CLI fell back to the machine's default
 * key, and every Codex write on that host was filed as OpenClaw. The
 * statistics looked healthy; they were about the wrong agent.
 *
 * The ordering is the part that must not regress: OpenClaw runs Codex
 * underneath, so every Codex marker is also set inside OpenClaw. Testing for
 * Codex first would relabel all of OpenClaw's work as Codex — the same
 * misattribution, pointing the other way.
 */
const detect = (env: Record<string, string | undefined>) => {
  if (env.CAIRN_AGENT) return env.CAIRN_AGENT.trim().toLowerCase()
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code'
  const codexHome = env.CODEX_HOME ?? ''
  if (/openclaw/i.test(codexHome)) return 'openclaw'
  if (Object.keys(env).some((name) => name.startsWith('OPENCLAW_'))) return 'openclaw'
  if (codexHome || env.CODEX_SANDBOX) return 'codex'
  if (env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM || env.CODEX_MANAGED_PACKAGE_ROOT) return 'codex'
  return ''
}

describe('detecting the runtime', () => {
  it('recognises Codex launched directly, with no CODEX_HOME', () => {
    // The real environment of the session that exposed this: PATH, and these.
    expect(detect({ CODEX_MANAGED_BY_NPM: '1' })).toBe('codex')
    expect(detect({ CODEX_MANAGED_PACKAGE_ROOT: '/usr/lib/node_modules/@openai/codex' })).toBe('codex')
  })

  it('still calls OpenClaw OpenClaw, even though it sets every Codex marker', () => {
    expect(
      detect({
        CODEX_HOME: '/root/.openclaw/agents/main/agent/codex-home',
        CODEX_MANAGED_BY_NPM: '1',
      }),
    ).toBe('openclaw')
    expect(detect({ OPENCLAW_SESSION: 'x', CODEX_MANAGED_BY_NPM: '1' })).toBe('openclaw')
    // The variables the live gateway actually sets. None of them is
    // OPENCLAW_SESSION or OPENCLAW_HOME, which were the only two checked — so
    // OpenClaw's whole identity rested on CODEX_HOME containing the word, and
    // losing that would have filed all of its work as Codex.
    expect(
      detect({ OPENCLAW_SERVICE_MARKER: 'openclaw', CODEX_MANAGED_BY_NPM: '1' }),
    ).toBe('openclaw')
    expect(
      detect({ OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service', CODEX_MANAGED_BY_NPM: '1' }),
    ).toBe('openclaw')
  })

  it('recognises Codex through the wrapper, which is the path that already worked', () => {
    expect(detect({ CODEX_HOME: '/opt/codex-home' })).toBe('codex')
  })

  it('lets an explicit CAIRN_AGENT win over everything', () => {
    expect(detect({ CAIRN_AGENT: 'maintenance', CODEX_MANAGED_BY_NPM: '1' })).toBe('maintenance')
  })

  it('still knows Claude Code', () => {
    expect(detect({ CLAUDECODE: '1' })).toBe('claude-code')
  })

  it('admits when it cannot tell, rather than guessing', () => {
    expect(detect({})).toBe('')
  })
})
