/** Holds the header, the title block and the tab bar so the frame does not jump. */
const Loading = () => (
  <div className="flex h-dvh flex-col">
    <div className="page-header border-border h-[2.75rem] shrink-0 border-b" />
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 px-4 pt-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[51.25rem]">
          <span className="skeleton mb-3 block h-4 w-48 rounded-full" />
          <span className="skeleton mb-6 block h-7 w-2/3 rounded-md" />
          <span className="skeleton mb-2 block h-3 w-full rounded-full opacity-70" />
          <span className="skeleton mb-2 block h-3 w-11/12 rounded-full opacity-70" />
          <span className="skeleton block h-3 w-3/4 rounded-full opacity-70" />
        </div>
      </div>
      <div className="bg-bg-elevated border-border hidden w-[18rem] shrink-0 border-l lg:block" />
    </div>
  </div>
)

export default Loading
