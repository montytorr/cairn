import { z } from 'zod'

/**
 * A session is the episodic record: what was asked, what was learned, where it
 * was left. One row per agent session, written at the end of it.
 *
 * Everything except the four prose fields is extracted from the transcript
 * without a model — which is what makes this affordable where the store it
 * replaces, summarising every individual tool call, was not.
 */

export const PLATFORM_SOURCES = ['claude', 'codex', 'openclaw', 'other'] as const
export const platformSource = z.enum(PLATFORM_SOURCES)

export const sessionUpsert = z.object({
  externalId: z.string().min(1).max(200),
  platformSource: platformSource.default('claude'),
  agentId: z.string().max(80).optional(),
  cwd: z.string().max(500).optional(),
  project: z.string().max(10).optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),

  request: z.string().max(4_000).optional(),
  learned: z.string().max(20_000).optional(),
  completed: z.string().max(20_000).optional(),
  nextSteps: z.string().max(8_000).optional(),

  files: z.array(z.string().max(500)).max(400).default([]),
  /**
   * Task refs as scraped, not as vetted. A transcript yields `SHA-256`,
   * `HTTP-01` and `Z0-9` alongside real refs, so the cap is generous here and
   * the server drops everything whose project key it does not recognise.
   */
  taskRefs: z.array(z.string().max(40)).max(400).default([]),
  toolCalls: z.number().int().min(0).optional(),

  /**
   * Checkpoint any task this agent still holds, using the session summary.
   * This is the discipline mechanism: whatever the agent did or did not
   * record, the claim it is holding stops being a phantom.
   */
  checkpointHeld: z.boolean().default(true),
})

export type SessionUpsert = z.infer<typeof sessionUpsert>
export type PlatformSource = z.infer<typeof platformSource>
