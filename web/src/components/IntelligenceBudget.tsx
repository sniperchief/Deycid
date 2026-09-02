import { ILLUSTRATIVE_BUDGET } from '../data/illustrative';
import { useDecisionRun } from '../lib/DecisionRunContext';
import { money } from '../lib/format';
import { DataBadge } from './DataBadge';
import { Eyebrow } from './GridBackdrop';

export function IntelligenceBudget() {
  const { receipt, status } = useDecisionRun();
  const isLive = Boolean(receipt);

  const allocated = receipt?.budget.allocatedUsdc ?? status?.limits.perRequestUsdc ?? ILLUSTRATIVE_BUDGET.allocated;
  const spent = receipt?.budget.spentUsdc ?? ILLUSTRATIVE_BUDGET.spent;
  const remaining = receipt?.budget.remainingUsdc ?? allocated - spent;
  const rounds = receipt?.roundsUsed ?? ILLUSTRATIVE_BUDGET.rounds;
  const maxRounds = receipt?.maxRounds ?? ILLUSTRATIVE_BUDGET.maxRounds;
  const requests = receipt?.evidence.length ?? ILLUSTRATIVE_BUDGET.requests;
  const spentPct = allocated > 0 ? (spent / allocated) * 100 : 0;

  const stats = [
    { label: 'Spent', value: money(spent) },
    { label: 'Remaining', value: money(remaining) },
    { label: 'Rounds', value: `${rounds} / ${maxRounds}` },
    { label: 'Requests', value: String(requests) },
  ];

  return (
    <section className="border-b border-line">
      <div className="mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-20">
          <div>
            <div className="flex items-center gap-3">
              <Eyebrow>Intelligence has a cost</Eyebrow>
              <DataBadge live={isLive} />
            </div>
            <h2 className="mt-3 text-balance font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-semibold leading-[1.12] tracking-tight text-ink">
              Buy intelligence only when you need it.
            </h2>
            <p className="mt-5 max-w-md text-[14.5px] leading-relaxed text-muted">
              Deycid doesn&rsquo;t blindly query everything. It progressively acquires intelligence
              until the decision is sufficiently supported — or the policy prevents further spending.
            </p>
          </div>

          <div className="border border-line p-7 sm:p-9">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Intelligence budget</div>
            <div className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">{money(allocated)}</div>

            <div className="mt-5 h-2 w-full bg-line">
              <div className="h-2 bg-accent" style={{ width: `${spentPct}%` }} />
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[10.5px] uppercase tracking-wider text-muted">
              <span>{money(spent)} spent</span>
              <span>{money(remaining)} remaining</span>
            </div>

            <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-line pt-6 sm:grid-cols-4">
              {stats.map((s) => (
                <div key={s.label}>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted">{s.label}</div>
                  <div className="mt-1 font-mono text-[15px] text-ink">{s.value}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
