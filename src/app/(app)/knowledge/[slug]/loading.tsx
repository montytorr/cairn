/** Mirrors the reader's own rhythm — header, meta line, prose — on the real
 *  44px header height so the frame does not jump when the page lands. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="border-border h-[44px] shrink-0 border-b" />
    <div className="mx-auto w-full max-w-[720px] animate-pulse px-4 py-6 sm:px-6">
      <div className="bg-surface-hover mb-3 h-[22px] w-3/5 rounded" />
      <div className="mb-6 flex gap-3">
        <div className="bg-surface-hover h-[12px] w-16 rounded-full opacity-60" />
        <div className="bg-surface-hover h-[12px] w-20 rounded-full opacity-60" />
        <div className="bg-surface-hover h-[12px] w-14 rounded-full opacity-60" />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="bg-surface-hover mb-2 h-[12px] rounded opacity-50"
          style={{ width: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  </div>
)

export default Loading
