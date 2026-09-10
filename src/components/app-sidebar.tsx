import Link from 'next/link'
import { Avatar } from '@/components/icons'
import { ThemeToggle } from '@/components/theme-toggle'
import { ProjectNav } from '@/components/project-nav'
import { UserMenu } from '@/components/user-menu'

/**
 * One sidebar, two homes: the fixed rail on a wide screen and the drawer on a
 * narrow one. Extracted so the two cannot drift — a phone showing a different
 * project list from the desktop is worse than no phone support.
 */
export const AppSidebar = ({
  email,
  projects,
  onNavigate,
}: {
  email: string
  projects: { key: string; title: string }[]
  /** Closes the drawer after a tap. Absent on the desktop rail. */
  onNavigate?: () => void
}) => (
  <>
    <div className="flex h-[44px] shrink-0 items-center gap-2 px-3">
      <Avatar name={email} size={20} />
      <Link
        href="/"
        onClick={onNavigate}
        className="text-fg truncate text-[13px] font-medium"
      >
        Cairn
      </Link>
      <span className="ml-auto">
        <ThemeToggle />
      </span>
    </div>

    <ProjectNav projects={projects} onNavigate={onNavigate} />

    <UserMenu email={email} onNavigate={onNavigate} />
  </>
)
