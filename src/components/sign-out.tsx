'use client'

import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@supabase/ssr'
import { useSupabaseConfig } from '@/components/supabase-provider'

export const SignOut = () => {
  const router = useRouter()
  const { url, anonKey } = useSupabaseConfig()

  return (
    <button
      type="button"
      onClick={async () => {
        await createBrowserClient(url, anonKey).auth.signOut()
        router.replace('/login')
        router.refresh()
      }}
      className="text-fg-subtle hover:text-fg transition-colors"
    >
      Sign out
    </button>
  )
}
