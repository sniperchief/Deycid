import type { ReactNode } from 'react';

interface GridBackdropProps {
  fade?: boolean;
  className?: string;
}

/** Subtle architectural-blueprint grid, meant to sit behind content, never over it. */
export function GridBackdrop({ fade = false, className = '' }: GridBackdropProps) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 ${fade ? 'bg-blueprint-fade' : 'bg-blueprint'} ${className}`}
    />
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.18em] text-muted">
      <span className="h-1.5 w-1.5 bg-ink" />
      {children}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted">{children}</div>
  );
}
