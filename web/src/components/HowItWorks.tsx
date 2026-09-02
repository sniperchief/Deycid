import { Eyebrow } from './GridBackdrop';

const STEPS = [
  {
    n: '01',
    title: 'Define',
    body: 'Set the decision, risk tolerance, confidence target and intelligence budget.',
  },
  {
    n: '02',
    title: 'Acquire',
    body: 'Deycid requests the intelligence required from Telegraph.',
  },
  {
    n: '03',
    title: 'Evaluate',
    body: 'Evidence is accumulated and confidence is recalculated.',
  },
  {
    n: '04',
    title: 'Decide',
    body: 'The agent receives APPROVE, REJECT, or INSUFFICIENT EVIDENCE.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-b border-line">
      <div className="mx-auto max-w-content px-5 py-16 sm:px-8 sm:py-24">
        <Eyebrow>How it works</Eyebrow>
        <h2 className="mt-3 font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-semibold tracking-tight text-ink">
          Four steps, every time.
        </h2>

        <div className="mt-14 grid divide-y divide-line border-y border-line sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
          {STEPS.map((s) => (
            <div key={s.n} className="px-1 py-8 sm:px-7">
              <div className="font-mono text-sm text-accent">{s.n}</div>
              <div className="mt-4 font-display text-lg font-semibold tracking-tight text-ink">{s.title}</div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
