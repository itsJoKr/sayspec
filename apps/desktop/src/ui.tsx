import { createContext, useContext, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button className={`button button--${variant} ${className}`} {...props} />;
}

export function Field({ label, error, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = props.id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const helpId = `${id}-help`;
  return <label className="field" htmlFor={id}>
    <span className="field__label">{label}</span>
    <input {...props} id={id} aria-invalid={Boolean(error)} aria-describedby={(error || hint) ? helpId : undefined} />
    {(error || hint) && <span id={helpId} className={error ? 'field__error' : 'field__hint'}>{error ? `Error: ${error}` : hint}</span>}
  </label>;
}

const statusIcon = { passed: '✓', failed: '×', warning: '!', draft: '○', running: '↻', blocked: '—' } as const;
export function StatusLabel({ status, children }: { status: keyof typeof statusIcon; children: ReactNode }) {
  return <span className={`status status--${status}`}><span aria-hidden="true">{statusIcon[status]}</span>{children}</span>;
}

export function StatePanel({ tone, title, children, action }: { tone: 'empty' | 'error' | 'offline'; title: string; children: ReactNode; action?: ReactNode }) {
  const icon = tone === 'error' ? '×' : tone === 'offline' ? '↯' : '○';
  return <section className={`state-panel state-panel--${tone}`} aria-label={`${title} state`}>
    <span className="state-panel__icon" aria-hidden="true">{icon}</span>
    <div><h3>{title}</h3><p>{children}</p>{action}</div>
  </section>;
}

export function PhaseProgress({ label, value, max = 100 }: { label: string; value?: number; max?: number }) {
  return <div className="phase-progress" aria-live="polite">
    <div><strong>{label}</strong><span>{value === undefined ? 'In progress' : `${value}%`}</span></div>
    {value === undefined ? <div className="indeterminate" role="progressbar" aria-label={label} /> : <progress aria-label={label} value={value} max={max} />}
  </div>;
}

/** The page header's action area; pages add their own actions through `TopbarActions`. */
export const TopbarSlotContext = createContext<HTMLElement | null>(null);

/** Renders page-owned actions after the shell's own actions in the page header. */
export function TopbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(TopbarSlotContext);
  return slot ? createPortal(children, slot) : null;
}
