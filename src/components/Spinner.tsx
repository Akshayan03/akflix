export default function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-zinc-400">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-zinc-700 border-t-brand" />
      {label && <p className="text-sm">{label}</p>}
    </div>
  );
}
