import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button } from './ui';

/** One coding-agent terminal for a whole recording session: one test per recording. */
export function PatrolGenerationTerminal({ projectId, sessionId, recordingCount, sourceHandle, deviceId, appId, flavor, onSaved, onClose }: { projectId: string; sessionId: string; recordingCount: number; sourceHandle: string; deviceId: string; appId: string; flavor?: string; onSaved?(captureId: string): void; onClose(): void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [state, setState] = useState<'starting' | 'running' | 'exited'>('starting');
  const [error, setError] = useState('');
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#17211d', foreground: '#e9eee9', cursor: '#e9eee9' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(mount); terminalRef.current = terminal; fitRef.current = fit;
    terminal.write(`$ Generate and validate one Patrol test per recording (${recordingCount}) for ${sessionId}\r\n`);
    const input = terminal.onData((data) => { void window.sayspec!.writePatrolGeneration({ sessionId, data }).catch(() => undefined); });
    const unsubscribe = window.sayspec!.onPatrolGenerationEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === 'data' && event.data) terminal.write(event.data);
      if (event.kind === 'started') setState('running');
      if (event.kind === 'validation' && event.attempt) terminal.write(`\r\n[SaySpec] ${event.attempt.state}: ${event.attempt.summary}\r\n`);
      if (event.kind === 'saved' && event.captureId) onSavedRef.current?.(event.captureId);
      if (event.kind === 'exit') { setState('exited'); terminal.write(`\r\nCoding agent exited (${event.exitCode ?? 'unknown'}).\r\n`); }
    });
    const observer = new ResizeObserver(() => { if (mount.offsetWidth > 0 && mount.offsetHeight > 0) { fit.fit(); void window.sayspec!.resizePatrolGeneration({ sessionId, cols: terminal.cols, rows: terminal.rows }); } });
    observer.observe(mount);
    const launch = requestAnimationFrame(() => {
      fit.fit(); terminal.focus();
      void window.sayspec!.startPatrolGeneration({ projectId, sessionId, sourceHandle, deviceId, appId, ...(flavor ? { flavor } : {}), cols: terminal.cols, rows: terminal.rows }).then(() => { setState('running'); fit.fit(); void window.sayspec!.resizePatrolGeneration({ sessionId, cols: terminal.cols, rows: terminal.rows }); }).catch((reason) => { setError(reason instanceof Error ? reason.message : String(reason)); setState('exited'); });
    });
    return () => { cancelAnimationFrame(launch); observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); void window.sayspec!.closePatrolGeneration({ sessionId }).catch(() => undefined); };
  }, [projectId, sessionId, sourceHandle, deviceId, appId, flavor]);

  return <section className="claude-tab patrol-generation" aria-label="Interactive Patrol generation">
    <div className="flutter-capture-review__head"><div><h3>Generate Patrol tests</h3><p>The coding agent reads every recording in this session and writes one test per recording. SaySpec runs each exact submission on the selected device.</p></div><Button onClick={onClose}>Close</Button></div>
    <div className="claude-tab__frame">
      <div ref={mountRef} className="claude-tab__terminal" role="region" aria-label="Interactive Patrol coding-agent terminal" />
      {error && <div className="claude-tab__overlay" role="alert"><span>{error}</span></div>}
      {state === 'starting' && !error && <div className="claude-tab__overlay" role="status"><span>Starting the selected coding agent…</span></div>}
    </div>
  </section>;
}
