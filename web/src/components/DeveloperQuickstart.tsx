import { Check, Copy } from 'lucide-react';
import { useClipboard } from '../hooks/useClipboard';
import { GridBackdrop, Eyebrow } from './GridBackdrop';

const INSTALL_CMD = 'npm install deycid-mcp';
const META = ['MCP', 'TELEGRAPH', 'BASE', 'TYPESCRIPT'];

export function DeveloperQuickstart() {
  const { copied, copy } = useClipboard();

  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-20">
        <Eyebrow>Developer quickstart</Eyebrow>

        <div className="relative mt-5 overflow-hidden border border-line">
          <GridBackdrop className="opacity-70" />

          <div className="relative flex flex-col gap-8 p-6 sm:p-10 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Deycid MCP</div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <code className="border border-line-strong bg-paper px-4 py-3 font-mono text-[15px] text-ink sm:text-xl">
                  {INSTALL_CMD}
                </code>
                <button
                  onClick={() => copy(INSTALL_CMD)}
                  className="flex items-center gap-2 border border-accent bg-accent px-4 py-3 font-mono text-[12px] uppercase tracking-wider text-paper transition-colors hover:bg-accent-dark hover:border-accent-dark"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              <p className="mt-5 max-w-md text-[14px] leading-relaxed text-muted">
                Connect any MCP-compatible agent to Deycid&rsquo;s evidence-based decision engine.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-2 border-t border-line pt-4 font-mono text-[11px] uppercase tracking-wider text-muted md:flex-col md:border-t-0 md:border-l md:pl-6 md:pt-0">
              {META.map((m) => (
                <div key={m} className="flex items-center gap-2">
                  <span className="h-1 w-1 bg-accent" />
                  {m}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
