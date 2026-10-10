// Types for the development-only fixture controls. Imported as types only by
// production code, so nothing here is bundled outside `--mode fixtures`.
export type TeamScenario = 'normal' | 'empty' | 'loading' | 'error';

export interface FixtureState {
  team: TeamScenario;
  failNextWorkspaceCreate: boolean;
}

export interface FixtureControls {
  demoPassword: string;
  demoAccounts: Array<{ email: string; label: string }>;
  getState(): FixtureState;
  subscribe(listener: (state: FixtureState) => void): () => void;
  update(patch: Partial<FixtureState>): void;
  revokeMembership(organizationId: string, uid: string): void;
  /** Simulates a tester entering the company code in the desktop app. */
  simulateJoin(organizationId: string): 'joined' | 'joining-off' | 'full';
  expireSession(): void;
  reset(): void;
}
