export type ProjectTechnology = 'web' | 'flutter';

export const TECHNOLOGY_LABELS: Record<ProjectTechnology, string> = { web: 'Web · Playwright tests', flutter: 'Flutter · Patrol tests' };

/** Planned platforms, listed greyed out so teams can see what is coming. None can be selected yet. */
const COMING_SOON = ['Native Android', 'Native iOS', 'React Native'];

export function TechnologySelect({ value, onChange }: { value: ProjectTechnology; onChange: (technology: ProjectTechnology) => void }) {
  return <label className="select-field">Technology<select aria-label="Project technology" value={value} onChange={(event) => onChange(event.target.value as ProjectTechnology)}>
    <optgroup label="Supported">{(Object.keys(TECHNOLOGY_LABELS) as ProjectTechnology[]).map((key) => <option key={key} value={key}>{TECHNOLOGY_LABELS[key]}</option>)}</optgroup>
    <optgroup label="Coming soon">{COMING_SOON.map((name) => <option key={name} value={name} disabled>{name} · Coming soon</option>)}</optgroup>
  </select></label>;
}
