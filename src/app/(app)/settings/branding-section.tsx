'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input } from '@/components/ui/control'
import { mutate } from '@/lib/api/mutate'
import { HEX, STOCK_MARK, paletteFor, type AccentTokens } from '@/lib/brand-colour'
import { cn } from '@/lib/utils'
import { SettingsCard } from './settings-card'

export type BrandingValue = { name: string; accent: string | null }

const STOCK_ACCENT = '#5e6ad2'

/** A handful of starting points; any hex works. */
const PRESETS = ['#5e6ad2', '#01519b', '#0e7490', '#15803d', '#b45309', '#be123c', '#7c3aed', '#3f3f46']

const STOCK_TOKENS: Record<'light' | 'dark', AccentTokens> = {
  light: { accent: '#5e6ad2', accentFg: '#ffffff', accentSubtle: '#eceefb', ring: '#5e6ad2' },
  dark: { accent: '#7b86e8', accentFg: '#ffffff', accentSubtle: '#23253a', ring: '#5e6ad2' },
}

/**
 * One theme of the preview, drawn with the tokens saving would produce —
 * computed here by the same function the server uses, so what is shown is
 * what everyone gets.
 */
const Preview = ({
  theme,
  tokens,
  mark,
  name,
}: {
  theme: 'light' | 'dark'
  tokens: AccentTokens
  mark: string
  name: string
}) => {
  const ground = theme === 'light' ? { bg: '#ffffff', fg: '#0d0e10', muted: '#61656c', border: '#e6e7e9' } : { bg: '#08090a', fg: '#f7f8f8', muted: '#9aa0a9', border: '#1f2023' }
  return (
    <div
      className="flex flex-1 flex-col gap-3 rounded-md border p-3 transition-colors duration-[var(--dur-2)] ease-[var(--ease-out)]"
      style={{ background: ground.bg, color: ground.fg, borderColor: ground.border }}
    >
      <div className="flex items-center gap-2 text-ui font-semibold tracking-tight">
        <svg viewBox="0 0 32 32" className="size-5 rounded-[5px]" aria-hidden>
          <rect width="32" height="32" rx="7" fill="#08090a" />
          <g fill={mark}>
            <rect x="10" y="5.75" width="12" height="5.5" rx="2.75" />
            <rect x="6" y="13.25" width="20" height="5.5" rx="2.75" />
            <rect x="9" y="20.75" width="14" height="5.5" rx="2.75" />
          </g>
        </svg>
        <span className="truncate">{name}</span>
      </div>
      <div className="rounded-md px-2 py-1 text-meta" style={{ background: tokens.accentSubtle }}>
        All tasks
      </div>
      <p className="text-meta" style={{ color: ground.muted }}>
        Nothing in progress. <span style={{ color: tokens.accent }}>See the backlog</span>
      </p>
      <span
        className="inline-flex h-7 w-fit items-center rounded-md px-3 text-meta font-medium"
        style={{ background: tokens.accent, color: tokens.accentFg }}
      >
        New task
      </span>
    </div>
  )
}

/**
 * What this instance is called and looks like, for everyone who uses it.
 * Admins only — the page does not render it for anyone else, and the API
 * refuses them regardless.
 */
export const BrandingSection = ({ initial }: { initial: BrandingValue }) => {
  const router = useRouter()
  const [name, setName] = useState(initial.name === 'Cairn' ? '' : initial.name)
  const [accent, setAccent] = useState(initial.accent ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const valid = accent === '' || HEX.test(accent)
  const palette = useMemo(() => (accent && HEX.test(accent) ? paletteFor(accent) : null), [accent])
  const shownName = name.trim() || 'Cairn'

  const save = async (reset = false) => {
    setBusy(true)
    setMessage(null)
    const result = await mutate('/api/v1/branding', {
      method: 'PUT',
      body: reset ? { name: null, accent: null } : { name: name.trim() || null, accent: accent || null },
    })
    setBusy(false)
    if (!result.ok) {
      setMessage({ tone: 'error', text: result.error })
      return
    }
    if (reset) {
      setName('')
      setAccent('')
    }
    setMessage({ tone: 'ok', text: 'Saved. Everyone sees it on their next page load.' })
    router.refresh()
  }

  return (
    <SettingsCard
      title="Branding"
      description={
        <>The name and colour people see in the sidebar, tab titles and login page.</>
      }
      footer={
        <>
          {message ? (
            <p
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'enter-rise min-w-0 flex-1 basis-60 rounded-md px-2.5 py-1.5 text-meta',
                message.tone === 'error' ? 'text-danger bg-danger-subtle' : 'text-fg-muted',
              )}
            >
              {message.text}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={busy || !valid}>
              {busy ? 'Saving…' : 'Save branding'}
            </Button>
            <Button variant="ghost" onClick={() => void save(true)} disabled={busy}>
              Reset to stock
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-fg-muted text-meta font-medium">Name</span>
          <Input
            value={name}
            maxLength={60}
            placeholder="Cairn"
            onChange={(e) => setName(e.target.value)}
            className="max-w-xs"
          />
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-fg-muted text-meta font-medium">Accent</span>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAccent(preset === STOCK_ACCENT ? '' : preset)}
                aria-label={preset === STOCK_ACCENT ? 'Stock indigo' : preset}
                title={preset === STOCK_ACCENT ? 'Stock indigo' : preset}
                className={cn(
                  'inset-ring-black/12 size-[var(--control-h-sm)] rounded-full inset-ring',
                  'transition-[box-shadow] duration-[var(--dur-1)] ease-[var(--ease-out)]',
                  (accent || STOCK_ACCENT) === preset
                    ? 'ring-fg ring-offset-surface ring-2 ring-offset-2'
                    : 'hover:ring-border-strong hover:ring-offset-surface hover:ring-2 hover:ring-offset-2',
                )}
                style={{ background: preset }}
              />
            ))}
            <input
              type="color"
              value={valid && accent ? accent : STOCK_ACCENT}
              onChange={(e) => setAccent(e.target.value)}
              aria-label="Pick any colour"
              className="size-[var(--control-h-sm)] cursor-pointer rounded-full"
            />
            <Input
              size="sm"
              value={accent}
              onChange={(e) => setAccent(e.target.value.trim())}
              placeholder={STOCK_ACCENT}
              aria-invalid={!valid}
              className="w-32"
            />
          </div>
          <p className="text-fg-subtle text-meta">
            Dark mode shows a slightly lighter shade so it stays readable.
          </p>
        </div>

        {/* The live preview, in a well of its own so it reads as a picture of
            the product rather than a piece of this page. */}
        <div className="border-border bg-bg-elevated flex flex-col gap-2 rounded-lg border p-2 sm:flex-row">
          <Preview theme="light" tokens={palette?.light ?? STOCK_TOKENS.light} mark={palette?.dark.accent ?? STOCK_MARK} name={shownName} />
          <Preview theme="dark" tokens={palette?.dark ?? STOCK_TOKENS.dark} mark={palette?.dark.accent ?? STOCK_MARK} name={shownName} />
        </div>
      </div>
    </SettingsCard>
  )
}
