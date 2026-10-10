import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { hasNavigatedInApp } from './router.tsx';

export function PageTitle({ title, children, eyebrow }: { title: string; children?: ReactNode; eyebrow?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} | SaySpec`;
    if (hasNavigatedInApp()) ref.current?.focus();
  }, [title]);
  return (
    <div className="page-title">
      {eyebrow && <p className="eyebrow"><span className="signal-dot" aria-hidden="true" />{eyebrow}</p>}
      <h1 ref={ref} tabIndex={-1}>{title}</h1>
      {children && <div className="page-lede">{children}</div>}
    </div>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: ReactNode; inputRef?: RefObject<HTMLInputElement | null> };

export function Field({ label, error, hint, id, inputRef, ...input }: FieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={fieldId}>{label}</label>
      <input ref={inputRef} id={fieldId} aria-invalid={error ? true : undefined} aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined} {...input} />
      {hint && <p className="field-hint" id={hintId}>{hint}</p>}
      {error && <p className="field-error" id={errorId}>{error}</p>}
    </div>
  );
}

/**
 * Uncontrolled password input: the value lives only in the DOM element until
 * the form reads it on submit, and callers clear it afterwards. It is never
 * copied into React state, storage, URLs or logs.
 */
export function PasswordField({ label, error, hint, autoComplete, name, inputRef, extraActions, required = true, minLength }: {
  label: string; error?: string | null; hint?: ReactNode; autoComplete: 'current-password' | 'new-password'; name: string;
  inputRef?: RefObject<HTMLInputElement | null>; extraActions?: ReactNode; required?: boolean; minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="password-row">
        <input ref={inputRef} id={id} name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} required={required} minLength={minLength}
          spellCheck={false} autoCapitalize="off" aria-invalid={error ? true : undefined} aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined} />
        <button type="button" className="button-quiet" aria-pressed={visible} aria-controls={id} onClick={() => setVisible((value) => !value)}>{visible ? 'Hide' : 'Show'}</button>
        {extraActions}
      </div>
      {hint && <p className="field-hint" id={hintId}>{hint}</p>}
      {error && <p className="field-error" id={errorId}>{error}</p>}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, role }: { tone?: 'info' | 'success' | 'warning' | 'error' | 'unavailable'; title?: string; children?: ReactNode; role?: 'status' | 'alert' }) {
  return (
    <div className={`notice notice-${tone}`} role={role ?? (tone === 'error' ? 'alert' : 'status')}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return <div className="loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function SubmitButton({ busy, children, busyLabel, disabled, className = 'button' }: { busy: boolean; children: ReactNode; busyLabel: string; disabled?: boolean; className?: string }) {
  return <button type="submit" className={className} disabled={busy || disabled} aria-busy={busy || undefined}>{busy ? busyLabel : children}</button>;
}

/** Native modal dialog: focus containment, Escape and inert background come from the platform. */
export function Dialog({ open, title, onClose, children, description }: { open: boolean; title: string; onClose: () => void; children: ReactNode; description?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} onClose={onClose} onCancel={(event) => { event.preventDefault(); onClose(); }}>
      {open && (
        <div className="dialog-body">
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="button-quiet dialog-close" onClick={onClose} aria-label="Close">×</button>
          </div>
          {description && <div id={descriptionId} className="dialog-description">{description}</div>}
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Wordmark({ href = '/' }: { href?: string }) {
  return (
    <a className="wordmark" href={href} aria-label="SaySpec home">
      <span className="brand-mark" aria-hidden="true"><span /></span>
      <span>SaySpec</span>
    </a>
  );
}

export function shortId(uid: string) { return uid.length > 8 ? `…${uid.slice(-6)}` : uid; }

export function formatDate(value: string | Date | null | undefined) {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date);
}
