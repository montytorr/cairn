'use client'

import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

/**
 * A fenced code block with its language named and a copy button.
 *
 * Agent-written bodies are mostly code, commands and log excerpts, and the
 * single most common thing anyone does with them is copy one out. Without
 * this you select by hand across a scrolling region and usually catch the
 * wrong lines.
 */
export const CodeBlock = ({ children, ...rest }: React.ComponentProps<'pre'>) => {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  // react-markdown nests <code class="language-x"> inside <pre>; the language
  // lives on the child, not here.
  const child = Array.isArray(children) ? children[0] : children
  const className: string =
    (child as { props?: { className?: string } })?.props?.className ?? ''
  const language = /language-([\w-]+)/.exec(className)?.[1]

  const copy = async () => {
    const text = ref.current?.innerText ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard blocked; the selection still works
    }
  }

  return (
    <div className="group border-border bg-surface-raised relative mb-3 overflow-hidden rounded-md border last:mb-0">
      <div className="border-border/60 flex h-[28px] items-center gap-2 border-b px-2.5">
        <span className="text-fg-subtle font-mono text-[10.5px] tracking-wide">
          {language ?? 'text'}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="text-fg-subtle hover:text-fg ml-auto flex items-center gap-1 text-[10.5px] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 text-[12.5px] leading-relaxed" {...rest}>
        {children}
      </pre>
    </div>
  )
}
