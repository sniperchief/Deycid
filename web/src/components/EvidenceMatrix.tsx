import { ILLUSTRATIVE_EVIDENCE } from '../data/illustrative';
import { useDecisionRun } from '../lib/DecisionRunContext';
import { money, pct } from '../lib/format';
import { DataBadge } from './DataBadge';
import { Eyebrow } from './GridBackdrop';

export function EvidenceMatrix() {
  const { receipt } = useDecisionRun();
  const isLive = Boolean(receipt);

  const rows = receipt
    ? receipt.evidence.map((e) => ({
        intent: e.requestedIntent,
        finding: e.finding,
        confidence: e.deycidConfidence,
        cost: e.costUsd,
        status: 'VERIFIED',
      }))
    : ILLUSTRATIVE_EVIDENCE;

  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-20">
        <div className="flex items-center gap-3">
          <Eyebrow>Evidence matrix</Eyebrow>
          <DataBadge live={isLive} />
        </div>
        <h2 className="mt-3 font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          Every finding, priced and verified.
        </h2>

        <div className="relative mt-8 border border-line">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse font-mono text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wider text-muted">
                  <th className="px-4 py-3 font-medium sm:px-6">Intent</th>
                  <th className="px-4 py-3 font-medium sm:px-6">Finding</th>
                  <th className="px-4 py-3 font-medium sm:px-6">Confidence</th>
                  <th className="px-4 py-3 font-medium sm:px-6">Cost</th>
                  <th className="px-4 py-3 font-medium sm:px-6">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={`${row.intent}-${i}`} className={i !== rows.length - 1 ? 'border-b border-line' : ''}>
                    <td className="px-4 py-3 text-ink sm:px-6">{row.intent}</td>
                    <td className="px-4 py-3 text-muted sm:px-6">{row.finding}</td>
                    <td className="px-4 py-3 text-ink sm:px-6">{pct(row.confidence)}</td>
                    <td className="px-4 py-3 text-muted sm:px-6">{money(row.cost)}</td>
                    <td className="px-4 py-3 sm:px-6">
                      <span className="inline-flex items-center gap-1.5 text-good">
                        <span className="h-1.5 w-1.5 rounded-full bg-good" />
                        {row.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-paper to-transparent sm:hidden"
          />
        </div>
      </div>
    </section>
  );
}
