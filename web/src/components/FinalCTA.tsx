import { GridBackdrop } from './GridBackdrop';

export function FinalCTA() {
  return (
    <section className="relative border-b border-line">
      <GridBackdrop fade />
      <div className="relative mx-auto max-w-content px-5 py-20 text-center sm:px-8 sm:py-28">
        <h2 className="mx-auto max-w-2xl text-balance font-display text-[clamp(1.9rem,4.4vw,3rem)] font-semibold leading-[1.1] tracking-tight text-ink">
          Before your agent acts,
          <br />
          make it earn the confidence.
        </h2>
        <p className="mx-auto mt-5 max-w-md text-[14.5px] leading-relaxed text-muted">
          Connect Deycid to your agent and let it acquire the intelligence required to make better
          decisions.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href="#decision-lab"
            className="w-full border border-accent bg-accent px-7 py-3 text-[13px] font-medium uppercase tracking-wide text-paper transition-colors hover:bg-accent-dark hover:border-accent-dark sm:w-auto"
          >
            Try Deycid
          </a>
          <a
            href="#mcp"
            className="w-full border border-line px-7 py-3 text-[13px] font-medium uppercase tracking-wide text-ink transition-colors hover:border-accent hover:text-accent sm:w-auto"
          >
            View docs
          </a>
        </div>
      </div>
    </section>
  );
}
