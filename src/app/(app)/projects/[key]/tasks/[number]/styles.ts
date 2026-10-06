/**
 * The one label style down the task page: every panel heading and every
 * sidebar section. Six panels and eight sections had drifted between two sizes
 * and two greys, which read as eight different kinds of thing.
 */
export const LABEL = 'text-fg-subtle text-label font-medium tracking-[0.08em] uppercase'

/** The count beside a label: a small stone of its own, not a trailing digit. */
export const COUNT =
  'bg-surface-raised text-fg-muted rounded-full px-1.5 py-px text-meta leading-[1.4] font-medium tracking-normal normal-case tabular-nums'

/** A composer's shell: a flat card whose rim turns to the accent, doubled to 2px, while typing. */
export const COMPOSER =
  'surface-card overflow-hidden transition-[border-color,box-shadow] duration-[var(--dur-2)] ease-[var(--ease-out)] ' +
  'focus-within:border-accent focus-within:ring-1 focus-within:ring-accent'

/**
 * The properties column: a solid pane beside the canvas, set off by one
 * hairline down its inner edge.
 *
 * Deliberately no backdrop filter or transform: either would make this column
 * the containing block of the resolution dialog that opens from inside it.
 */
export const PANE = 'bg-bg-elevated border-border border-l'

/**
 * The sidebar's property list: a label beside its value rather than a
 * heading above it, the way Linear's panel reads. The label column is a
 * fixed width so every value starts at the same edge, and it never grows —
 * a long value truncates in its own column instead of pushing the row wide.
 */
export const ROW_LABEL = 'text-fg-subtle w-[4.75rem] shrink-0 text-meta'

/** A property row's shell: flat hover fill, ~28px tall, never wider than the pane. */
export const ROW = 'row-hover -mx-1.5 flex min-w-0 min-h-[1.75rem] items-center gap-2 rounded-md px-1.5'
