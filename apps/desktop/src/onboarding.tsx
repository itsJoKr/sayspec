import { useEffect, useState, type ReactNode } from 'react';
import type { LocalSourceSelection } from '@sayspec/contracts';
import { AiProviderSettings } from './ai-provider-settings';
import { MachineSetupCard } from './machine-setup';
import { NarrationSettings } from './transcription-settings';
import { Button } from './ui';
import { TECHNOLOGY_LABELS, type ProjectTechnology } from './technology';

export type OnboardingProject = { id: string; name: string; targetType: ProjectTechnology };

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error:\s*/, '') : 'The source folder could not be selected.');

/** Mirrors the Coding AI card's own readiness so the step can show as done. */
function useCodingAgentReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => void Promise.all([window.sayspec!.getCodingAgentPreference(), window.sayspec!.checkCodingAgentReadiness()])
      .then(([preference, readiness]) => { if (active) setReady(readiness.providers.find((item) => item.id === preference.provider)?.state === 'ready'); })
      .catch(() => { if (active) setReady(false); });
    refresh();
    window.addEventListener('sayspec:coding-agent-changed', refresh);
    return () => { active = false; window.removeEventListener('sayspec:coding-agent-changed', refresh); };
  }, []);
  return ready;
}

function Step({ number, label, done = false, children }: { number: number; label: string; done?: boolean; children: ReactNode }) {
  return <li className="onboarding-step" data-done={done ? 'true' : 'false'}>
    <span className="onboarding-step__marker" aria-hidden="true">{done ? '✓' : number}</span>
    <span className="sr-only">Step {number}, {label}{done ? ', done' : ''}</span>
    <div className="onboarding-step__body">{children}</div>
  </li>;
}

/**
 * First run with no projects, for guests and signed-in members alike: the same
 * cards as Settings, in the order they depend on each other. Machine setup is
 * project-scoped, so it unlocks once the project exists; the page stays open
 * until the user finishes rather than jumping away on project creation.
 */
export function OnboardingPage({ testId, account, projectStep, project, projectPending = false, source, onChooseSource, onFinish, waitingHint }: {
  testId: string;
  account: ReactNode;
  /** Creation form, or an explanation when the user cannot create one. */
  projectStep: ReactNode;
  project?: OnboardingProject;
  /** Created, but the workspace has not delivered the project yet. */
  projectPending?: boolean;
  source?: LocalSourceSelection | null;
  onChooseSource: (source: LocalSourceSelection) => void;
  onFinish: () => void;
  waitingHint: string;
}) {
  const aiReady = useCodingAgentReady();
  const [error, setError] = useState('');
  async function chooseSource() {
    setError('');
    try { const next = await window.sayspec!.chooseSourceDirectory(); if (next) onChooseSource(next); } catch (reason) { setError(messageOf(reason)); }
  }
  return <section className="project-gate onboarding" data-testid={testId}>
    <div className="gate-top"><div><h1>Set up SaySpec</h1><p className="onboarding-lede">Choose your coding AI, check narration, create your first project and prepare this machine. You can change all of this later in Settings.</p></div>{account}</div>
    <ol className="onboarding-steps">
      <Step number={1} label="Coding AI" done={aiReady}><AiProviderSettings /></Step>
      <Step number={2} label="Narration"><NarrationSettings /></Step>
      <Step number={3} label="Project" done={Boolean(project)}>
        {project ? <section className="settings-card project-settings-summary" data-testid="onboarding-project"><h2>{project.name}</h2><p className="technology-label">{TECHNOLOGY_LABELS[project.targetType]}</p></section>
          : projectPending ? <section className="settings-card"><h2>Project</h2><p className="settings-inline-status" role="status">Opening the new project…</p></section>
          : projectStep}
      </Step>
      <Step number={4} label="Machine setup">
        {project ? <MachineSetupCard projectId={project.id} targetType={project.targetType} sourceHandle={source?.handle} onSourceRequired={() => void chooseSource()} />
          : <section className="settings-card onboarding-locked"><h2>Machine setup</h2><p>Create a project first. The checks depend on whether it is a Web or Flutter project.</p></section>}
        {error && <p className="inline-error" role="alert">{error}</p>}
      </Step>
    </ol>
    <div className="onboarding-footer">
      {project ? <><Button data-testid="onboarding-finish" variant="primary" onClick={onFinish}>Open {project.name}</Button><span>Anything left can be finished later in Settings.</span></>
        : <span>{waitingHint}</span>}
    </div>
  </section>;
}
