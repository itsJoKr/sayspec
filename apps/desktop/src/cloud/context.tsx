import { createContext, useContext } from 'react';
import type { CloudBackend } from './backend';

/** The configured cloud backend, or null in a local-only build. Fixed for the app's lifetime. */
export const CloudContext = createContext<CloudBackend | null>(null);

export function useCloud(): CloudBackend | null { return useContext(CloudContext); }

/** For screens that only exist when a backend is configured (account, workspaces, reviews). */
export function useRequiredCloud(): CloudBackend {
  const cloud = useContext(CloudContext);
  if (!cloud) throw new Error('This screen needs a cloud backend, and this build has none.');
  return cloud;
}
