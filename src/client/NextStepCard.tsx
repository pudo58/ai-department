import type { NextStep, StepAction } from '../core/nextstep';

/** The one thing to do next for a stopped run: what is in the way, why, and the move that gets it going. */
export function NextStepCard({ step, busy, onAction }: { step: NextStep; busy: boolean; onAction: (action: StepAction) => void }) {
  const button = (a: StepAction, primary: boolean) => (
    <button key={`${a.id}:${a.findingId ?? ''}`} className={`button${primary ? ' primary' : ''}`} disabled={busy} onClick={() => onAction(a)}>
      {a.label}{a.cost === 'ai' && <span className="faint small"> · tốn AI</span>}
    </button>
  );
  return <div className="banner warn next-step" role="status" aria-label="Việc cần làm">
    <span className="step-label">Việc cần làm</span>
    <strong className="step-title">{step.title}</strong>
    <p>{step.why}</p>
    {step.after.length > 0 && <p className="small muted">Sau đó: {step.after.join(' ')}</p>}
    <div className="row-actions">{button(step.primary, true)}{step.others.map((a) => button(a, false))}</div>
  </div>;
}
