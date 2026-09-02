import { ArrowRight, Check, Copy } from 'lucide-react';
import { useClipboard } from '../hooks/useClipboard';
import { Eyebrow } from './GridBackdrop';

const SNIPPET = `deycid_evaluate_decision({
  decision: "...",
  riskTolerance: "low",
  confidenceTarget: 0.90,
  intelligenceBudget: 0.10
})`;

export function MCPSection() {
  const { copied, copy } = useClipboard();

  return (
    <section id="mcp" className="border-b border-line">
      <div className="mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <Eyebrow>MCP</Eyebrow>
            <h2 className="mt-3 text-balance font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-semibold leading-[1.12] tracking-tight text-ink">
              Give your agent a decision layer.
            </h2>
            <p className="mt-5 max-w-md text-[14.5px] leading-relaxed text-muted">
              Deycid exposes decision evaluation through MCP so autonomous agents can request
              evidence-backed decisions as part of their normal tool workflow.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="https://github.com/sniperchief/Deycid#readme"
                target="_blank"
                rel="noopener"
                className="flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 text-[13px] font-medium text-paper transition-colors hover:bg-ink/85"
              >
                View MCP docs
                <ArrowRight size={14} />
              </a>
              <button
                onClick={() => copy(SNIPPET)}
                className="flex items-center gap-2 border border-line px-5 py-2.5 text-[13px] font-medium text-ink transition-colors hover:border-ink"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy example'}
              </button>
            </div>
          </div>

          <div className="border border-line bg-ink p-6 sm:p-8">
            <div className="mb-4 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-paper/25" />
              <span className="h-2 w-2 rounded-full bg-paper/25" />
              <span className="h-2 w-2 rounded-full bg-paper/25" />
            </div>
            <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed text-paper/90">
              <code>{SNIPPET}</code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
