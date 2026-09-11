import { authenticate } from '@/lib/api/auth'
import { admin } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

/**
 * Server-sent events for "something changed in this project".
 *
 * Deliberately NOT Supabase Realtime. That was the original plan only because
 * the container was already running; it has since been switched off to reclaim
 * CPU on a contended host, and re-enabling a whole service to notify three
 * clients would be the tail wagging the dog. SSE needs nothing but this route.
 *
 * It watches a single cheap indexed aggregate rather than streaming row
 * changes: the client only needs to know THAT something moved, then asks the
 * server for the new state through the normal render path. Shipping diffs
 * would mean a second, partial implementation of every view.
 */
const POLL_MS = 4000
const MAX_LIFETIME_MS = 10 * 60 * 1000

export const GET = async (req: Request) => {
  const actor = await authenticate(req)
  if (!actor) return new Response('Unauthorized', { status: 401 })

  const url = new URL(req.url)
  const projectKey = url.searchParams.get('project')

  const fingerprint = async (): Promise<string> => {
    let q = admin()
      .from('tasks')
      .select('updated_at, project:projects!project_id!inner(key, owner_user_id)')
      .eq('projects.owner_user_id', actor.userId)
      .order('updated_at', { ascending: false })
      .limit(1)

    if (projectKey) q = q.eq('projects.key', projectKey.toUpperCase())

    const [latest, counted] = await Promise.all([
      q,
      admin()
        .from('tasks')
        .select('id, project:projects!project_id!inner(key, owner_user_id)', { count: 'exact', head: true })
        .eq('projects.owner_user_id', actor.userId),
    ])

    const row = (latest.data ?? [])[0] as { updated_at?: string } | undefined
    // Count is included so a deletion registers too — updated_at alone
    // would not move when a row disappears.
    return `${row?.updated_at ?? '-'}:${counted.count ?? 0}`
  }

  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`))

      let last = await fingerprint()
      send('ready', last)

      const started = Date.now()
      timer = setInterval(async () => {
        // Bounded lifetime: a browser tab left open for days should not hold
        // a connection and a timer forever. EventSource reconnects on its own.
        if (Date.now() - started > MAX_LIFETIME_MS) {
          clearInterval(timer)
          controller.close()
          return
        }
        try {
          const next = await fingerprint()
          if (next !== last) {
            last = next
            send('changed', next)
          } else {
            // Comment frames keep proxies from closing an idle connection.
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }
        } catch {
          // A transient failure should not kill the stream; the next tick
          // will try again.
        }
      }, POLL_MS)

      req.signal.addEventListener('abort', () => {
        clearInterval(timer)
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      clearInterval(timer)
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Traefik does not buffer by default, but nginx would.
      'x-accel-buffering': 'no',
    },
  })
}
