import Link from 'next/link'
import { EmptyState } from '@/components/empty-state'

const NotFound = () => (
  <div className="flex h-dvh flex-col items-center justify-center px-6">
    <EmptyState
      as="h1"
      title={<span className="text-fg text-[1.125rem]">Nothing here.</span>}
      hint="That task or project does not exist, or it was deleted."
      action={
        <Link
          href="/"
          className="border-border bg-surface text-fg hover:bg-surface-raised hover:border-border-strong inline-flex h-8 items-center rounded-md border px-3.5 text-ui font-medium shadow-[var(--shadow-sm)] transition-[color,background-color,border-color] duration-[var(--dur-1)] ease-[var(--ease-out)]"
        >
          Back to all tasks
        </Link>
      }
    />
  </div>
)

export default NotFound
