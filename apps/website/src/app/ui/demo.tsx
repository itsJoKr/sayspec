import { useEffect, useState } from 'react';
import type { FixtureState, TeamScenario } from '../fixtures/controls.ts';
import { useServices } from './context.tsx';

// Development-fixture controls. They render only in `--mode fixtures` builds;
// production compiles `__PORTAL_FIXTURES__` to false and never shows them.

const TEAM_SCENARIOS: Array<[TeamScenario, string]> = [['normal', 'Members'], ['empty', 'Only you'], ['loading', 'Loading'], ['error', 'Load failure']];

const JOIN_RESULTS = {
  joined: 'A tester joined with the company code.',
  'joining-off': 'Joining is off, so the code was rejected.',
  full: 'All seats are used, so the code was rejected.',
} as const;

export function DemoAccounts() {
  const services = useServices();
  if (!__PORTAL_FIXTURES__ || !services.fixtures) return null;
  return (
    <aside className="demo-box" aria-label="Demo accounts">
      <strong>Demo data · development fixtures</strong>
      <p>Every demo account uses the password <code>{services.fixtures.demoPassword}</code>. Nothing here reaches Firebase.</p>
      <ul>{services.fixtures.demoAccounts.map((account) => <li key={account.email}><code>{account.email}</code> — {account.label}</li>)}</ul>
    </aside>
  );
}

export function DemoPanel({ organizationId, uid }: { organizationId: string | null; uid: string }) {
  const services = useServices();
  const fixtures = services.fixtures;
  const [state, setState] = useState<FixtureState | null>(null);
  const [joinResult, setJoinResult] = useState<string | null>(null);
  useEffect(() => fixtures?.subscribe(setState), [fixtures]);
  if (!__PORTAL_FIXTURES__ || !fixtures || !state) return null;
  return (
    <details className="demo-panel">
      <summary>Demo controls <span className="badge badge-warning">Development fixtures</span></summary>
      <div className="demo-panel-body">
        <label>Team scenario
          <select value={state.team} onChange={(event) => fixtures.update({ team: event.target.value as TeamScenario })}>
            {TEAM_SCENARIOS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="checkbox"><input type="checkbox" checked={state.failNextWorkspaceCreate} onChange={(event) => fixtures.update({ failNextWorkspaceCreate: event.target.checked })} /> Fail next workspace setup</label>
        <div className="demo-actions">
          <button type="button" className="button-quiet" disabled={!organizationId} onClick={() => { if (organizationId) setJoinResult(JOIN_RESULTS[fixtures.simulateJoin(organizationId)]); }}>Simulate a tester joining with the code</button>
          <button type="button" className="button-quiet" disabled={!organizationId} onClick={() => organizationId && fixtures.revokeMembership(organizationId, uid)}>Revoke my access here</button>
          <button type="button" className="button-quiet" onClick={() => fixtures.expireSession()}>Expire session</button>
          <button type="button" className="button-quiet" onClick={() => fixtures.reset()}>Reset demo data</button>
        </div>
        {joinResult && <p role="status">{joinResult}</p>}
      </div>
    </details>
  );
}
