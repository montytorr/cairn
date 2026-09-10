# Decision: markdown stays the source of truth

**Status:** resolved. Option A adopted.
**Evidence:** `src/lib/editor/markdown.test.ts` — 20 tests, all passing.

## The problem

Two requirements pull against each other:

1. A task body **is markdown**, stored in `tasks.description`, because agents read and
   write it over the API.
2. Humans edit it through **Tiptap**, which is WYSIWYG over a ProseMirror document.

So every human edit round-trips `markdown → ProseMirror → markdown`. Anything the editor
schema cannot represent is lost on that trip. The failure mode is quiet and bad: an agent
writes valid markdown, a human opens the task and saves it, and the body silently changes.

## Decision

**Markdown is the source of truth, and the editor schema is constrained to constructs
that map 1:1 onto GFM.** Anything outside it is dropped deliberately rather than mangled,
and the losses are enumerated below.

Rejected alternatives:

- *ProseMirror JSON as truth with a generated markdown mirror.* Lossless for humans, but
  agents write markdown that must convert inbound, so the lossy step only moves.
- *No WYSIWYG, split-pane raw markdown.* Zero risk, but rejected on product grounds.

## What the tests establish

Verified idempotent — a second round trip changes nothing:

headings · emphasis (italic/bold/inline code) · bullet lists · ordered lists · nested
lists · task lists with checkbox state · fenced code with language · blockquotes · links ·
**images** · horizontal rules · strikethrough · paragraphs

Plus an explicit case for a realistic agent-written body (headings, checkboxes, a fenced
block) confirming that open-and-save with no edits leaves it byte-stable.

## Documented losses — trade-offs, not bugs

| Construct | Behaviour | Why |
|---|---|---|
| Raw inline HTML | **Dropped** | `html: false`. Not round-trippable; dropping beats corrupting. |
| GFM tables | **Degraded to text** | StarterKit ships no table extension. See below. |
| `*` list markers | Normalised to `-` | One canonical marker; content is unchanged. |
| Setext headings | Normalised to ATX (`# `) | Same. |

## Two findings worth recording

1. **`tiptap-markdown@0.9.0` declares `@tiptap/core: ^3.0.1`.** The main compatibility
   risk going in — that it was a v2-era package — turned out not to exist.
2. **Images need `@tiptap/extension-image` explicitly.** StarterKit does not include it,
   and without it a markdown image is dropped *entirely* on the round trip. That would
   have silently deleted screenshot references from agent-written bodies. This is the
   thing the spike was for; it would not have been caught by review.

## Tables: the open question

Tables are the only loss that could plausibly matter, since agents like them for
comparisons. Deferred rather than solved, because adding `@tiptap/extension-table` also
means teaching the markdown serialiser to emit pipe tables, and no real task needs one
yet.

**Guard in the meantime:** never save a body that is unchanged. If the editor opens a
task and the user makes no edit, do not write — that alone prevents most silent rewrites.
