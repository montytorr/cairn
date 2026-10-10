/**
 * The subject page's sections. Plain module, not the client workspace: the
 * server page validates `?tab=` with `isSubjectTab`, and a function exported
 * from a client module cannot be called on the server.
 */
export const SUBJECT_TABS = ['writeup', 'todos', 'notes', 'log', 'files', 'details'] as const
export type SubjectTab = (typeof SUBJECT_TABS)[number]

export const isSubjectTab = (value: string | undefined): value is SubjectTab =>
  (SUBJECT_TABS as readonly string[]).includes(value ?? '')
