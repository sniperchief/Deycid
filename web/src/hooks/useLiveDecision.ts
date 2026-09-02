import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchStatus,
  runDecision,
  type DecisionReceipt,
  type RiskTolerance,
  type StatusResponse,
} from '../lib/api';

export type StreamKind = 'start' | 'progress' | 'evidence' | 'verdict' | 'error';

export interface StreamEntry {
  id: string;
  kind: StreamKind;
  text: string;
  /** Wall-clock time this browser received the event, HH:MM:SS. Omitted for staggered evidence reveal, which has no per-row arrival time of its own. */
  time?: string;
}

export type RunPhase = 'idle' | 'running' | 'done' | 'error';

function nowTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const STANCE_LABEL: Record<string, string> = {
  SUPPORTS: 'SUPPORTS',
  CONTRADICTS: 'CONTRADICTS',
  NEUTRAL: 'NEUTRAL',
  UNCERTAIN: 'UNCERTAIN',
};

export function useLiveDecision() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [scenarioId, setScenarioId] = useState<string>('');
  const [riskTolerance, setRiskTolerance] = useState<RiskTolerance>('medium');

  const [phase, setPhase] = useState<RunPhase>('idle');
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [receipt, setReceipt] = useState<DecisionReceipt | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const push = useCallback((kind: StreamKind, text: string, withTime = true) => {
    const id = crypto.randomUUID();
    setEntries((prev) => [...prev, { id, kind, text, ...(withTime ? { time: nowTime() } : {}) }]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchStatus()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        setScenarioId((current) => current || s.scenarios[0]?.id || '');
      })
      .catch(() => {
        if (!cancelled) setStatusError('Could not reach the demo server.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      revealTimers.current.forEach(clearTimeout);
    },
    [],
  );

  const run = useCallback(() => {
    if (!scenarioId || phase === 'running') return;

    abortRef.current?.abort();
    revealTimers.current.forEach(clearTimeout);
    revealTimers.current = [];

    const controller = new AbortController();
    abortRef.current = controller;

    setEntries([]);
    setReceipt(null);
    setRunError(null);
    setPhase('running');

    void runDecision(
      { scenario: scenarioId, riskTolerance },
      {
        onStart: (d) => {
          push('start', `Evaluating "${d.decision}" — budget $${d.budgetUsdc.toFixed(3)}, risk ${d.riskTolerance}`);
        },
        onProgress: (d) => {
          push('progress', d.message);
        },
        onFailed: (d) => {
          push('error', `${d.code}: ${d.message}`);
          setRunError(d.message);
          setPhase('error');
        },
        onDone: (d) => {
          push('evidence', 'Aggregating evidence', true);
          d.receipt.evidence.forEach((ev, i) => {
            const t = setTimeout(
              () => {
                const stance = STANCE_LABEL[ev.stance] ?? ev.stance;
                push(
                  'evidence',
                  `${ev.requestedIntent} · ${stance} · confidence ${Math.round(ev.deycidConfidence * 100)}%`,
                  false,
                );
                if (i === d.receipt.evidence.length - 1) {
                  const t2 = setTimeout(() => {
                    push('verdict', `VERDICT: ${d.receipt.verdict}`);
                    setReceipt(d.receipt);
                    setPhase('done');
                  }, 400);
                  revealTimers.current.push(t2);
                }
              },
              260 * (i + 1),
            );
            revealTimers.current.push(t);
          });
          if (d.receipt.evidence.length === 0) {
            push('verdict', `VERDICT: ${d.receipt.verdict}`);
            setReceipt(d.receipt);
            setPhase('done');
          }
        },
      },
      controller.signal,
    ).catch((err: unknown) => {
      if (controller.signal.aborted) return;
      const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Run failed.';
      push('error', message);
      setRunError(message);
      setPhase('error');
    });
  }, [scenarioId, riskTolerance, phase, push]);

  return {
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
  };
}

export type UseLiveDecision = ReturnType<typeof useLiveDecision>;
