import { ArrowRight, FileText } from 'lucide-react';
import { GridBackdrop } from './GridBackdrop';

const STATUS = [
  { label: 'TELEGRAPH CONNECTED', tone: 'good' as const },
  { label: 'MCP READY', tone: 'good' as const },
  { label: 'BASE', tone: 'neutral' as const },
];

const toneDot: Record<string, string> = {
  good: 'bg-good',
  neutral: 'bg-ink',
};

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden border-b border-line">
      <GridBackdrop fade className="hidden md:block" />
      <div className="pointer-events-none absolute inset-y-0 left-0 hidden w-px bg-line lg:block" style={{ left: '5%' }} />
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-px bg-line lg:block" style={{ right: '5%' }} />

      <div className="relative mx-auto max-w-content px-5 pb-20 pt-20 sm:px-8 sm:pb-28 sm:pt-28">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mb-6 flex justify-center">
            <div className="border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-muted">
              Decision infrastructure for agents
            </div>
          </div>

          <h1 className="font-display text-balance text-[clamp(2.1rem,6vw,4.1rem)] font-semibold leading-[1.05] tracking-tight text-ink">
            Don&rsquo;t let an AI agent
            <br />
            act on a <span className="relative inline-block italic text-accent">
              guess
              <svg
                className="absolute -bottom-1 left-0 w-full"
                height="10"
                viewBox="0 0 200 10"
                preserveAspectRatio="none"
                aria-hidden
              >
                <path d="M1 7 Q 60 1, 100 5 T 199 4" stroke="#966B10" strokeWidth="2" fill="none" />
              </svg>
            </span>.
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-balance text-[15px] leading-relaxed text-muted sm:text-base">
            Deycid acquires the intelligence required to make a decision — then stops when
            confidence is sufficient.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#decision-lab"
              className="flex w-full items-center justify-center gap-2 border border-accent bg-accent px-6 py-3 text-[13px] font-medium uppercase tracking-wide text-paper transition-colors hover:bg-accent-dark hover:border-accent-dark sm:w-auto"
            >
              Run a live decision
              <ArrowRight size={14} strokeWidth={2} />
            </a>
            <a
              href="#mcp"
              className="flex w-full items-center justify-center gap-2 border border-line px-6 py-3 text-[13px] font-medium uppercase tracking-wide text-ink transition-colors hover:border-accent hover:text-accent sm:w-auto"
            >
              <FileText size={14} strokeWidth={2} />
              View docs
            </a>
          </div>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-muted">
            {STATUS.map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${toneDot[s.tone]}`} />
                {s.label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
