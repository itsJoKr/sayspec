import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Button } from './ui';

export function ClaudeTerminalPanel({ recordingId, active, mode, preparationStatus }: { recordingId: string; active: boolean; mode: 'inspect' | 'prepare' | 'generate'; preparationStatus: string }) {
  const [agentName, setAgentName] = useState('Coding agent');
  const binary = agentName === 'Codex' ? 'codex' : agentName === 'Claude Code' ? 'claude' : 'agent';
  const generationCommand = `$ ${binary} "Generate a test for recording ${recordingId} in the SaySpec project workspace."\r\n`;
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const launchedModeRef = useRef<string>('');
  const lastPreparationRef = useRef('');
  const lastCommandRef = useRef('');
  const [state, setState] = useState<'idle' | 'starting' | 'running' | 'exited'>('idle');
  const [error, setError] = useState('');

  useEffect(() => { void window.sayspec!.getCodingAgentPreference().then((preference) => setAgentName(preference.provider === 'codex' ? 'Codex' : preference.provider === 'claude-code' ? 'Claude Code' : 'Coding agent')); }, [recordingId]);

  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    launchedModeRef.current = ''; lastPreparationRef.current = ''; lastCommandRef.current = ''; setState('idle'); setError('');
    const terminal = new Terminal({ cursorBlink: true, convertEol: true, scrollback: 10_000, fontFamily: 'SFMono-Regular, Menlo, monospace', fontSize: 13, theme: { background: '#17211d', foreground: '#e9eee9', cursor: '#e9eee9' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(mount);
    terminalRef.current = terminal; fitRef.current = fit;
    const input = terminal.onData((data) => { void window.sayspec!.writeClaudeTerminal({ recordingId, data }).catch(() => undefined); });
    const unsubscribe = window.sayspec!.onClaudeTerminalEvent((event) => {
      if (event.recordingId !== recordingId) return;
      if (event.kind === 'data' && event.data) terminal.write(event.data);
      if (event.kind === 'started') setState('running');
      if (event.kind === 'exit') { lastCommandRef.current = ''; setState('exited'); terminal.write(`\r\nCoding agent exited (${event.exitCode ?? 'unknown'}).\r\n`); }
    });
    const observer = new ResizeObserver(() => { if (mount.offsetWidth > 0 && mount.offsetHeight > 0) { fit.fit(); void window.sayspec!.resizeClaudeTerminal({ recordingId, cols: terminal.cols, rows: terminal.rows }); } });
    observer.observe(mount);
    return () => { observer.disconnect(); unsubscribe(); input.dispose(); terminal.dispose(); terminalRef.current = null; fitRef.current = null; void window.sayspec!.closeClaudeTerminal({ recordingId }).catch(() => undefined); };
  }, [recordingId]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit(); terminalRef.current?.focus();
    if (mode === 'prepare') {
      if (launchedModeRef.current !== 'prepare') { launchedModeRef.current = 'prepare'; if (lastCommandRef.current !== generationCommand) { terminalRef.current?.write(generationCommand); lastCommandRef.current = generationCommand; } }
      return;
    }
    if (launchedModeRef.current !== mode) { launchedModeRef.current = mode; void start(mode); }
  }, [active, recordingId, mode, generationCommand]);

  useEffect(() => {
    if (active && mode === 'prepare' && preparationStatus && preparationStatus !== lastPreparationRef.current) {
      lastPreparationRef.current = preparationStatus;
      terminalRef.current?.write(`${preparationStatus}\r\n`);
    }
  }, [active, mode, preparationStatus]);

  async function start(launchMode: 'inspect' | 'generate') {
    setError(''); setState('starting');
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const mount = mountRef.current; const terminal = terminalRef.current;
      if (!mount || !terminal || mount.offsetWidth === 0 || mount.offsetHeight === 0) throw new Error('The coding-agent terminal is not visible.');
      fitRef.current?.fit();
      const command = launchMode === 'generate' ? generationCommand : `$ ${binary}\r\n`;
      if (lastCommandRef.current !== command) { terminal.write(command); lastCommandRef.current = command; }
      await window.sayspec!.startClaudeTerminal({ recordingId, cols: terminal.cols, rows: terminal.rows, mode: launchMode });
      await window.sayspec!.resizeClaudeTerminal({ recordingId, cols: terminal.cols, rows: terminal.rows });
      setState('running'); terminal.focus();
    }
    catch (reason) { setState('idle'); setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <section className="claude-tab" aria-label={`${agentName} terminal`}>
    <div className="claude-tab__frame">
      <div ref={mountRef} className="claude-tab__terminal" role="region" aria-label={`Interactive ${agentName} terminal`} />
      {mode !== 'prepare' && error && <div className="claude-tab__overlay" role="alert"><span>{error}</span><Button onClick={() => void start(mode === 'generate' ? 'generate' : 'inspect')}>Retry agent</Button></div>}
      {mode !== 'prepare' && state === 'exited' && !error && <Button className="claude-tab__restart" onClick={() => void start(mode === 'generate' ? 'generate' : 'inspect')}>Restart agent</Button>}
    </div>
  </section>;
}
