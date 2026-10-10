import { useEffect, useState } from 'react';
import type { LocalTranscriptionSetup } from '@sayspec/contracts';
import { Button } from './ui';
import { readDefaultNarrationModel, saveDefaultNarrationModel } from './narration-model-preference';

export function NarrationSettings() {
  const [defaultModelId, setDefaultModelId] = useState(readDefaultNarrationModel);
  const [setup, setSetup] = useState<LocalTranscriptionSetup | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => void window.sayspec!.getLocalTranscriptionSetup().then((next) => { if (active) setSetup(next); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Narration setup could not be checked.'); });
    refresh();
    const unsubscribe = window.sayspec!.onLocalTranscriptionLifecycle(() => refresh());
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (setup?.model.id && defaultModelId !== setup.model.id) {
      setDefaultModelId(setup.model.id);
      saveDefaultNarrationModel(setup.model.id);
    }
  }, [setup?.model.id, defaultModelId]);

  function changeModel(value: string) {
    if (value !== setup?.model.id) return;
    setDefaultModelId(value);
    saveDefaultNarrationModel(value);
  }

  async function removeModel() {
    if (!setup) return;
    setRemoving(true); setError('');
    try { setSetup(await window.sayspec!.removeLocalTranscriptionModel({ modelId: setup.model.id })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The downloaded model could not be removed.'); }
    finally { setRemoving(false); }
  }

  return <section className="settings-card narration-settings" aria-labelledby="narration-settings-heading">
    
    <h2 id="narration-settings-heading">Narration</h2>
    <label className="select-field">Default transcription model<select aria-label="Default transcription model" value={setup?.model.id === defaultModelId ? defaultModelId : setup?.model.id ?? ''} onChange={(event) => changeModel(event.target.value)}>
      {setup ? <option value={setup.model.id}>{setup.model.displayName}</option> : <option value="">Checking local model…</option>}
    </select></label>
    <div className="narration-model">
      <div><strong>{setup?.model.state === 'installed' ? 'Ready on this device' : 'Downloaded when you generate a test'}</strong><span>{setup ? `${(setup.model.byteLength / 1024 / 1024).toFixed(1)} MiB · ${setup.model.quantization} · local` : 'Checking local model status…'}</span></div>
      {setup?.model.state === 'installed' ? <Button variant="quiet" onClick={() => void removeModel()} disabled={removing}>{removing ? 'Removing…' : 'Remove model'}</Button> : <span className="settings-help">{setup?.model.state === 'downloading' ? 'Download in progress.' : ''}</span>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
