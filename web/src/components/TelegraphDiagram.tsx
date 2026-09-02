import { Eyebrow, GridBackdrop } from './GridBackdrop';

const NODES = ['DEYCID', 'TELEGRAPH ENGINE', 'INTENT ROUTING', 'RANKED MINERS', 'VERIFIED INTELLIGENCE'];
const CONNECTOR_TAGS = ['INTENT', 'ROUTING', 'VALIDATION', 'x402'];

export function TelegraphDiagram() {
  return (
    <section className="relative border-b border-line">
      <GridBackdrop fade />
      <div className="relative mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-24">
        <Eyebrow>Infrastructure</Eyebrow>
        <h2 className="mt-3 max-w-xl font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-semibold leading-[1.12] tracking-tight text-ink">
          Powered by Telegraph intelligence.
        </h2>

        <div className="mx-auto mt-16 flex max-w-sm flex-col items-center">
          {NODES.map((label, i) => (
            <div key={label} className="flex w-full flex-col items-center">
              <div className="w-full border border-line bg-paper px-6 py-3.5 text-center">
                <span className="font-mono text-[12.5px] font-medium uppercase tracking-[0.12em] text-ink">
                  {label}
                </span>
              </div>
              {i < NODES.length - 1 && (
                <div className="flex flex-col items-center py-3">
                  <div className="h-6 w-px bg-line-strong" />
                  <div className="my-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                    {CONNECTOR_TAGS[i]}
                  </div>
                  <div className="h-6 w-px bg-line-strong" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
