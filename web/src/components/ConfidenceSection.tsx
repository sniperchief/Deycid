import { ILLUSTRATIVE_CONFIDENCE_FINAL, ILLUSTRATIVE_CONFIDENCE_TARGET, ILLUSTRATIVE_EVIDENCE } from '../data/illustrative';
import { useDecisionRun } from '../lib/DecisionRunContext';
import { pct } from '../lib/format';
import { DataBadge } from './DataBadge';
import { Eyebrow } from './GridBackdrop';

export function ConfidenceSection() {
  const { receipt } = useDecisionRun();

  const isLive = Boolean(receipt);
  const target = receipt?.confidenceTarget ?? ILLUSTRATIVE_CONFIDENCE_TARGET;
  const final = receipt?.deycidConfidence ?? ILLUSTRATIVE_CONFIDENCE_FINAL;
  const rows = receipt
    ? receipt.evidence.map((e) => ({ intent: e.requestedIntent, confidence: e.deycidConfidence }))
    : ILLUSTRATIVE_EVIDENCE.map((e) => ({ intent: e.intent, confidence: e.confidence }));
  const statusLabel = isLive ? receipt!.verdict : 'threshold reached';

  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-24">
        <div className="flex items-center justify-between gap-4">
          <Eyebrow>Confidence, not volume</Eyebrow>
          <DataBadge live={isLive} />
        </div>
        <h2 className="mt-3 max-w-2xl text-balance font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-semibold leading-[1.12] tracking-tight text-ink">
          More information isn&rsquo;t the goal.
          <br />
          Enough information is.
        </h2>

        <div className="mt-14 grid gap-12 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          {/* Scale */}
          <div>
            <div className="relative mt-10 h-px w-full bg-line-strong">
              <div className="absolute -top-1.5 h-4 w-px bg-ink" style={{ left: `${target * 100}%` }} />
              <div className="absolute -top-9 -translate-x-1/2 text-center" style={{ left: `${target * 100}%` }}>
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink">Target</div>
              </div>
              <div
                className="absolute top-2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-ink bg-paper"
                style={{ left: `${Math.min(100, final * 100)}%` }}
              />
              <div className="absolute -top-1.5 left-0 h-3 w-px bg-line-strong" />
              <div className="absolute -top-1.5 right-0 h-3 w-px bg-line-strong" />
            </div>
            <div className="mt-3 flex justify-between font-mono text-[11px] text-muted">
              <span>0%</span>
              <span>100%</span>
            </div>

            <div className="mt-14">
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Evidence acquired</div>
              <div className="mt-4 divide-y divide-line border-y border-line">
                {rows.map((row) => (
                  <div key={row.intent} className="flex items-center justify-between py-2.5">
                    <span className="font-mono text-[12.5px] text-ink">{row.intent}</span>
                    <span className="font-mono text-[12.5px] text-muted">{pct(row.confidence)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Result */}
          <div className="flex flex-col justify-center border border-line p-8 sm:p-10">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Confidence</div>
            <div className="mt-2 font-display text-[clamp(3.5rem,7vw,5rem)] font-semibold leading-none tracking-tight text-ink">
              {pct(final)}
            </div>
            <div className="mt-6 flex items-center gap-2 border-t border-line pt-5">
              <span className={`h-1.5 w-1.5 rounded-full ${final >= target ? 'bg-good' : 'bg-warn'}`} />
              <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-ink">
                Status: {statusLabel.toLowerCase()}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
