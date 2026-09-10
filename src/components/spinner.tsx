/**
 * A spinner sized to sit in a line of text, so it can go inside a button
 * label without shifting it. `currentColor` so it inherits whatever it is
 * placed on, rather than needing a variant per surface.
 */
export const Spinner = ({ size = 13 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    className="shrink-0 animate-spin"
    aria-hidden
  >
    <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.75" opacity="0.25" fill="none" />
    <path
      d="M8 1.75A6.25 6.25 0 0 1 14.25 8"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      fill="none"
    />
  </svg>
)
