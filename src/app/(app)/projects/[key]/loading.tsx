/**
 * Skeleton for a project list, on the real 44/34/36px rhythm so the layout
 * does not shift when content lands. On a contended host this is what the
 * first second actually looks like, which makes it worth building properly
 * rather than showing a spinner.
 */
const Row = ({ i }: { i: number }) => (
  <div className="border-border flex h-[36px] items-center gap-2 border-b px-3">
    <span className="bg-border size-3 shrink-0 rounded-sm" />
    <span className="bg-border h-2 w-[60px] shrink-0 rounded-full opacity-70" />
    <span className="bg-border size-3 shrink-0 rounded-full" />
    <span
      className="bg-border h-2 rounded-full opacity-60"
      style={{ width: `${26 + ((i * 17) % 46)}%` }}
    />
  </div>
)

const Loading = () => (
  <div className="animate-pulse">
    <div className="border-border flex h-[44px] items-center gap-2 border-b px-4">
      <span className="bg-border h-2 w-12 rounded-full opacity-50" />
      <span className="bg-border h-2.5 w-32 rounded-full" />
    </div>
    <div className="border-border flex h-[38px] items-center gap-2 border-b px-3">
      <span className="bg-border h-2 w-10 rounded-full opacity-40" />
      <span className="bg-border h-2 w-10 rounded-full opacity-40" />
      <span className="bg-border h-2 w-10 rounded-full opacity-40" />
    </div>
    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
      <Row key={i} i={i} />
    ))}
  </div>
)

export default Loading
