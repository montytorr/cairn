const Loading = () => (
  <div className="mx-auto max-w-2xl animate-pulse px-8 py-8">
    <span className="bg-border mb-2 block h-6 w-32 rounded" />
    <span className="bg-border mb-8 block h-2 w-48 rounded-full opacity-50" />
    {[0, 1].map((s) => (
      <div key={s} className="mb-8">
        <span className="bg-border mb-3 block h-2 w-20 rounded-full opacity-40" />
        {[0, 1, 2].map((i) => (
          <span key={i} className="bg-border mb-2 block h-8 w-full rounded-md opacity-30" />
        ))}
      </div>
    ))}
  </div>
)

export default Loading
