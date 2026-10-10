import type { PlanStatus } from '../adapters/types.ts';
import { PLAN_NAMES, seatUsage, type PlanKind } from '../plan.ts';
import { useServices } from '../ui/context.tsx';
import { Badge, Loading, Notice, PageTitle } from '../ui/components.tsx';
import { Link } from '../ui/router.tsx';
import { useWorkspace } from '../ui/workspace-context.tsx';

/** Plan page: the workspace's Free, Beta or Pro plan as the backend wrote it. Paid plans are coming soon (no prices, nothing to buy). */
export function BillingPage() {
  const data = useWorkspace();
  return (
    <>
      <PageTitle title="Plan"><p>The SaySpec plan for {data.scope.name}.</p></PageTitle>
      {data.billing.status === 'loading' && <Loading label="Loading plan…" />}
      {data.billing.status === 'error' && <Notice tone="error" title="The plan could not be loaded.">{data.billing.message}</Notice>}
      {data.billing.status === 'ready' && <PlanPanel plan={data.billing.data} />}
      {(data.billing.status !== 'ready' || data.billing.data.kind !== 'pro') && (
        <section className="panel paid-plans" aria-labelledby="paid-heading">
          <div className="panel-head">
            <h2 id="paid-heading">Paid plans</h2>
            <Badge tone="accent">Coming soon</Badge>
          </div>
          <p className="muted">Paid plans for larger teams are coming soon. Pricing will be shared here before they launch. There is nothing to buy or set up yet.</p>
        </section>
      )}
    </>
  );
}

export function useSeatUsage() {
  const data = useWorkspace();
  if (data.members.status !== 'ready' || data.billing.status !== 'ready') return null;
  return seatUsage(data.members.data.filter((member) => member.status === 'active').length, data.billing.data.seatLimit);
}

const PLAN_DETAILS: Record<PlanKind, { summary: string; storage: string; note?: string }> = {
  free: {
    summary: 'No payment details are needed.',
    storage: 'Tests are stored on each computer or in a folder you choose',
    note: 'Beta adds Pro features such as SaySpec Cloud test storage. During the beta, the SaySpec team grants Beta access.',
  },
  beta: {
    summary: 'Your workspace is in the SaySpec Beta: every Pro feature, free while the beta lasts. No payment details are needed.',
    storage: 'SaySpec Cloud test storage for Web projects',
  },
  pro: {
    summary: 'Your workspace is on the Pro plan, with every Pro feature.',
    storage: 'SaySpec Cloud test storage for Web projects',
  },
};

function PlanPanel({ plan }: { plan: PlanStatus }) {
  const services = useServices();
  const seats = useSeatUsage();
  const details = PLAN_DETAILS[plan.kind];
  return (
    <section className="panel plan-card" aria-labelledby="plan-heading">
      <div className="plan-head">
        <div>
          <p className="choice-kicker">Current plan</p>
          <h2 id="plan-heading">{PLAN_NAMES[plan.kind]}{plan.kind === 'beta' && <Badge tone="success">Pro features</Badge>}</h2>
        </div>
        {services.billing.provider === 'fixture' && <Badge tone="warning">Demo data</Badge>}
      </div>
      <p>{details.summary}</p>
      <ul className="plan-points">
        <li>Up to {plan.seatLimit} seats, including the owner</li>
        <li>Testers join with your company code from the desktop app</li>
        <li>{details.storage}</li>
      </ul>
      {details.note && <p className="muted">{details.note}</p>}
      <SeatMeter />
      {seats?.over && <Notice tone="warning" title="Over the seat limit">{seats.used} members are active, more than the {seats.limit}-seat limit. Nobody is removed automatically, but no one new can join until members are removed.</Notice>}
      {seats?.full && !seats.over && <Notice tone="warning" title={`All ${seats.limit} seats are in use.`}>To add someone, <Link to="/portal/team">remove a member in Team</Link> first.</Notice>}
    </section>
  );
}

export function SeatMeter() {
  const seats = useSeatUsage();
  if (!seats) return <Loading label="Counting seats…" />;
  const percent = Math.min(100, Math.round((seats.used / seats.limit) * 100));
  return (
    <div className="seat-meter">
      <div className="seat-meter-label"><strong>{seats.used} of {seats.limit} seats used</strong><span className="muted">{seats.remaining} left</span></div>
      <div className={`seat-meter-bar${seats.full ? ' is-full' : ''}`} role="meter" aria-label="Seats used" aria-valuemin={0} aria-valuemax={seats.limit} aria-valuenow={seats.used} aria-valuetext={`${seats.used} of ${seats.limit} seats used`}>
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
