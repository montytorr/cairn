import { visit, SKIP } from 'unist-util-visit'

/**
 * Bare refs like `CAI-42`. Deliberately requires the prefix to be a real
 * project key: the same shape matches `UTF-8`, `HTTP-404` and `SHA-256`, and
 * linkifying those would be worse than linkifying nothing.
 */
const REF = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g

type TextNode = { type: 'text'; value: string }
type LinkNode = {
  type: 'link'
  url: string
  data: { hProperties: Record<string, string> }
  children: TextNode[]
}
type Parent = { type: string; children: unknown[] }

/**
 * Turns bare task refs in prose into links.
 *
 * Agents cross-reference constantly ("superseded by CAI-31", "same cause as
 * HERMES-92") and until now those were dead text. Cairn is only useful as
 * shared memory if following a reference costs nothing, so this is closer to
 * a core feature than to typography.
 */
export const remarkTaskRefs = ({ keys }: { keys: readonly string[] }) => {
  const allowed = new Set(keys.map((k) => k.toUpperCase()))

  return (tree: unknown) => {
    if (allowed.size === 0) return

    visit(
      tree as Parent,
      'text',
      (node: unknown, index: number | undefined, parent: Parent | undefined) => {
        if (!parent || index === undefined) return
        // A ref already inside a link stays as the author wrote it.
        if (parent.type === 'link' || parent.type === 'linkReference') return

        const value = (node as TextNode).value
        const out: (TextNode | LinkNode)[] = []
        let cursor = 0

        for (const match of value.matchAll(REF)) {
          const [full, key, number] = match
          if (!key || !number || !allowed.has(key)) continue
          const at = match.index
          if (at > cursor) out.push({ type: 'text', value: value.slice(cursor, at) })
          out.push({
            type: 'link',
            url: `/projects/${key}/tasks/${number}`,
            // Marks it as internal so the renderer can route it in-app rather
            // than opening a new tab like an external link.
            data: { hProperties: { 'data-task-ref': full } },
            children: [{ type: 'text', value: full }],
          })
          cursor = at + full.length
        }

        if (out.length === 0) return
        if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) })

        parent.children.splice(index, 1, ...out)
        // Skip past what was just inserted, or the new text nodes get rescanned.
        return [SKIP, index + out.length]
      },
    )
  }
}
