/** Holds the 44px header and 42px filter bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="border-border h-[44px] shrink-0 border-b" />
    <div className="border-border h-[42px] shrink-0 border-b" />
    <div className="flex-1 animate-pulse">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="border-border border-b px-4 py-2.5">
          <div className="bg-surface-hover h-[13px] rounded" style={{ width: `${72 - i * 4}%` }} />
          <div className="bg-surface-hover mt-2 ml-[42px] h-[11px] w-[46%] rounded opacity-60" />
        </div>
      ))}
    </div>
  </div>
)

export default Loading
