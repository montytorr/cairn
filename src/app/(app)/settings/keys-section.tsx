'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Check, Copy, KeyRound } from 'lucide-react'
import { Button, Input, Select } from '@/components/ui/control'
import { cn } from '@/lib/utils'

export type KeyRow = {
  id: string
  agent_name: string
  name: string
  key_prefix: string
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

/** The three agents Cairn is built for, plus an escape hatch. */
const AGENTS = ['claude-code', 'codex', 'openclaw', 'cli'] as const

const ago = (iso: string | null) => {
  if (!iso) return 'never'
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export const KeysSection = ({ keys }: { keys: KeyRow[] }) => {
  const router = useRouter()
  const [agent, setAgent] = useState<string>('claude-code')
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Held in memory only. The server never stores the plaintext, so this is the
  // one and only chance to copy it.
  const [fresh, setFresh] = useState<{ key: string; agent: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const create = async () => {
    setCreating(true)
    setError(null)
    const res = await fetch('/api/v1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: agent, name: label.trim() || `${agent} key` }),
    })
    const payload = await res.json().catch(() => null)
    setCreating(false)

    if (!payload?.success) {
      setError(payload?.error ?? 'Could not create the key.')
      return
    }
    setFresh({ key: payload.data.key, agent })
    setLabel('')
    router.refresh()
  }

  const revoke = async (id: string, agentName: string) => {
    if (!confirm(`Revoke the ${agentName} key? That agent stops working immediately.`)) return
    await fetch(`/api/v1/keys/${id}`, { method: 'DELETE' })
    router.refresh()
  }

  const active = keys.filter((k) => !k.revoked_at)
  const revoked = keys.filter((k) => k.revoked_at)

  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-fg-muted text-[10.5px] font-medium tracking-[0.06em] uppercase">
          API keys
        </h2>
        <span className="text-fg-subtle tabular text-[11px]">{active.length} active</span>
        <span className="bg-border ml-1 h-px flex-1" />
      </div>

      {fresh && (
        <div className="border-accent bg-accent-subtle mb-4 rounded-md border p-3">
          <p className="text-fg mb-2 text-[12px] font-medium">
            New key for {fresh.agent} — shown once
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-surface border-border min-w-0 flex-1 overflow-x-auto rounded border px-2 py-1.5 font-mono text-[11px] whitespace-nowrap">
              {fresh.key}
            </code>
            <Button
              size="sm"
              variant="primary"
              className="w-auto shrink-0 px-2"
              onClick={async () => {
                await navigator.clipboard.writeText(fresh.key)
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-fg-muted mt-2 text-[11px] leading-relaxed">
            The server stores only a hash, so this cannot be shown again. Put it in the
            agent&apos;s <code className="font-mono">~/.cairn/env</code>, then dismiss.
          </p>
          <button
            type="button"
            onClick={() => setFresh(null)}
            className="text-fg-muted hover:text-fg mt-2 text-[11px] underline"
          >
            I&apos;ve stored it
          </button>
        </div>
      )}

      {active.length > 0 && (
        <ul className="border-border divide-border mb-4 overflow-hidden rounded-md border divide-y">
          {active.map((k) => (
            <li key={k.id} className="group flex h-[36px] items-center gap-2.5 px-3">
              <KeyRound size={12} className="text-fg-subtle shrink-0" />
              <span className="w-24 shrink-0 truncate text-[12.5px]">{k.agent_name}</span>
              <code className="text-fg-subtle shrink-0 font-mono text-[10.5px]">
                {k.key_prefix}…
              </code>
              <span
                className={cn(
                  'ml-auto shrink-0 text-[11px]',
                  k.last_used_at ? 'text-fg-muted' : 'text-fg-subtle',
                )}
                title={k.last_used_at ?? 'never used'}
              >
                {ago(k.last_used_at)}
              </span>
              <button
                type="button"
                onClick={() => revoke(k.id, k.agent_name)}
                className="text-fg-subtle hover:text-danger shrink-0 text-[11px] opacity-0 transition-opacity group-hover:opacity-100"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Select
          size="sm"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className="w-36"
          aria-label="Agent"
        >
          {AGENTS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </Select>
        <Input
          size="sm"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="w-44"
        />
        <Button size="sm" variant="secondary" onClick={create} disabled={creating} className="w-auto px-3">
          {creating ? 'Creating…' : 'Create key'}
        </Button>
      </div>

      {error && <p className="text-danger mt-2 text-[11px]">{error}</p>}

      <p className="text-fg-subtle mt-3 max-w-md text-[11px] leading-relaxed">
        One key per agent. The key&apos;s name is recorded as the author on everything it
        writes, so &quot;who tried what&quot; stays answerable — and any single agent can be
        revoked without disturbing the others.
      </p>

      {revoked.length > 0 && (
        <details className="mt-4">
          <summary className="text-fg-subtle cursor-pointer text-[11px]">
            {revoked.length} revoked
          </summary>
          <ul className="text-fg-subtle mt-1.5 flex flex-col gap-1 text-[11px]">
            {revoked.map((k) => (
              <li key={k.id} className="flex gap-2">
                <span className="w-24 truncate line-through">{k.agent_name}</span>
                <code className="font-mono text-[10.5px]">{k.key_prefix}…</code>
                <span className="ml-auto">revoked {ago(k.revoked_at)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
