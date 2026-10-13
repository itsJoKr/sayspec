import { useEffect, useState } from 'react';
import type { LocalTranscriptionSetup, PlanKind } from '@sayspec/contracts';
import { Button } from './ui';
import { CLOUD_NARRATION, cloudNarrationLabel, useNarrationChoice } from './narration-model-preference';

/** `plan` is the signed-in workspace's plan; without one (guest), only local Whisper is offered. */
export function NarrationSettings({ plan }: { plan?: PlanKind | null }) {
  const narration = useNarrationChoice(plan);
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

  // A stored local model ID that no longer exists becomes the current model; a Gemini default is kept.
  useEffect(() => {
    if (setup?.model.id && narration.preference !== CLOUD_NARRATION && narration.preference !== setup.model.id) narration.select(setup.model.id);
  }, [setup?.model.id, narration.preference, narration.select]);

  function changeModel(value: string) {
    if (value !== setup?.model.id && value !== CLOUD_NARRATION) return;
    narration.select(value);
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
    <label className="select-field">Default transcription model<select aria-label="Default transcription model" value={narration.engine === 'cloud' ? CLOUD_NARRATION : setup?.model.id ?? ''} onChange={(event) => changeModel(event.target.value)}>
      {setup ? <option value={setup.model.id}>{setup.model.displayName}</option> : <option value="">Checking local model…</option>}
      {narration.offered && <option value={CLOUD_NARRATION} disabled={!narration.available}>{cloudNarrationLabel(narration.available)}</option>}
    </select></label>
    {narration.engine === 'cloud' && <p className="settings-help">Narration audio is sent to SaySpec Cloud and transcribed by Google Gemini; it is not kept there. Up to 25 minutes at a time, counted against the workspace&apos;s monthly allowance. Local Whisper keeps audio on this Mac.</p>}
    <div className="narration-model">
      <div><strong>{setup?.model.state === 'installed' ? 'Ready on this device' : 'Downloaded when you generate a test'}</strong><span>{setup ? `${(setup.model.byteLength / 1024 / 1024).toFixed(1)} MiB · ${setup.model.quantization} · local` : 'Checking local model status…'}</span></div>
      {setup?.model.state === 'installed' ? <Button variant="quiet" onClick={() => void removeModel()} disabled={removing}>{removing ? 'Removing…' : 'Remove model'}</Button> : <span className="settings-help">{setup?.model.state === 'downloading' ? 'Download in progress.' : ''}</span>}
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
