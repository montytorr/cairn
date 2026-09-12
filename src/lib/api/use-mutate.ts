'use client'

import { useCallback } from 'react'
import { useNotify } from '@/components/toast'
import { mutate, type Mutation } from './mutate'

/**
 * `mutate`, with the failure shown to the person who caused it.
 *
 * Use this where the control has nowhere of its own to put an error — a
 * dropdown, a dragged card, a menu item. Where a component already has an
 * error line, call `mutate` directly and render the message there rather than
 * saying it twice.
 */
export const useMutate = () => {
  const notify = useNotify()

  return useCallback(
    async <T = unknown>(
      url: string,
      init: Parameters<typeof mutate>[1],
    ): Promise<Mutation<T>> => {
      const result = await mutate<T>(url, init)
      if (!result.ok) notify(result.error)
      return result
    },
    [notify],
  )
}
