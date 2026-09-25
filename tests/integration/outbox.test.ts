import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const cli = join(process.cwd(), 'cli', 'cairn.mjs')

const run = (
  home: string,
  base: string,
  args: string[],
  key = 'crn_integration_key',
  extraEnv: Record<string, string> = {},
) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        HOME: home,
        CAIRN_AGENT: 'integration-agent',
        CAIRN_API_KEY: key,
        CAIRN_BASE_URL: base,
        CAIRN_DEADLINE_MS: '1',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })

describe('durable CLI outbox', () => {
  let home: string
  let server: Server
  let base: string
  let mode: 'fail' | 'success' = 'fail'
  const received: { id: string | undefined; body: string }[] = []
  const attempts: string[] = []
  const seen = new Map<string, number>()

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cairn-outbox-'))
    received.length = 0
    attempts.length = 0
    seen.clear()
    mode = 'fail'
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        if (mode === 'fail') {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: false, error: 'offline' }))
          return
        }
        const id = req.headers['idempotency-key'] as string | undefined
        attempts.push(id ?? '')
        if (id && seen.has(id)) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ success: true, data: { id: seen.get(id) } }))
          return
        }
        received.push({ id, body })
        if (id) seen.set(id, received.length)
        res.writeHead(200, { 'content-type': 'application/json' })
        let requestBody: Record<string, unknown> = {}
        try { requestBody = JSON.parse(body) } catch { /* non-JSON endpoints */ }
        res.end(JSON.stringify({
          success: true,
          data: {
            id: received.length,
            ownership_version: requestBody.ownershipVersion,
            checkpoint_version: typeof requestBody.checkpointVersion === 'number'
              ? requestBody.checkpointVersion + 1
              : undefined,
          },
        }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  })

  it('preserves concurrent appends and replays each mutation with a stable unique key', async () => {
    const queued = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        run(home, base, ['comment', 'CAIRN-163', `queued-${index}`]),
      ),
    )
    expect(queued.every((result) => result.code === 0 && result.stderr.includes('queued locally'))).toBe(true)

    const lines = (await readFile(join(home, '.cairn', 'outbox.jsonl'), 'utf8')).trim().split('\n')
    const records = lines.map((line) => JSON.parse(line))
    expect(records).toHaveLength(12)
    expect(new Set(records.map((record) => record.id)).size).toBe(12)
    expect(records.every((record) => record.base === base && record.agent === 'integration-agent')).toBe(true)

    mode = 'success'
    const replay = await run(home, base, ['replay'])
    expect(replay.code).toBe(0)
    expect(replay.stdout).toContain('sent 12, rejected 0, still queued 0')
    expect(received).toHaveLength(12)
    expect(new Set(received.map((request) => request.id)).size).toBe(12)
  })

  it('quarantines records when the runtime key identity changes', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'bound to old key'], 'crn_key_a')
    mode = 'success'
    const replay = await run(home, base, ['replay'], 'crn_key_b')
    expect(replay.stdout).toContain('sent 0, rejected 1, still queued 0')
    expect(received).toHaveLength(0)
    const rejected = await readFile(join(home, '.cairn', 'outbox.jsonl.rejected'), 'utf8')
    expect(rejected).toContain('replay context mismatch')
    expect(rejected).toContain('a key this runtime no longer uses')
  })

  /**
   * One outbox serves every runtime on the machine. Claude Code and Codex on
   * the same Mac used to quarantine each other's queued writes: whichever
   * drained first rejected the other's as a "mismatch", and the note never
   * arrived. It is somebody else's write, not a bad one.
   */
  it("leaves another runtime's queued write for that runtime to send", async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'queued by claude'], 'crn_claude', { CAIRN_AGENT: 'claude-code' })
    mode = 'success'

    const codex = await run(home, base, ['replay'], 'crn_codex', { CAIRN_AGENT: 'codex' })
    expect(codex.stdout).toContain('sent 0, rejected 0, still queued 1 (1 for another runtime or instance)')
    expect(received).toHaveLength(0)

    const claude = await run(home, base, ['replay'], 'crn_claude', { CAIRN_AGENT: 'claude-code' })
    expect(claude.stdout).toContain('sent 1, rejected 0, still queued 0')
    expect(received).toHaveLength(1)
    expect(received[0]?.body).toContain('queued by claude')
  })

  it('leaves a write queued for another instance in place while draining its own', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'mine'])
    const outbox = join(home, '.cairn', 'outbox.jsonl')
    const own = (await readFile(outbox, 'utf8')).trim()
    const other = { ...JSON.parse(own), id: 'other-instance-item', base: 'http://127.0.0.1:9', body: { body: 'theirs' } }
    await writeFile(outbox, `${own}\n${JSON.stringify(other)}\n`)
    mode = 'success'

    const replay = await run(home, base, ['replay'])
    expect(replay.stdout).toContain('sent 1, rejected 0, still queued 1')
    expect(received.map((r) => r.body).join()).not.toContain('theirs')
    expect(await readFile(outbox, 'utf8')).toContain('other-instance-item')
  })

  const foreignItem = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    t: new Date().toISOString(),
    method: 'POST',
    path: '/api/v1/tasks/CAIRN-163/comments',
    body: { body: id },
    agent: 'claude-code',
    base,
    keyId: 'x',
    ...extra,
  })

  /**
   * Kept writes used to be appended back, landing behind anything queued while
   * the replay ran: a checkpoint could then be sent ahead of an older one.
   */
  it('puts kept writes back in front of anything queued while the replay ran', async () => {
    const outbox = join(home, '.cairn', 'outbox.jsonl')
    await mkdir(join(home, '.cairn'), { recursive: true })
    await writeFile(outbox, `${JSON.stringify(foreignItem('older'))}\n`)
    mode = 'success'

    const replay = await run(home, base, ['replay'], undefined, {
      CAIRN_TEST_ENQUEUE_DURING_REPLAY: JSON.stringify(foreignItem('newer')),
    })
    expect(replay.code).toBe(0)
    const ids = (await readFile(outbox, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).id)
    expect(ids).toEqual(['older', 'newer'])
  })

  it('does not drain a queue that holds only other runtimes\' writes', async () => {
    const outbox = join(home, '.cairn', 'outbox.jsonl')
    await mkdir(join(home, '.cairn'), { recursive: true })
    await writeFile(outbox, `${JSON.stringify(foreignItem('theirs'))}\n`)
    const before = await stat(outbox)
    mode = 'success'

    const write = await run(home, base, ['comment', 'CAIRN-163', 'mine'])
    expect(write.code).toBe(0)
    const after = await stat(outbox)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(received.map((r) => r.body).join()).not.toContain('theirs')
  })

  it('does not let another runtime\'s queued checkpoint shift this one\'s sequence', async () => {
    const ownershipDir = join(home, '.cairn', 'ownership')
    await mkdir(ownershipDir, { recursive: true })
    await writeFile(
      join(ownershipDir, 'CAIRN-163.json'),
      JSON.stringify({ ownershipVersion: 7, checkpointVersion: 3, agent: 'integration-agent' }),
    )
    const theirs = foreignItem('their-checkpoint', {
      path: '/api/v1/tasks/CAIRN-163/checkpoint',
      body: { summary: 'theirs', ownershipVersion: 7, checkpointVersion: 3 },
    })
    await writeFile(join(home, '.cairn', 'outbox.jsonl'), `${JSON.stringify(theirs)}\n`)

    await run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'mine'])
    const lines = (await readFile(join(home, '.cairn', 'outbox.jsonl'), 'utf8')).trim().split('\n')
    const mine = lines.map((line) => JSON.parse(line)).find((item) => item.body.summary === 'mine')
    expect(mine?.body.checkpointVersion).toBe(3)
  })

  it('quarantines a foreign write with no readable queued-at time instead of keeping it forever', async () => {
    await mkdir(join(home, '.cairn'), { recursive: true })
    await writeFile(join(home, '.cairn', 'outbox.jsonl'), `${JSON.stringify(foreignItem('timeless', { t: undefined }))}\n`)
    mode = 'success'

    const replay = await run(home, base, ['replay'])
    expect(replay.stdout).toContain('sent 0, rejected 1, still queued 0')
    const rejected = await readFile(join(home, '.cairn', 'outbox.jsonl.rejected'), 'utf8')
    expect(rejected).toContain('no queued-at time')
  })

  it('quarantines a foreign write nobody has replayed in 30 days, so the queue cannot grow forever', async () => {
    await mkdir(join(home, '.cairn'), { recursive: true })
    const stale = {
      id: 'stale-item',
      t: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      method: 'POST',
      path: '/api/v1/tasks/CAIRN-163/comments',
      body: { body: 'abandoned' },
      agent: 'retired-runtime',
      base,
      keyId: 'x',
    }
    await writeFile(join(home, '.cairn', 'outbox.jsonl'), `${JSON.stringify(stale)}\n`)
    mode = 'success'

    const replay = await run(home, base, ['replay'])
    expect(replay.stdout).toContain('sent 0, rejected 1, still queued 0')
    const rejected = await readFile(join(home, '.cairn', 'outbox.jsonl.rejected'), 'utf8')
    expect(rejected).toContain('in 30 days')
  })

  it('serializes concurrent replay workers without duplicating side effects', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      run(home, base, ['comment', 'CAIRN-163', `concurrent-${index}`]),
    ))
    mode = 'success'
    const results = await Promise.all([
      run(home, base, ['replay']),
      run(home, base, ['replay']),
    ])
    expect(results.every((result) => result.code === 0)).toBe(true)
    expect(received).toHaveLength(12)
    expect(new Set(received.map((request) => request.id)).size).toBe(12)
  })

  it('reserves monotonic checkpoint sequences under concurrent offline writes', async () => {
    const ownershipDir = join(home, '.cairn', 'ownership')
    await mkdir(ownershipDir, { recursive: true })
    await writeFile(
      join(ownershipDir, 'CAIRN-163.json'),
      JSON.stringify({ ownershipVersion: 7, checkpointVersion: 3, agent: 'integration-agent' }),
    )
    const queued = await Promise.all([
      run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'first']),
      run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'second']),
    ])
    expect(queued.every((result) => result.code === 0)).toBe(true)

    const lines = (await readFile(join(home, '.cairn', 'outbox.jsonl'), 'utf8')).trim().split('\n')
    const versions = lines.map((line) => JSON.parse(line).body.checkpointVersion).sort()
    expect(versions).toEqual([3, 4])
    expect(lines.every((line) => JSON.parse(line).body.ownershipVersion === 7)).toBe(true)
  })

  it('recovers a dead worker processing file immediately after an acknowledged send', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'crash recovery'])
    mode = 'success'
    const crashed = await run(
      home,
      base,
      ['replay'],
      'crn_integration_key',
      { CAIRN_TEST_CRASH_AFTER_SEND: '1' },
    )
    expect(crashed.code).not.toBe(0)

    const recovered = await run(home, base, ['replay'])
    expect(recovered.code).toBe(0)
    expect(recovered.stdout).toContain('still queued 0')
    expect(received).toHaveLength(1)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toBe(attempts[1])
  })

  it('recovers an orphaned processing file through the next ordinary successful write', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'orphan recovery'])
    mode = 'success'
    const crashed = await run(
      home,
      base,
      ['replay'],
      'crn_integration_key',
      { CAIRN_TEST_CRASH_AFTER_SEND: '1' },
    )
    expect(crashed.code).not.toBe(0)

    const ordinary = await run(home, base, ['comment', 'CAIRN-163', 'ordinary write'])
    expect(ordinary.code).toBe(0)
    expect(received).toHaveLength(2)
    expect(new Set(received.map((request) => request.id)).size).toBe(2)
  })

  it('does not reserve a checkpoint sequence twice after local progress persistence fails', async () => {
    const ownershipDir = join(home, '.cairn', 'ownership')
    await mkdir(ownershipDir, { recursive: true })
    await writeFile(
      join(ownershipDir, 'CAIRN-163.json'),
      JSON.stringify({ ownershipVersion: 7, checkpointVersion: 3, agent: 'integration-agent' }),
    )
    await run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'acknowledged'])
    mode = 'success'
    const failed = await run(
      home,
      base,
      ['replay'],
      'crn_integration_key',
      { CAIRN_TEST_FAIL_PERSIST_AFTER_SEND: '1' },
    )
    expect(failed.code).not.toBe(0)

    mode = 'fail'
    await run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'next'])
    const lines = (await readFile(join(home, '.cairn', 'outbox.jsonl'), 'utf8')).trim().split('\n')
    const versions = lines.map((line) => JSON.parse(line).body.checkpointVersion).sort()
    expect(versions).toEqual([3, 4])
  })

  it('retains an acknowledged item when local replay persistence fails', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'persistence recovery'])
    mode = 'success'
    const failed = await run(
      home,
      base,
      ['replay'],
      'crn_integration_key',
      { CAIRN_TEST_FAIL_PERSIST_AFTER_SEND: '1' },
    )
    expect(failed.code).not.toBe(0)

    const recovered = await run(home, base, ['replay'])
    expect(recovered.code).toBe(0)
    expect(recovered.stdout).toContain('still queued 0')
    expect(received).toHaveLength(1)
    expect(attempts).toHaveLength(2)
    expect(attempts.some((id, index) => id && attempts.indexOf(id) < index)).toBe(true)
  })

  it('recovers checkpoint state after a crash following processing-file compaction', async () => {
    const ownershipDir = join(home, '.cairn', 'ownership')
    await mkdir(ownershipDir, { recursive: true })
    await writeFile(
      join(ownershipDir, 'CAIRN-163.json'),
      JSON.stringify({ ownershipVersion: 7, checkpointVersion: 3, agent: 'integration-agent' }),
    )
    await run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'after-rename'])
    mode = 'success'
    const crashed = await run(home, base, ['replay'], 'crn_integration_key', {
      CAIRN_TEST_CRASH_AFTER_RENAME_BEFORE_STATE: '1',
    })
    expect(crashed.code).not.toBe(0)

    const recovered = await run(home, base, ['checkpoint', 'CAIRN-163', '--summary', 'successor'])
    expect(recovered.code).toBe(0)
    expect(received).toHaveLength(2)
    const state = JSON.parse(await readFile(join(ownershipDir, 'CAIRN-163.json'), 'utf8'))
    expect(state.checkpointVersion).toBe(5)
  })

  it('requeues the original record when rejected-sidecar persistence fails', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'rejected persistence'])
    mode = 'success'
    const failed = await run(home, base, ['replay'], 'crn_key_b', {
      CAIRN_TEST_FAIL_REJECT_PERSIST: '1',
    })
    expect(failed.code).toBe(0)
    expect(failed.stdout).toContain('still queued 1')
    expect(received).toHaveLength(0)

    const recovered = await run(home, base, ['replay'], 'crn_integration_key')
    expect(recovered.code).toBe(0)
    expect(received).toHaveLength(1)
    expect(recovered.stdout).toContain('still queued 0')
  })

  it('does not leave acknowledgement markers for non-checkpoint writes', async () => {
    await run(home, base, ['comment', 'CAIRN-163', 'marker comment'])
    await run(home, base, ['note', 'CAIRN-163', 'marker note'])
    await run(home, base, ['beat', 'CAIRN-163'])
    mode = 'success'

    const replay = await run(home, base, ['replay'])
    expect(replay.code).toBe(0)
    expect(replay.stdout).toContain('sent 3, rejected 0, still queued 0')
    const artifacts = await readdir(join(home, '.cairn'))
    expect(artifacts.filter((name) => name.includes('.ack-')).length).toBe(0)
  })
})
