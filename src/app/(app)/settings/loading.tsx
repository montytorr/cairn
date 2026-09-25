const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="border-border flex h-[2.75rem] shrink-0 items-center border-b px-4">
      <span className="bg-border block h-2.5 w-16 animate-pulse rounded-full" />
    </div>
    <div className="mx-auto w-full max-w-2xl animate-pulse px-4 py-6 md:px-8 md:py-8">
      {[0, 1].map((s) => (
        <div key={s} className="mb-8">
          <span className="bg-border mb-3 block h-2 w-20 rounded-full opacity-40" />
          {[0, 1, 2].map((i) => (
            <span key={i} className="bg-border mb-2 block h-8 w-full rounded-md opacity-30" />
          ))}
        </div>
      ))}
    </div>
  </div>
)

export default Loading
