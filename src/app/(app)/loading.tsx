/**
 * Shown while a server component streams. On a contended host this is what
 * the first second or two actually looks like, so it is worth more than a
 * spinner: skeleton rows on the same 32px rhythm as the real list, so the
 * layout does not jump when content lands.
 */
const Row = ({ delay }: { delay: number }) => (
  <div className="flex h-row items-center gap-2.5 px-3" style={{ animationDelay: `${delay}ms` }}>
    <span className="bg-border size-1.5 shrink-0 rounded-full" />
    <span
      className="bg-border h-2 rounded-full"
      style={{ width: `${38 + ((delay * 7) % 44)}%` }}
    />
  </div>
)

const Loading = () => (
  <div className="mx-auto max-w-3xl animate-pulse px-4 py-8 md:px-8">
    <div className="bg-border mb-3 h-5 w-28 rounded" />
    <div className="bg-border mb-8 h-2.5 w-64 rounded-full opacity-60" />
    <div className="border-border divide-border overflow-hidden rounded-md border divide-y">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <Row key={i} delay={i * 40} />
      ))}
    </div>
  </div>
)

export default Loading
