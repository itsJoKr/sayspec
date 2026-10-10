import type { CodingAgentProviderId } from '@sayspec/contracts';
import claudeLogo from './assets/claude.ico';
import codexLogo from './assets/codex.png';

export function AiProviderLogo({ provider }: { provider: CodingAgentProviderId | null | undefined }) {
  if (!provider) return <span className="ai-provider-logo ai-provider-logo--empty" aria-hidden="true">●</span>;
  return <img className="ai-provider-logo" data-provider={provider} src={provider === 'claude-code' ? claudeLogo : codexLogo} alt="" aria-hidden="true" />;
}
