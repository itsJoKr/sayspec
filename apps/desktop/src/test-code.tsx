import { useEffect, useRef, useState } from 'react';
import type { TestCode } from './test-repository';
import { Button } from './ui';

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message.replace(/^(Firebase)?Error:\s*/, '') : 'The test’s code could not be read.'; }

/** Shows dartdoc's [name] references and `code` spans as code. */
function Inline({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]\s]+\]|`[^`]+`)/).map((part, index) => index % 2 ? <code key={index}>{part.slice(1, -1)}</code> : part)}</>;
}

/**
 * A test in a modal the user closes with Escape or Close: what it checks
 * first, in the words of its file, then its code, folded away unless the file
 * has nothing else to say.
 */
export function TestCodeDialog({ title, load, onClose }: { title: string; load: () => Promise<TestCode | null>; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState<TestCode | null>();
  const [error, setError] = useState('');
  useEffect(() => {
    dialogRef.current?.showModal();
    let live = true;
    void load().then((value) => { if (live) setCode(value); }).catch((reason) => { if (live) setError(messageOf(reason)); });
    return () => { live = false; };
  }, []);
  const details = [code?.version ? `Version ${code.version}` : '', code?.savedAt ? `saved ${new Date(code.savedAt).toLocaleString()}` : ''].filter(Boolean).join(' · ');
  // A single check named like the test itself says nothing new.
  const checks = code?.cases?.length === 1 && code.cases[0].trim() === title.trim() ? [] : code?.cases ?? [];
  const described = Boolean(code?.about?.length || checks.length || code?.steps?.length);
  return <dialog ref={dialogRef} className="log-dialog test-code-dialog" aria-labelledby="test-code-title" onClose={onClose} onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current?.close(); }}>
    <header><div><h3 id="test-code-title">{title}</h3>{details && <p>{details}</p>}</div><Button onClick={() => dialogRef.current?.close()}>Close</Button></header>
    {error ? <p className="inline-error" role="alert">{error}</p>
      : code === undefined ? <p className="control-help">Loading the test…</p>
        : code === null ? <p className="control-help">SaySpec could not find this test’s code on this Mac or in its test storage.</p>
          : <div className="test-code-body">
            {code.about?.length ? <section className="test-code-section" aria-labelledby="test-code-about"><h4 id="test-code-about">About this test</h4>{code.about.map((block, index) => block.kind === 'code' ? <pre key={index}>{block.text}</pre> : <p key={index}><Inline text={block.text} /></p>)}</section> : null}
            {checks.length ? <section className="test-code-section" aria-labelledby="test-code-checks"><h4 id="test-code-checks">{checks.length === 1 ? 'What it checks' : `What it checks (${checks.length})`}</h4><ul>{checks.map((name, index) => <li key={index}>{name}</li>)}</ul></section> : null}
            {code.steps?.length ? <section className="test-code-section" aria-labelledby="test-code-steps"><h4 id="test-code-steps">Steps</h4><ol>{code.steps.map((step, index) => <li key={index}>{step.instruction}<span>Expect: {step.assertion}</span></li>)}</ol></section> : null}
            {!described && <p className="control-help">This test’s file does not describe what it checks, so here is its code.</p>}
            <details className="test-code-source" open={!described}>
              <summary>Code · {code.files.length === 1 ? code.files[0].relativePath : `${code.files.length} files`}</summary>
              {code.files.map((file) => <section key={file.relativePath} className="test-code-file" aria-label={file.relativePath}>
                {code.files.length > 1 && <h4><code>{file.relativePath}</code></h4>}
                {/* Line numbers are CSS counters, so copying the code leaves them out. */}
                <pre tabIndex={0}><code>{file.text.replace(/\n$/, '').split('\n').map((line, index) => <span key={index} className="test-code-line">{line}{'\n'}</span>)}</code></pre>
              </section>)}
            </details>
          </div>}
  </dialog>;
}
