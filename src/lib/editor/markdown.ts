import { Editor, type Extensions } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Image from '@tiptap/extension-image'
import { Markdown } from 'tiptap-markdown'

/**
 * The editor's extension set is deliberately constrained to constructs that
 * map 1:1 onto GFM.
 *
 * Markdown is the source of truth in `tasks.description`, because agents read
 * and write it over the API. Tiptap is WYSIWYG over a ProseMirror document, so
 * every human edit round-trips markdown -> doc -> markdown. Anything outside
 * this schema is lossy on that trip, so the schema is kept to exactly what
 * GFM can express — and what it cannot express is documented rather than
 * silently mangled.
 */
export const editorExtensions = (): Extensions => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // Rendered as `---`; kept because agents use it as a section break.
    horizontalRule: {},
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  // Not in StarterKit. Without it a markdown image is dropped on the round
  // trip, which would silently delete screenshot references from bodies an
  // agent wrote. Found by the fidelity spike, not by reading the docs.
  Image.configure({ inline: false, allowBase64: false }),
  Markdown.configure({
    html: false, // raw HTML is not round-trippable; drop it rather than corrupt it
    tightLists: true,
    bulletListMarker: '-',
    linkify: false,
    breaks: false,
    transformPastedText: true,
  }),
]

/** Headless editor, for serialisation and tests. Requires a DOM. */
export const headlessEditor = (markdown: string) =>
  new Editor({ extensions: editorExtensions(), content: markdown })

/** markdown -> ProseMirror -> markdown. The trip a human edit makes. */
export const roundTrip = (markdown: string): string => {
  const editor = headlessEditor(markdown)
  const out = editor.storage.markdown.getMarkdown() as string
  editor.destroy()
  return out
}
