'use client'

import { createContext, useContext } from 'react'

/**
 * The set of real project keys, so markdown can tell a task ref (`CAI-42`)
 * apart from something that merely looks like one (`UTF-8`).
 *
 * Empty by default, which makes ref linking a no-op rather than a hazard
 * anywhere the provider is absent.
 */
const ProjectKeysContext = createContext<readonly string[]>([])

export const ProjectKeysProvider = ({
  keys,
  children,
}: {
  keys: readonly string[]
  children: React.ReactNode
}) => <ProjectKeysContext.Provider value={keys}>{children}</ProjectKeysContext.Provider>

export const useProjectKeys = () => useContext(ProjectKeysContext)
