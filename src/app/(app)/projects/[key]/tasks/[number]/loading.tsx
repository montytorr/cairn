/**
 * Skeleton for a task page. Mirrors the real two-column layout — body plus a
 * 220px sidebar — so the columns do not jump into place.
 */
const Loading = () => (
  <div className="flex h-dvh animate-pulse flex-col">
    <div className="border-border flex h-[44px] shrink-0 items-center gap-2 border-b px-4">
      <span className="bg-border h-2 w-10 rounded-full opacity-50" />
      <span className="bg-border h-2 w-24 rounded-full opacity-50" />
      <span className="bg-border h-2 w-40 rounded-full" />
    </div>
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-[720px]">
          <span className="bg-border mb-2 block h-5 w-4/5 rounded" />
          <span className="bg-border mb-8 block h-5 w-2/5 rounded" />
          {[92, 78, 96, 60, 88, 40].map((w, i) => (
            <span
              key={i}
              className="bg-border mb-2.5 block h-2 rounded-full opacity-50"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
      </div>
      <div className="border-border hidden w-[220px] shrink-0 flex-col gap-4 border-l px-4 py-5 lg:flex">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <span className="bg-border h-2 w-16 rounded-full opacity-40" />
            <span className="bg-border h-2.5 w-28 rounded-full opacity-60" />
          </div>
        ))}
      </div>
    </div>
  </div>
)

export default Loading
