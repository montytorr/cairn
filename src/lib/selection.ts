/**
 * What one click does to a multi-selection.
 *
 * Pulled out of the component so it can be tested: the range behaviour was
 * unverifiable while it lived inside a click handler, and it was silently
 * broken for a different reason entirely — the checkbox was a `<label>`
 * wrapping an `<input>`, so every click fired twice and cancelled itself.
 */
export const applySelection = (
  selected: ReadonlySet<string>,
  ordered: readonly string[],
  id: string,
  { shiftKey, anchor }: { shiftKey: boolean; anchor: string | null },
): Set<string> => {
  const next = new Set(selected)

  if (shiftKey && anchor && anchor !== id) {
    const from = ordered.indexOf(anchor)
    const to = ordered.indexOf(id)
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from]
      // A range always selects rather than toggling each row: mixing the two
      // makes shift-click a coin toss on what you end up with.
      for (const rowId of ordered.slice(lo, hi + 1)) next.add(rowId)
      return next
    }
  }

  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
