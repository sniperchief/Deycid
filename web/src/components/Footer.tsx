import { GridBackdrop } from './GridBackdrop';

const LINKS = [
  { label: 'Docs', href: 'https://github.com/sniperchief/Deycid#readme' },
  { label: 'GitHub', href: 'https://github.com/sniperchief/Deycid' },
  { label: 'MCP', href: '#mcp' },
  { label: 'Telegraph', href: 'https://telegraphprotocol.com' },
];

export function Footer() {
  return (
    <footer className="relative">
      <GridBackdrop fade />
      <div className="relative mx-auto max-w-content px-5 py-12 sm:px-8">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
                <rect x="1" y="1" width="16" height="16" fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
                <rect x="5.5" y="5.5" width="7" height="7" fill="#966B10" />
              </svg>
              <span className="font-display text-[14px] font-semibold tracking-tight text-ink">DEYCID</span>
            </div>
            <p className="mt-2 max-w-xs text-[13px] leading-relaxed text-muted">
              Decision infrastructure for autonomous agents.
            </p>
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-2">
            {LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target={l.href.startsWith('http') ? '_blank' : undefined}
                rel={l.href.startsWith('http') ? 'noopener' : undefined}
                className="text-[13px] text-muted transition-colors hover:text-accent"
              >
                {l.label}
              </a>
            ))}
          </div>
        </div>

        <div className="mt-10 border-t border-line pt-6 font-mono text-[11px] uppercase tracking-wider text-muted">
          Built for Telegraph Hackathon · Base
        </div>
      </div>
    </footer>
  );
}
