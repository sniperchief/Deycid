import { z } from 'zod';
import type { IntentName, ScoringTier, TelegraphAskRecord } from './telegraph.js';

/**
 * How a piece of evidence bears on the proposed decision.
 * `UNCERTAIN` means Deycid's normalizer could not read a direction out of the
 * miner's output — it is not the same as `NEUTRAL`, which means the output was
 * readable and simply did not lean either way.
 */
export const EvidenceStanceSchema = z.enum(['SUPPORTS', 'CONTRADICTS', 'NEUTRAL', 'UNCERTAIN']);
export type EvidenceStance = z.infer<typeof EvidenceStanceSchema>;

/**
 * How confidently the normalizer read the miner's output.
 * HIGH  — a typed structured marker (boolean flag / numeric score) was matched.
 * MEDIUM— a recognised status string was matched.
 * LOW   — only the lexical polarity pass produced a reading.
 */
export const EvidenceQualitySchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type EvidenceQuality = z.infer<typeof EvidenceQualitySchema>;

export const EvidenceStatusSchema = z.enum(['COLLECTED', 'FAILED']);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

/**
 * A single acquired piece of intelligence, after normalization.
 *
 * Terminology note: `deycidConfidence` is computed by Deycid from observable
 * properties of the Telegraph response. Telegraph does not return a
 * per-response confidence score, so there is no "Telegraph confidence" field
 * to report here — see README, "Whose confidence is this?".
 */
export interface EvidenceItem {
  id: string;
  /** Which evidence round acquired this, 1-based. */
  round: number;
  /** The intent Deycid shaped the query to reach. */
  requestedIntent: IntentName;
  /** What Telegraph's router actually classified the query as, when reported. */
  routedIntent?: string;
  tier: ScoringTier;
  status: EvidenceStatus;
  stance: EvidenceStance;
  quality: EvidenceQuality;
  /** One-line human-readable reading of the miner's output. */
  finding: string;
  /** Named markers the normalizer matched, for auditability. */
  matchedSignals: string[];
  /** Deycid-computed reliability of this item, 0..1. */
  reliability: number;
  /** Deycid-computed relevance to this case, 0..1. */
  relevance: number;
  /** Deycid-computed freshness discount, 0..1. */
  freshness: number;
  /** reliability x relevance x freshness — this item's weight in aggregation. */
  weight: number;
  /**
   * Deycid's per-item confidence, 0..1. Equal to `weight` for directional
   * evidence; reported for display and never re-derived downstream.
   */
  deycidConfidence: number;
  /** What Telegraph charged for this item, when it reported a cost. */
  costUsd: number;
  /** The underlying Telegraph exchange. */
  source: TelegraphAskRecord;
  /** Present only when the acquisition failed. */
  error?: string;
  createdAt: string;
}

/** The confidence engine's output for a case at a point in time. */
export interface ConfidenceAssessment {
  /** Aggregate Deycid confidence, 0..1. */
  confidence: number;
  /** Which way the evidence leans overall. */
  direction: 'SUPPORT' | 'CONTRADICT' | 'NONE';
  /** Total weight of SUPPORTS evidence. */
  supportMass: number;
  /** Total weight of CONTRADICTS evidence. */
  contradictMass: number;
  /** min(S,C)/(S+C) — 0 when unanimous, 0.5 when evenly split. */
  contradictionRatio: number;
  /** Whether contradictionRatio breached the policy's tolerance. */
  materialConflict: boolean;
  /** Share of directional mass agreeing with `direction`, 0.5..1. */
  agreement: number;
  /** Saturating function of directional mass, 0..1. */
  evidenceStrength: number;
  /** Saturating function of distinct corroborating intents, 0..1. */
  corroboration: number;
  /** Count of distinct requested intents contributing directional evidence. */
  distinctIntents: number;
  /** Plain-language trace of how the number was reached. */
  rationale: string[];
}
