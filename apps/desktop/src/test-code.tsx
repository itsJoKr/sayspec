import { useEffect, useRef, useState } from 'react';
import type { TestCode } from './test-repository';
import { Button } from './ui';

function messageOf(reason: unknown) { return reason instanceof Error ? reason.message.replace(/^(Firebase)?Error:\s*/, '') : 'The test’s code could not be read.'; }

/** A test's full code, read-only, in a modal the user closes with Escape or Close. */
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
  return <dialog ref={dialogRef} className="log-dialog test-code-dialog" aria-labelledby="test-code-title" onClose={onClose} onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current?.close(); }}>
    <header><div><h3 id="test-code-title">{title}</h3>{details && <p>{details}</p>}</div><Button onClick={() => dialogRef.current?.close()}>Close</Button></header>
    {error ? <p className="inline-error" role="alert">{error}</p>
      : code === undefined ? <p className="control-help">Loading the test…</p>
        : code === null ? <p className="control-help">SaySpec could not find this test’s code on this Mac or in its test storage.</p>
          : <div className="test-code-body">
            {code.steps?.length ? <ol className="test-code-steps" aria-label="Steps">{code.steps.map((step, index) => <li key={index}>{step.instruction}<span>Expect: {step.assertion}</span></li>)}</ol> : null}
            {code.files.map((file) => <section key={file.relativePath} className="test-code-file" aria-label={file.relativePath}>
              <h4><code>{file.relativePath}</code></h4>
              {/* Line numbers are CSS counters, so copying the code leaves them out. */}
              <pre tabIndex={0}><code>{file.text.replace(/\n$/, '').split('\n').map((line, index) => <span key={index} className="test-code-line">{line}{'\n'}</span>)}</code></pre>
            </section>)}
          </div>}
  </dialog>;
}
