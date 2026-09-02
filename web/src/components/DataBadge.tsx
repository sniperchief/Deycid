/** Marks whether a section shows a real completed run's receipt or a labelled illustrative example. */
export function DataBadge({ live }: { live: boolean }) {
  return (
    <span
      className={`border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
        live ? 'border-good/40 text-good' : 'border-line-strong text-muted'
      }`}
    >
      {live ? 'Live result' : 'Example'}
    </span>
  );
}
