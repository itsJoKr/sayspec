import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthSnapshot, Services } from '../adapters/types.ts';

const ServicesContext = createContext<Services | null>(null);
const AuthContext = createContext<AuthSnapshot>({ status: 'initializing' });

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>({ status: 'initializing' });
  useEffect(() => services.auth.subscribe(setSnapshot), [services]);
  return <ServicesContext.Provider value={services}><AuthContext.Provider value={snapshot}>{children}</AuthContext.Provider></ServicesContext.Provider>;
}

export function useServices() {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('Services are not available.');
  return services;
}

export function useOptionalServices() { return useContext(ServicesContext); }
export function useAuth() { return useContext(AuthContext); }
