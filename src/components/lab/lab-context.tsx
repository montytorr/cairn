'use client'

import { createContext, useContext } from 'react'

/**
 * Whether the Lab is on, from the layout, for the parts of the app that are
 * not Lab pages: the sidebar's entry and the markdown linkifier. Off unless a
 * provider says otherwise, so nothing lab-shaped appears by accident.
 */
const LabContext = createContext(false)

export const LabProvider = ({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) => <LabContext.Provider value={enabled}>{children}</LabContext.Provider>

export const useLabEnabled = () => useContext(LabContext)
