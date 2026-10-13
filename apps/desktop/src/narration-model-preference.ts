import { useSyncExternalStore } from 'react';
import { isProPlan, type CloudTranscriptionScope, type PlanKind } from '@sayspec/contracts';
import type { CloudBackend } from './cloud/backend';

const key = 'sayspec:default-narration-model';
/** Stored in place of a local model ID when Gemini in SaySpec Cloud is the default. */
export const CLOUD_NARRATION = 'gemini-cloud';
let selected: string | undefined;
const listeners = new Set<() => void>();

export function readDefaultNarrationModel() {
  if (selected !== undefined) return selected;
  try { return window.localStorage.getItem(key) ?? ''; }
  catch { return ''; }
}

export function saveDefaultNarrationModel(modelId: string) {
  selected = modelId;
  try { window.localStorage.setItem(key, modelId); }
  catch { /* The visible selection remains usable for this session. */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

export type NarrationChoice = ReturnType<typeof useNarrationChoice>;

/**
 * Local Whisper or Gemini. `plan` is the signed-in workspace's plan, null while
 * it loads, and undefined without a cloud workspace, where Gemini is not offered.
 * A Gemini default on a workspace without Beta or Pro falls back to Whisper.
 */
export function useNarrationChoice(plan: PlanKind | null | undefined) {
  const preference = useSyncExternalStore(subscribe, readDefaultNarrationModel);
  const available = isProPlan(plan);
  return {
    preference, offered: plan !== undefined, available,
    engine: preference === CLOUD_NARRATION && available ? 'cloud' as const : 'local' as const,
    select: saveDefaultNarrationModel,
  };
}

export function cloudNarrationLabel(available: boolean) { return available ? 'Gemini · SaySpec Cloud' : 'Gemini · SaySpec Cloud (Beta and Pro)'; }

/** A fresh token per request: the backend rechecks membership, plan and allowance every time. */
export async function cloudTranscriptionScope(cloud: CloudBackend | null, organizationId: string, projectId: string): Promise<CloudTranscriptionScope> {
  const idToken = await cloud?.auth.idToken();
  if (!idToken) throw new Error('Sign in again before using Gemini transcription.');
  return { idToken, organizationId, projectId };
}
