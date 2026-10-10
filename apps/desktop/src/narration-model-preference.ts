const key = 'sayspec:default-narration-model';

export function readDefaultNarrationModel() {
  try { return window.localStorage.getItem(key) ?? ''; }
  catch { return ''; }
}

export function saveDefaultNarrationModel(modelId: string) {
  try { window.localStorage.setItem(key, modelId); }
  catch { /* The visible selection remains usable for this session. */ }
}
