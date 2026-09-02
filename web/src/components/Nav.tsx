import { Github } from 'lucide-react';

const LINKS = [
  { label: 'Product', href: '#product' },
  { label: 'How it works', href: '#how-it-works' },
  { label: 'MCP', href: '#mcp' },
  { label: 'Docs', href: 'https://github.com/sniperchief/Deycid#readme' },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-content items-center justify-between px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5">
          <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0" aria-hidden>
            <rect x="1" y="1" width="16" height="16" fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
            <rect x="5.5" y="5.5" width="7" height="7" fill="#0A0A0A" />
          </svg>
          <span className="font-display text-[15px] font-semibold tracking-tight text-ink">DEYCID</span>
        </a>

        <nav className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className="text-[13px] text-muted transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <a
            href="https://github.com/sniperchief/Deycid"
            target="_blank"
            rel="noopener"
            aria-label="GitHub"
            className="hidden items-center justify-center border border-line p-2 text-ink transition-colors hover:border-ink sm:flex"
          >
            <Github size={15} strokeWidth={1.75} />
          </a>
          <a
            href="#decision-lab"
            className="border border-ink bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-ink/85"
          >
            Try Deycid
          </a>
        </div>
      </div>
    </header>
  );
}
