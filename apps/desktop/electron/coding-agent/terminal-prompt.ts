import type { IPty } from 'node-pty';

/**
 * Submits one line to an interactive coding agent as if the user typed it.
 *
 * The agent cannot wait for host validation on its own, so the host tells it
 * when a result is ready. Enter goes separately: Claude Code and Codex treat
 * text and a carriage return arriving in one chunk as a paste and insert a
 * newline instead of submitting. A busy agent queues the line for its next turn.
 */
export function submitTerminalPrompt(terminal: IPty, text: string, isOpen: () => boolean) {
  if (!isOpen()) return;
  try { terminal.write(text.replace(/[\r\n]+/g, ' ')); } catch { return; }
  setTimeout(() => { if (isOpen()) { try { terminal.write('\r'); } catch { /* exited */ } } }, 200);
}
