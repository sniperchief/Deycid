import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import { useDecisionRun } from '../lib/DecisionRunContext';
import { networkLabel, RISK_CONFIDENCE_TARGET, type RiskTolerance } from '../lib/api';
import { money, pct } from '../lib/format';
import { Eyebrow, GridBackdrop } from './GridBackdrop';

const KIND_STYLE: Record<string, string> = {
  start: 'text-muted',
  progress: 'text-ink',
  evidence: 'text-good',
  verdict: 'text-good font-semibold',
  error: 'text-bad',
};

const RISK_OPTIONS: RiskTolerance[] = ['low', 'medium', 'high'];

export function DecisionLab() {
  const lab = useDecisionRun();
  const {
    status,
    statusError,
    scenarioId,
    setScenarioId,
    riskTolerance,
    setRiskTolerance,
    phase,
    entries,
    receipt,
    runError,
    run,
  } = lab;
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [entries]);

  const target = RISK_CONFIDENCE_TARGET[riskTolerance];
  const confidence = receipt?.deycidConfidence ?? null;
  const spent = receipt?.budget.spentUsdc ?? 0;
  const budgetAllocated = status?.limits.perRequestUsdc ?? receipt?.budget.allocatedUsdc ?? 0;
  const verdictText = receipt ? receipt.verdict : null;
  const verdictTone =
    verdictText === 'APPROVE' ? 'bg-good' : verdictText === 'REJECT' ? 'bg-bad' : 'bg-warn';

  const statusDotClass =
    phase === 'running' ? 'animate-pulse bg-warn' : phase === 'done' ? 'bg-good' : phase === 'error' ? 'bg-bad' : 'bg-line-strong';
  const statusText =
    phase === 'running' ? 'In progress' : phase === 'done' ? 'Complete' : phase === 'error' ? 'Failed' : 'Standing by';

  const buttonDisabled = phase === 'running' || !status || !scenarioId;
  const buttonLabel = !status && !statusError ? 'Loading…' : phase === 'running' ? 'Running…' : phase === 'idle' ? 'Run decision' : 'Run again';

  return (
    <section id="decision-lab" className="relative border-b border-line">
      <GridBackdrop className="opacity-60" />
      <div className="relative mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-24">
        <Eyebrow>Try a decision</Eyebrow>
        <h2 className="mt-3 max-w-xl font-display text-[clamp(1.6rem,3.4vw,2.4rem)] font-semibold tracking-tight text-ink">
          Watch Deycid acquire intelligence until the evidence is sufficient to act.
        </h2>

        <div className="mt-10 grid border border-line bg-paper md:grid-cols-2">
          {/* LEFT: decision spec */}
          <div className="border-b border-line p-6 sm:p-8 md:border-b-0 md:border-r">
            <label htmlFor="scenario" className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
              Decision
            </label>
            <select
              id="scenario"
              value={scenarioId}
              disabled={!status || phase === 'running'}
              onChange={(e) => setScenarioId(e.target.value)}
              className="mt-2 w-full border border-line bg-paper px-3 py-2.5 text-[15px] font-medium text-ink disabled:opacity-60"
            >
              {status?.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              {!status && <option>Loading scenarios…</option>}
            </select>

            <dl className="mt-6 divide-y divide-line border-y border-line">
              <div className="flex items-center justify-between py-2.5">
                <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">Network</dt>
                <dd className="font-mono text-[13px] text-ink">{status ? networkLabel(status.network) : '—'}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">Risk policy</dt>
                <dd className="flex gap-1">
                  {RISK_OPTIONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      disabled={phase === 'running'}
                      onClick={() => setRiskTolerance(r)}
                      className={`border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed ${
                        riskTolerance === r ? 'border-accent bg-accent text-paper' : 'border-line text-muted hover:border-accent hover:text-accent'
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">Confidence target</dt>
                <dd className="font-mono text-[13px] text-ink">{pct(target)}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">Intelligence budget</dt>
                <dd className="font-mono text-[13px] text-ink">{status ? money(status.limits.perRequestUsdc) : '—'}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="font-mono text-[11px] uppercase tracking-wider text-muted">Max rounds</dt>
                <dd className="font-mono text-[13px] text-ink">{status ? status.maxRounds : '—'}</dd>
              </div>
            </dl>

            <button
              onClick={run}
              disabled={buttonDisabled}
              className="mt-7 w-full border border-accent bg-accent py-3 font-mono text-[12px] font-medium uppercase tracking-[0.15em] text-paper transition-colors hover:bg-accent-dark hover:border-accent-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {buttonLabel}
            </button>

            {statusError && <p className="mt-3 font-mono text-[11px] text-bad">{statusError}</p>}
            {status && (
              <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-muted">
                Paying from {status.agentAddress.slice(0, 8)}…{status.agentAddress.slice(-4)} · {money(status.remainingToday)} left
                today of {money(status.limits.dailyUsdc)} · {status.limits.perVisitorPerHour} runs/hour
              </p>
            )}
          </div>

          {/* RIGHT: live evaluation */}
          <div className="flex flex-col">
            <div className="flex items-center justify-between border-b border-line px-6 py-3 sm:px-8">
              <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">Live evaluation</span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
                {statusText}
              </span>
            </div>

            <div
              ref={streamRef}
              className="stream-scroll min-h-[260px] flex-1 overflow-y-auto px-6 py-5 font-mono text-[12.5px] leading-relaxed sm:px-8"
            >
              {entries.length === 0 && (
                <div className="text-muted">
                  Press &ldquo;Run decision&rdquo; to start a real evaluation — every request here pays a real
                  Telegraph miner.
                </div>
              )}
              <AnimatePresence initial={false}>
                {entries.map((e) => (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="flex gap-3 py-0.5"
                  >
                    {e.time && <span className="shrink-0 text-muted">{e.time}</span>}
                    <span className={KIND_STYLE[e.kind]}>{e.text}</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {runError && phase === 'error' && (
                <div className="mt-2 border border-bad/30 bg-bad/5 px-3 py-2 font-mono text-[11.5px] text-bad">{runError}</div>
              )}
            </div>

            <div className="grid grid-cols-2 divide-x divide-line border-t border-line">
              <div className="px-6 py-4 sm:px-8">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted">Confidence</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <motion.span
                    key={confidence ?? -1}
                    initial={{ opacity: 0.4 }}
                    animate={{ opacity: 1 }}
                    className="font-display text-2xl font-semibold text-ink"
                  >
                    {confidence !== null ? pct(confidence) : '—'}
                  </motion.span>
                  <span className="font-mono text-[11px] text-muted">target {pct(receipt?.confidenceTarget ?? target)}</span>
                </div>
                <div className="mt-2 h-1 w-full bg-line">
                  <motion.div
                    className={`h-1 ${confidence !== null && confidence >= (receipt?.confidenceTarget ?? target) ? 'bg-good' : 'bg-accent'}`}
                    animate={{ width: `${Math.min(100, (confidence ?? 0) * 100)}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
              </div>
              <div className="px-6 py-4 sm:px-8">
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted">Spent</div>
                <div className="mt-1 font-display text-2xl font-semibold text-ink">{money(spent)}</div>
                <div className="mt-1 font-mono text-[11px] text-muted">of {money(budgetAllocated)} budget</div>
              </div>
            </div>

            {verdictText && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={`flex items-center justify-between border-t border-line px-6 py-4 sm:px-8 ${verdictTone}`}
              >
                <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-paper/70">Verdict</span>
                <span className="font-display text-xl font-semibold tracking-wide text-paper">{verdictText}</span>
              </motion.div>
            )}
          </div>
        </div>

        <p className="mt-4 max-w-2xl font-mono text-[11.5px] leading-relaxed text-muted">
          This is Deycid&rsquo;s live engine, not a simulation — every run above spends real USDC on real Telegraph
          miners from a rate-limited demo wallet. The concept sections below reflect this run once it completes.
        </p>
      </div>
    </section>
  );
}
