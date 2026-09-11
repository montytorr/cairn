/** Holds the 44px header and 42px filter bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="border-border h-[44px] shrink-0 border-b" />
    <div className="border-border h-[42px] shrink-0 border-b" />
    <div className="flex-1 animate-pulse">
      <div className="border-border bg-bg-elevated h-[30px] border-b" />
      {Array.from({ length: 9 }).map((_, i) => (
        <div key={i} className="border-border flex items-center gap-2.5 border-b px-4 py-2.5">
          <span className="bg-surface-hover h-[11px] w-[42px] shrink-0 rounded opacity-60" />
          <span className="bg-surface-hover size-[18px] shrink-0 rounded-full opacity-60" />
          <span
            className="bg-surface-hover h-[13px] rounded opacity-60"
            style={{ width: `${64 - i * 5}%` }}
          />
        </div>
      ))}
    </div>
  </div>
)

export default Loading
