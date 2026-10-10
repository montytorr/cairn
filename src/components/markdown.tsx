'use client'

import Link from 'next/link'
import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components, ExtraProps } from 'react-markdown'
import type { PluggableList } from 'unified'
import { cn } from '@/lib/utils'
import { CodeBlock } from '@/components/code-block'
import { useProjectKeys } from '@/components/project-keys'
import { useKnowledgeSlugs } from '@/components/knowledge-slugs'
import { useLabEnabled } from '@/components/lab/lab-context'
import { remarkTaskRefs } from '@/lib/markdown/task-refs'
import { remarkKnowledgeRefs } from '@/lib/markdown/knowledge-refs'

/**
 * react-markdown hands every component the hast node it came from. Spread onto
 * a DOM element with the rest of the props, it landed in the markup as
 * node="[object Object]" on every paragraph.
 */
const dom = <T extends ExtraProps>(props: T): Omit<T, 'node'> => {
  const rest = { ...props }
  delete rest.node
  return rest
}

/**
 * A reading measure for running text. Code and tables keep the full column,
 * since they are read across rather than along.
 */
const MEASURE = 'max-w-[75ch]'

/** Links read as the accent, underlined a little below the baseline. */
const LINK =
  'text-accent decoration-accent/40 decoration-1 underline-offset-[3px] transition-[text-decoration-color] duration-[var(--dur-1)] hover:decoration-accent'

/**
 * A hand-rolled component map rather than a prose plugin, so every element
 * inherits the same oklch tokens as the rest of the app and stays legible at
 * the density a tracker needs.
 */
const components: Components = {
  h1: ({ className, ...p }) => (
    <h1
      className={cn(MEASURE, 'text-fg mt-6 mb-2 text-[1rem] leading-snug font-semibold tracking-[-0.015em] text-balance first:mt-0', className)}
      {...dom(p)}
    />
  ),
  h2: ({ className, ...p }) => (
    <h2
      className={cn(MEASURE, 'text-fg mt-5 mb-2 text-[0.9167rem] leading-snug font-semibold tracking-[-0.01em] text-balance first:mt-0', className)}
      {...dom(p)}
    />
  ),
  h3: ({ className, ...p }) => (
    <h3 className={cn(MEASURE, 'text-fg-muted mt-4 mb-1.5 text-ui font-semibold first:mt-0', className)} {...dom(p)} />
  ),
  // Unmapped, a fourth-level heading was preflight's reset: body text with no
  // weight and no space, indistinguishable from the paragraph under it.
  h4: ({ className, ...p }) => (
    <h4 className={cn(MEASURE, 'text-fg-muted mt-3 mb-1 text-ui font-medium first:mt-0', className)} {...dom(p)} />
  ),
  p: ({ className, ...p }) => (
    <p className={cn(MEASURE, 'mb-3 text-ui leading-relaxed text-pretty last:mb-0', className)} {...dom(p)} />
  ),
  // The class is merged, not replaced: GFM gives a task list its own class,
  // and spreading it last used to wipe every style off the list.
  ul: ({ className, ...p }) => (
    <ul
      className={cn(
        MEASURE,
        'marker:text-fg-subtle mb-3 ml-4 list-disc space-y-1 text-ui last:mb-0',
        '[&.contains-task-list]:ml-0 [&.contains-task-list]:list-none',
        className,
      )}
      {...dom(p)}
    />
  ),
  ol: ({ className, ...p }) => (
    <ol
      className={cn(MEASURE, 'marker:text-fg-subtle mb-3 ml-4 list-decimal space-y-1 text-ui marker:tabular-nums last:mb-0', className)}
      {...dom(p)}
    />
  ),
  li: ({ className, ...p }) => <li className={cn('pl-0.5 leading-relaxed', className)} {...dom(p)} />,
  a: ({ href, children, ...rest }) => {
    // A linkified task ref is in-app navigation, not an outbound link: opening
    // it in a new tab would make following a chain of references unbearable.
    const knowledgeRef = (rest as Record<string, unknown>)['data-knowledge-ref']
    if (typeof knowledgeRef === 'string' && href) {
      // Marked when the target does not exist, so a reference to something
      // nobody wrote reads as a loose end rather than as a working link.
      const missing = (rest as Record<string, unknown>)['data-knowledge-missing'] === 'true'
      // And not a link at all. It used to be one, and following it landed on
      // the generic empty state — "That task or project does not exist, or it
      // was deleted" — which is the wrong noun for a knowledge slug and tells
      // the reader the entry was lost rather than never written. The tooltip
      // already says "— yet"; the mark should not then invite a click that
      // contradicts it.
      if (missing) {
        return (
          <span
            title={`No knowledge "${knowledgeRef}" — yet`}
            className="text-fg-subtle decoration-fg-subtle/60 decoration-dotted cursor-help underline underline-offset-[3px]"
          >
            {children}
          </span>
        )
      }
      return (
        <Link href={href} prefetch className={cn(LINK, 'hover:underline')}>
          {children}
        </Link>
      )
    }

    const taskRef = (rest as Record<string, unknown>)['data-task-ref']
    if (typeof taskRef === 'string' && href) {
      return (
        <Link href={href} prefetch className={cn(LINK, 'hover:underline')}>
          {children}
        </Link>
      )
    }
    return (
      <a
        href={href}
        className={cn(LINK, 'underline')}
        target="_blank"
        rel="noreferrer noopener"
        {...dom(rest)}
      >
        {children}
      </a>
    )
  },
  // The trail marker as a quote's edge: the accent's line down the left, on
  // a bare face.
  blockquote: ({ className, ...p }) => (
    <blockquote
      className={cn(
        MEASURE,
        'text-fg-muted mb-3 rounded-r-md py-1 pr-3 pl-3.5 text-ui last:mb-0',
        'shadow-[inset_2px_0_0_color-mix(in_oklab,var(--accent)_60%,transparent)]',
        className,
      )}
      {...dom(p)}
    />
  ),
  // A plain hairline, as the page header's is.
  hr: () => <hr className="bg-border my-5 h-px border-0" />,
  strong: ({ className, ...p }) => <strong className={cn('text-fg font-semibold', className)} {...dom(p)} />,
  code: ({ className, children, ...rest }) => {
    // react-markdown gives fenced blocks a language-* class; bare inline code
    // has none, and the two want very different treatment.
    const isBlock = /language-/.test(className ?? '')
    if (isBlock) {
      return (
        <code className={cn('font-mono text-ui leading-relaxed', className)} {...dom(rest)}>
          {children}
        </code>
      )
    }
    // A soft chip: a raised face and a hairline drawn inside it, rather than
    // a box that competes with the words around it.
    return (
      <code
        className="bg-surface-raised text-fg rounded-[0.3125rem] px-[0.3em] py-px font-mono text-ui break-words ring-1 ring-border ring-inset"
        {...dom(rest)}
      >
        {children}
      </code>
    )
  },
  pre: (p) => <CodeBlock {...dom(p)} />,
  table: ({ className, ...p }) => (
    // Its own scroll container, so a wide table never makes the page body
    // scroll sideways.
    <div className="border-border mb-3 overflow-x-auto rounded-lg border last:mb-0">
      <table
        className={cn(
          'w-full border-collapse text-ui tabular-nums',
          '[&_tbody_tr]:transition-colors [&_tbody_tr]:duration-[var(--dur-1)] [&_tbody_tr:hover]:bg-surface-hover',
          '[&_tbody_tr:last-child>td]:border-b-0',
          className,
        )}
        {...dom(p)}
      />
    </div>
  ),
  th: ({ className, ...p }) => (
    <th
      className={cn(
        'border-border bg-surface-raised text-fg-muted border-b px-2.5 py-1.5 text-left text-meta font-medium',
        className,
      )}
      {...dom(p)}
    />
  ),
  td: ({ className, ...p }) => (
    <td className={cn('border-border/70 border-b px-2.5 py-1.5 align-top', className)} {...dom(p)} />
  ),
  input: (p) => (
    // GFM task list checkboxes. Read-only here: the body is edited in the
    // editor, not by clicking through the rendered view.
    <input
      className="mr-1.5 translate-y-[3px]"
      disabled
      readOnly
      {...dom(p)}
    />
  ),
  img: (p) => (
    // next/image is not usable here: these URLs come from markdown an agent
    // wrote, so the host is arbitrary and cannot be pre-declared in
    // next.config, and signed attachment URLs are short-lived and unoptimisable.
    // eslint-disable-next-line @next/next/no-img-element
    <img className="border-border raised-sm my-3 max-w-full rounded-lg border" alt="" {...dom(p)} />
  ),
}

export const MarkdownView = ({ children }: { children: string }) => {
  const keys = useProjectKeys()
  // Only where the COMPLETE set of slugs is in hand. Given a partial list the
  // plugin would mark every entry missing from it as never written, so the
  // provider's default is null and this stays off rather than lying.
  const slugs = useKnowledgeSlugs()
  // `LAB-12` is a link only while the Lab is on; off, it stays the text it was.
  const lab = useLabEnabled()
  // react-markdown re-parses whenever the plugin array changes identity, so
  // this must not be rebuilt on every render.
  const remarkPlugins = useMemo<PluggableList>(
    () => [
      remarkGfm,
      [remarkTaskRefs, { keys, lab }],
      [remarkKnowledgeRefs, slugs ? { known: slugs } : {}],
    ],
    [keys, lab, slugs],
  )

  return (
    <div className="text-fg">
      <Markdown
        remarkPlugins={remarkPlugins}
        // detect: false — only highlight blocks that declare a language.
        // Guessing on an unlabelled block colours prose and log output as if it
        // were code, which is worse than leaving it plain.
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  )
}

/**
 * Three-line clamped preview for cards and list rows. Renders the markdown
 * rather than showing raw syntax, then clamps — which is what makes a board of
 * agent-written tasks scannable.
 */
export const MarkdownPreview = ({ children, lines = 3 }: { children: string; lines?: number }) => (
  <div
    className="text-fg-muted overflow-hidden text-meta leading-snug [&_*]:!mb-0 [&_*]:!mt-0 [&_a]:no-underline [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_h1]:text-meta [&_h1]:font-normal [&_h2]:text-meta [&_h2]:font-normal [&_h3]:text-meta [&_h3]:font-normal [&_li]:list-none [&_pre]:border-0 [&_pre]:bg-transparent [&_pre]:p-0 [&_ul]:ml-0"
    style={{
      display: '-webkit-box',
      WebkitLineClamp: lines,
      WebkitBoxOrient: 'vertical',
    }}
  >
    <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
  </div>
)
