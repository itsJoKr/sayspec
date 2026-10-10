import { useEffect, useRef, useState } from 'react';
import type { FlutterDeviceSummary } from '@sayspec/contracts';
import { Button } from './ui';

type Platform = FlutterDeviceSummary['platform'];

const messageOf = (error: unknown) => (error instanceof Error ? error.message.replace(/^Error:\s*/, '') : String(error));
const START: Record<Platform, string> = { android: 'start:android', ios: 'start:ios' };
const NOUN: Record<Platform, string> = { android: 'emulator', ios: 'simulator' };

/** `iOS 26.5` sorts above `iOS 18.4`; unknown runtimes go last. */
function runtimeRank(runtime = '') {
  return (runtime.match(/\d+/g) ?? []).reduce((rank, part) => rank * 1000 + Number(part), 0);
}

function deviceLabel(device: FlutterDeviceSummary) {
  return [device.name, device.platform, ...(device.apiLevel ? [`API ${device.apiLevel}`] : []), ...(device.runtime ? [device.runtime] : []), ...(device.state === 'ready' ? [] : [device.state])].join(' · ');
}

/**
 * Device picker for Flutter work. Lists the running devices, and offers to
 * start an installed Android emulator (AVD) or an iOS simulator that is not
 * running. Once a started device is ready, `onStarted` hands it back so the
 * caller can refresh its list and select it.
 */
export function DeviceSelect({ devices, value, onChange, onStarted, platforms, disabled, label, ariaLabel, ariaLabelledBy, className = '' }: {
  devices: FlutterDeviceSummary[];
  value: string;
  onChange: (deviceId: string) => void;
  onStarted: (device: FlutterDeviceSummary) => void | Promise<void>;
  platforms: Platform[];
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  className?: string;
}) {
  const [picking, setPicking] = useState<Platform>();
  const [target, setTarget] = useState('');
  const [starting, setStarting] = useState<FlutterDeviceSummary>();
  const [error, setError] = useState('');
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const listed = devices.filter((device) => platforms.includes(device.platform));
  const running = listed.filter((device) => device.state !== 'stopped');
  const stopped = (platform: Platform) => listed.filter((device) => device.platform === platform && device.state === 'stopped')
    .sort((a, b) => runtimeRank(b.runtime) - runtimeRank(a.runtime));
  // Simulators exist only where Xcode does, so the option appears only when
  // simctl reported some; emulators are offered everywhere so an empty AVD
  // list can explain how to create one.
  const startable = platforms.filter((platform) => platform === 'android' || listed.some((device) => device.platform === 'ios'));
  const candidates = picking ? stopped(picking) : [];

  function choose(next: string) {
    const platform = startable.find((item) => START[item] === next);
    if (!platform) { onChange(next); return; }
    setPicking(platform); setError('');
    setTarget(stopped(platform)[0]?.id ?? '');
  }

  async function start() {
    const device = candidates.find((item) => item.id === target);
    if (!device) return;
    setStarting(device); setError('');
    try {
      const ready = await window.sayspec!.startFlutterDevice({ deviceId: device.id });
      await onStarted(ready);
      if (mounted.current) setPicking(undefined);
    } catch (reason) {
      if (mounted.current) setError(messageOf(reason));
    } finally {
      if (mounted.current) setStarting(undefined);
    }
  }

  const runtimes = [...new Set(candidates.map((device) => device.runtime ?? ''))];
  return <div className={`select-field device-select ${className}`}>
    {label && <span>{label}</span>}
    <select aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} value={value} disabled={disabled} onChange={(event) => choose(event.target.value)}>
      <option value="">{running.some((device) => device.state === 'ready') ? 'Choose a device…' : 'No device is running'}</option>
      {running.map((device) => <option key={device.id} value={device.id} disabled={device.state !== 'ready'}>{deviceLabel(device)}</option>)}
      {startable.length > 0 && <option disabled>──────────</option>}
      {startable.map((platform) => <option key={platform} value={START[platform]}>Start {NOUN[platform]}…</option>)}
    </select>
    {picking && <div className="device-start" role="group" aria-label={`Start ${NOUN[picking]}`}>
      {candidates.length === 0
        ? <p className="control-help">{picking === 'android'
          ? 'No Android virtual device is installed, or every one is already running. Create one in Android Studio → Device Manager, then re-check devices.'
          : 'Every iOS simulator is already running, or none is installed. Add one in Xcode → Window → Devices and Simulators, then re-check devices.'}</p>
        : <select aria-label={`${picking === 'android' ? 'Emulator' : 'Simulator'} to start`} value={target} disabled={Boolean(starting)} onChange={(event) => setTarget(event.target.value)}>
          {picking === 'ios' && runtimes.length > 1
            ? runtimes.map((runtime) => <optgroup key={runtime} label={runtime || 'iOS'}>
              {candidates.filter((device) => (device.runtime ?? '') === runtime).map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
            </optgroup>)
            : candidates.map((device) => <option key={device.id} value={device.id}>{device.name}{device.runtime ? ` · ${device.runtime}` : ''}</option>)}
        </select>}
      <div className="device-start__actions">
        {candidates.length > 0 && <Button variant="primary" disabled={!target || Boolean(starting)} onClick={() => void start()}>{starting ? 'Starting…' : `Start ${NOUN[picking]}`}</Button>}
        <Button variant="quiet" disabled={Boolean(starting)} onClick={() => setPicking(undefined)}>Cancel</Button>
      </div>
      {starting && <p className="control-help" role="status">Starting {starting.name}. This can take a minute; it is selected once it has finished booting.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>}
  </div>;
}
