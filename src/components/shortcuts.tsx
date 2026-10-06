'use client'

import { useEffect, useState } from 'react'

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: 'Global',
    keys: [
      [['⌘', 'K'], 'Search and jump'],
      [['C'], 'New task'],
      [['?'], 'This list'],
      [['Esc'], 'Close, or leave a field'],
    ],
  },
  {
    title: 'Lists',
    keys: [
      [['/'], 'Focus the filter'],
      [['1'], 'Doing'],
      [['2'], 'Todo'],
      [['3'], 'Active'],
      [['4'], 'Backlog'],
      [['5'], 'All'],
      [['6'], 'Recent'],
      [['7'], 'Closed'],
      [['Esc'], 'Clear the selection'],
    ],
  },
  {
    title: 'Editing',
    keys: [
      [['⌘', '↵'], 'Save'],
      [['↵'], 'Save a title or note'],
      [['Esc'], 'Discard'],
    ],
  },
]

/**
 * Shortcut reference on `?`.
 *
 * Shortcuts that are not discoverable may as well not exist — and the ones
 * here are only visible today as a small hint on one input.
 */
export const Shortcuts = () => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const inField =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)

      if (e.key === '?' && !inField) {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => setOpen(false)}
    >
      <div className="scrim absolute inset-0" aria-hidden />
      <div
        className="border-border bg-surface raised-lg enter-sheet relative w-full max-w-[26.25rem] overflow-hidden rounded-xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="border-border text-fg border-b px-5 py-3 text-ui font-medium">
          Keyboard shortcuts
        </h2>
        <div className="flex flex-col gap-4 px-5 py-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p className="text-fg-subtle mb-1.5 text-label font-medium tracking-[0.06em] uppercase">
                {group.title}
              </p>
              <ul className="flex flex-col gap-1">
                {group.keys.map(([keys, label]) => (
                  <li key={label} className="flex items-center gap-2 text-ui">
                    <span className="text-fg-muted flex-1">{label}</span>
                    {keys.map((k) => (
                      <kbd key={k} className="kbd inline-flex">{k}</kbd>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
