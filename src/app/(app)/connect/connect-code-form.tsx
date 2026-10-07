'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input } from '@/components/ui/control'

/** Loose on input — letters, digits, and an optional dash the CLI already prints for people. */
const CODE_SHAPE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/

export const ConnectCodeForm = () => {
  const router = useRouter()
  const [code, setCode] = useState('')

  const valid = CODE_SHAPE.test(code.trim())

  const go = (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid) return
    router.push(`/connect/${encodeURIComponent(code.trim())}`)
  }

  return (
    <form onSubmit={go} className="surface-card enter-rise w-full max-w-[22rem] px-6 py-6">
      <h1 className="text-fg text-[1.125rem] font-medium">Connect a device</h1>
      <p className="text-fg-subtle mt-1.5 text-ui leading-relaxed">
        Enter the code shown by the CLI.
      </p>
      <Input
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        autoFocus
        maxLength={9}
        className="mt-4 text-center tracking-[0.2em] tabular-nums"
      />
      <Button type="submit" variant="primary" disabled={!valid} className="mt-3 w-full">
        Continue
      </Button>
    </form>
  )
}
