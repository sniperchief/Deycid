import { createContext, useContext, type ReactNode } from 'react';
import { useLiveDecision, type UseLiveDecision } from '../hooks/useLiveDecision';

const DecisionRunCtx = createContext<UseLiveDecision | null>(null);

export function DecisionRunProvider({ children }: { children: ReactNode }) {
  const value = useLiveDecision();
  return <DecisionRunCtx.Provider value={value}>{children}</DecisionRunCtx.Provider>;
}

/** The single live decision run shared across the Decision Lab and the concept-explainer sections below it. */
export function useDecisionRun(): UseLiveDecision {
  const ctx = useContext(DecisionRunCtx);
  if (!ctx) throw new Error('useDecisionRun must be used within DecisionRunProvider');
  return ctx;
}
