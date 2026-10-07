'use client'

import { useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/control'

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
    // A flat card: one hairline round it, one under the language bar.
    <div className="group surface-card relative mb-3 overflow-hidden last:mb-0">
      <div className="border-border flex min-h-[2.25rem] items-center gap-2 border-b px-2.5">
        <span className="text-fg-subtle font-mono text-meta tracking-wide">
          {language ?? 'text'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={copy}
          aria-label="Copy code"
          className={cn(
            '-mr-1.5 ml-auto',
            'md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100',
            copied && 'text-accent opacity-100',
          )}
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-3 text-ui leading-relaxed" {...rest}>
        {children}
      </pre>
    </div>
  )
}
