import { pool } from '@/lib/db/client'

/**
 * Where else a task was named (CAIRN-267).
 *
 * `task_mentions` is filled by triggers from every note, comment, description
 * and resolution that writes a resolvable ref; this reads it backwards. The
 * order is the point: a decision or a finding about this task outranks a
 * passing mention, and a resolution is a decision by definition.
 */

export type Mention = {
  ref: string
  title: string
  status: string
  source: 'note' | 'comment' | 'description' | 'resolution'
  /** The note's kind, when the mention is in a note. */
  kind: string | null
  by: string | null
  at: string
  /** The ref as the author wrote it — a retired key reads differently. */
  writtenAs: string
  /** The text around the mention. */
  excerpt: string
}

const WINDOW = 160

/** A window of `text` around the first occurrence of `ref`, on word boundaries. */
/**
 * What a reader of the rendered note would see, flattened: the excerpt is
 * shown as plain text, so `**Diagnosis.**` and `## Synthesis` and backticks
 * were arriving as literal punctuation (CAIRN-362).
 */
export const plainText = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(`+)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()

export const excerptAround = (text: string, ref: string): string => {
  const flat = plainText(text)
  const at = flat.search(new RegExp(`\\b${ref.replace(/[-]/g, '\\-')}\\b`))
  if (at < 0) return flat.length > WINDOW * 2 ? `${flat.slice(0, WINDOW * 2)}…` : flat

  let start = Math.max(0, at - WINDOW)
  let end = Math.min(flat.length, at + ref.length + WINDOW)
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < at) start = space + 1
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end)
    if (space > at + ref.length) end = space
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export const mentionsOf = async (
  taskId: string,
  limit = 10,
): Promise<{ total: number; mentions: Mention[] }> => {
  const { rows } = await pool().query(
    `select p.key || '-' || s.number as ref, s.title, s.status, m.source,
            n.kind, m.ref_as_written, m.created_at,
            coalesce(n.actor_id, c.actor_id,
                     case when m.source = 'resolution' then s.resolved_by end,
                     s.actor_id) as by,
            coalesce(n.note, c.content,
                     case m.source when 'description' then s.description else s.resolution end) as text,
            count(*) over () as total
       from task_mentions m
       join tasks s on s.id = m.source_task_id
       join projects p on p.id = s.project_id
       left join task_notes n on n.id = m.note_id
       left join task_comments c on c.id = m.comment_id
      where m.target_task_id = $1
      order by case
                 when m.source = 'resolution' or n.kind in ('decision', 'finding') then 0
                 when n.kind = 'handoff' or m.source = 'description' then 1
                 else 2
               end,
               m.created_at desc
      limit $2`,
    [taskId, limit],
  )

  return {
    total: Number(rows[0]?.total ?? 0),
    mentions: rows.map((r) => ({
      ref: r.ref as string,
      title: r.title as string,
      status: r.status as string,
      source: r.source as Mention['source'],
      kind: (r.kind as string | null) ?? null,
      by: (r.by as string | null) ?? null,
      at: new Date(r.created_at as string).toISOString(),
      writtenAs: r.ref_as_written as string,
      excerpt: excerptAround(String(r.text ?? ''), r.ref_as_written as string),
    })),
  }
}

/** A task that named this one, with everything it said, so its title is written once. */
export type MentionGroup = {
  ref: string
  title: string
  status: string
  entries: Mention[]
}

/**
 * Mentions folded by the task they came from, in the order of the first.
 *
 * The query ranks decisions and findings first, and that ranking is the point,
 * so a group sits where its best mention sat. Three notes on one audit task
 * used to be three rows, each repeating the same title.
 */
export const groupMentions = (mentions: Mention[]): MentionGroup[] => {
  const groups = new Map<string, MentionGroup>()
  for (const m of mentions) {
    const group = groups.get(m.ref)
    if (group) group.entries.push(m)
    else groups.set(m.ref, { ref: m.ref, title: m.title, status: m.status, entries: [m] })
  }
  return [...groups.values()]
}

/**
 * Who, without the account they run under: "claude-code · cal@example.com"
 * is `claude-code` to a reader who already knows whose Cairn this is, and a
 * bare email is its local part.
 */
export const shortActor = (actor: string | null): string | null => {
  if (!actor) return null
  const head = actor.split(' · ')[0] ?? actor
  return head.includes('@') ? (head.split('@')[0] ?? head) : head
}
