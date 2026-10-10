import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CloudContext } from './cloud/context';
import { loadCloudBackend } from './cloud/load';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
loadCloudBackend().then(
  (cloud) => root.render(<React.StrictMode><CloudContext.Provider value={cloud}><App /></CloudContext.Provider></React.StrictMode>),
  (error: unknown) => root.render(<main className="entry-shell"><section className="welcome-card"><h1>SaySpec could not start</h1><p>{error instanceof Error ? error.message : String(error)}</p></section></main>),
);
