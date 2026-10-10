/** Holds the header and filter bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border h-[2.75rem] shrink-0 border-b" />
    <div className="border-border/70 flex h-[2.75rem] shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      <span className="skeleton h-7 w-16 rounded-md" />
      <span className="skeleton h-7 w-full rounded-md sm:max-w-[14rem]" />
      <span className="skeleton hidden h-7 w-20 rounded-md sm:block" />
      <span className="skeleton hidden h-7 w-20 rounded-md sm:block" />
    </div>
    <div className="flex-1 overflow-hidden">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="border-border/70 flex h-[2.5rem] items-center gap-2 border-b px-3 sm:px-4">
          <span className="min-w-0 flex-1">
            <span className="skeleton block h-2.5 rounded-full" style={{ width: `${66 - (i % 6) * 7}%` }} />
          </span>
          <span className="skeleton hidden h-[1.125rem] w-14 rounded-full opacity-70 sm:block" />
          <span className="skeleton hidden h-2 w-[2.875rem] rounded-full md:block" />
        </div>
      ))}
    </div>
  </div>
)

export default Loading
