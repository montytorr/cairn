import { refuseLabDisabled } from './lab-settings'
import { noSuchSubject, resolveSubject, type Subject } from './subjects'

/**
 * The first lines of every `/subjects/[ref]/…` route: the Lab must be on, and
 * the ref must name a subject. Either the subject, or the response to send.
 */
export const subjectForRoute = async (ref: string): Promise<{ subject: Subject } | { response: Response }> => {
  const disabled = await refuseLabDisabled()
  if (disabled) return { response: disabled }
  const subject = await resolveSubject(ref)
  return subject ? { subject } : { response: noSuchSubject(ref) }
}
