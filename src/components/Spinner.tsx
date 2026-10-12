export default function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center gap-3 py-10 text-zinc-400">
      <div className="ak-spinner h-9 w-9" aria-hidden="true" />
      <p className={label ? "text-sm" : "sr-only"}>{label ?? "Loading"}</p>
    </div>
  );
}
