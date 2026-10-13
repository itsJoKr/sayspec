import { applicationDefault } from 'firebase-admin/app';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { CommandError, orgRef, requireProjectAuthor, type Actor } from './commands.js';
import { isProPlan, planKind } from './membership.js';

// Gemini narration transcription for Beta and Pro workspaces. The desktop
// encodes each narration as mono Ogg/Opus and sends it inline; the audio is
// passed to Gemini on Vertex AI and never stored here. Vertex AI is called with
// the function's own service account, so no Gemini credential exists outside
// Google Cloud. Each workspace has a monthly allowance in minutes, reserved
// before the provider call and refunded when the call fails.

/** Longest narration accepted in one request (CLOUD_TRANSCRIPTION_MAX_MS in @sayspec/contracts). */
export const NARRATION_MAX_MS = 25 * 60_000;
// 25 minutes at the desktop's 16 kbit/s is about 3 MB. The cap also bounds what
// a request can cost when its Ogg timing is not honest: Opus cannot go much
// below 6 kbit/s, so 8 MiB is a few hours of audio at most.
const NARRATION_MAX_BYTES = 8 * 1024 * 1024;
// Ogg's last granule position can be a little past the real end; never reject an honest 25:00.
const DURATION_TOLERANCE_MS = 5_000;
const MAX_SEGMENTS = 2_000;
const MAX_SEGMENT_TEXT = 2_000;

export interface NarrationTranscriberInput { audio: Buffer; mimeType: 'audio/ogg'; durationMs: number }
/** Raw provider output; `normalizeTranscript` validates it. */
export type NarrationTranscriber = (input: NarrationTranscriberInput) => Promise<unknown>;

const CAPTURE = Buffer.from('OggS', 'latin1');

/**
 * Duration of an Ogg/Opus file from its headers: the final page's granule
 * position minus the OpusHead pre-skip, at Opus's fixed 48 kHz granule rate.
 */
export function oggOpusDurationMs(bytes: Buffer) {
  const invalid = () => new CommandError('invalid-argument', 'Narration audio must be an Ogg/Opus file.');
  if (bytes.length < 47 || !bytes.subarray(0, 4).equals(CAPTURE) || bytes[4] !== 0 || (bytes[5] & 0x02) === 0) throw invalid();
  const head = 27 + bytes[26];
  if (bytes.toString('latin1', head, head + 8) !== 'OpusHead' || head + 19 > bytes.length) throw invalid();
  const preSkip = bytes.readUInt16LE(head + 10);
  // The last page is the one that ends exactly at the end of the file; a
  // capture pattern inside audio data does not.
  for (let offset = bytes.lastIndexOf(CAPTURE); offset > 0; offset = bytes.lastIndexOf(CAPTURE, offset - 1)) {
    if (offset + 27 > bytes.length || bytes[offset + 4] !== 0) continue;
    const tableEnd = offset + 27 + bytes[offset + 26];
    if (tableEnd > bytes.length) continue;
    let bodyLength = 0;
    for (let index = offset + 27; index < tableEnd; index += 1) bodyLength += bytes[index];
    if (tableEnd + bodyLength !== bytes.length) continue;
    const samples = Number(bytes.readBigInt64LE(offset + 6)) - preSkip;
    if (!Number.isSafeInteger(samples) || samples <= 0) throw invalid();
    return Math.round(samples / 48);
  }
  throw invalid();
}

/** `MM:SS`, `H:MM:SS` (either with fractional seconds) or plain seconds, in milliseconds; NaN otherwise. */
export function timestampMs(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : Number.NaN;
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const match = text.match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return Number.NaN;
  return Math.round(((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000);
}

/** Validated, ordered segments inside the narration; the provider's words are kept, never rewritten. */
export function normalizeTranscript(raw: unknown, durationMs: number) {
  const value = (raw ?? {}) as { language?: unknown; segments?: unknown };
  if (!Array.isArray(value.segments)) throw new Error('Gemini returned no segment list.');
  const segments: Array<{ startMs: number; endMs: number; text: string }> = [];
  for (const item of value.segments.slice(0, MAX_SEGMENTS) as Array<{ start?: unknown; end?: unknown; text?: unknown }>) {
    const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT_TEXT) : '';
    const start = timestampMs(item?.start);
    if (!text || Number.isNaN(start)) continue;
    const startMs = Math.max(0, Math.min(durationMs - 1, start));
    const end = timestampMs(item?.end);
    const endMs = Math.max(startMs + 1, Math.min(durationMs, Number.isNaN(end) || end <= start ? start + 1_000 : end));
    segments.push({ startMs, endMs, text });
  }
  segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const language = typeof value.language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(value.language) ? value.language : undefined;
  return { ...(language ? { language } : {}), segments };
}

const PROMPT = [
  'Transcribe the speech in this audio verbatim, in the language it is spoken. Do not translate.',
  'The speaker is a software tester narrating what they do in an app and what the app should do, while recording a test.',
  'Keep every correction, negation, number, name and product term exactly as spoken. Do not summarize, paraphrase, or add words that were not said.',
  'Split the speech into segments at sentence boundaries or natural pauses, each at most about 15 seconds long.',
  'Give each segment start and end timestamps from the beginning of the audio in MM:SS.s format.',
  'Set language to the ISO 639-1 code of the spoken language. If there is no speech, return an empty segments list.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    language: { type: 'STRING' },
    segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { start: { type: 'STRING' }, end: { type: 'STRING' }, text: { type: 'STRING' } }, required: ['start', 'end', 'text'] } },
  },
  required: ['segments'],
};

// Verbatim transcription gains nothing from thinking. Gemini 3 replaced
// thinkingBudget with thinkingLevel and rejects the old field; it also manages
// its own sampling, so temperature is set only for older models.
function modelTuning(model: string): Record<string, unknown> {
  if (model.startsWith('gemini-2')) return { temperature: 0, ...(model.startsWith('gemini-2.5-flash') ? { thinkingConfig: { thinkingBudget: 0 } } : {}) };
  return model.includes('flash') ? { thinkingConfig: { thinkingLevel: 'MINIMAL' } } : {};
}

/** Gemini on Vertex AI, authorized as the function's service account (needs roles/aiplatform.user). */
export function vertexGeminiTranscriber(options: { projectId: string; location: string; model: string }): NarrationTranscriber {
  const host = options.location === 'global' ? 'aiplatform.googleapis.com' : `${options.location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${options.projectId}/locations/${options.location}/publishers/google/models/${options.model}:generateContent`;
  return async ({ audio, mimeType }) => {
    const { access_token: token } = await applicationDefault().getAccessToken();
    const response = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(480_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data: audio.toString('base64') } }, { text: PROMPT }] }],
        generationConfig: {
          maxOutputTokens: 32_768, audioTimestamp: true, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA,
          ...modelTuning(options.model),
        },
      }),
    });
    const body = await response.json().catch(() => null) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
    if (!response.ok) throw new Error(`Vertex AI returned HTTP ${response.status}: ${body?.error?.message ?? 'no detail'}`);
    const candidate = body?.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new Error(`Gemini stopped with ${candidate?.finishReason ?? 'no candidate'}.`);
    return JSON.parse((candidate.content?.parts ?? []).map((part) => part.text ?? '').join(''));
  };
}

/** Emulator stand-in (demo- projects only): fixed speech, and a provider failure for the stream serial 0xFA11. */
export const emulatorTranscriber: NarrationTranscriber = async ({ audio, durationMs }) => {
  if (audio.readUInt32LE(14) === 0xfa11) throw new Error('Emulated provider failure.');
  const second = (ms: number) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${((ms % 60_000) / 1000).toFixed(1).padStart(4, '0')}`;
  return { language: 'en', segments: [
    { start: second(0), end: second(Math.min(durationMs, 4_000)), text: 'Open the sign in page.' },
    { start: second(Math.min(durationMs - 1, 5_000)), end: second(Math.min(durationMs, 9_000)), text: 'The welcome message should show the user name.' },
  ] };
};

export async function transcribeNarration(
  db: Firestore, actor: Actor,
  input: { organizationId: string; projectId: string; audio: string; mimeType: string },
  options: { transcribe: NarrationTranscriber; model: string; monthlyMinutes: number; now?: Date },
) {
  if (input?.mimeType !== 'audio/ogg' || typeof input.audio !== 'string' || !input.audio) throw new CommandError('invalid-argument', 'Narration audio must be an Ogg/Opus file.');
  if (input.audio.length > Math.ceil(NARRATION_MAX_BYTES / 3) * 4) throw new CommandError('invalid-argument', 'Narration audio is too large for cloud transcription.', { reason: 'too-large' });
  const audio = Buffer.from(input.audio, 'base64');
  const durationMs = oggOpusDurationMs(audio);
  if (durationMs > NARRATION_MAX_MS + DURATION_TOLERANCE_MS) throw new CommandError('failed-precondition', 'Cloud transcription accepts up to 25 minutes of narration at a time.', { reason: 'too-long' });
  const period = (options.now ?? new Date()).toISOString().slice(0, 7);
  const limitMs = Math.max(0, options.monthlyMinutes) * 60_000;
  const usage = orgRef(db, input.organizationId).collection('usage').doc(`transcription-${period}`);
  const usedMs = await db.runTransaction(async (tx) => {
    await requireProjectAuthor(tx, db, input.organizationId, input.projectId, actor);
    const organization = (await tx.get(orgRef(db, input.organizationId))).data();
    if (!isProPlan(planKind(organization))) throw new CommandError('failed-precondition', 'Gemini transcription is included in the Beta and Pro plans.', { reason: 'plan-required' });
    const used = Number((await tx.get(usage)).data()?.usedMs ?? 0);
    if (used + durationMs > limitMs) {
      throw new CommandError('resource-exhausted', `This workspace has used ${Math.ceil(used / 60_000)} of its ${options.monthlyMinutes} Gemini transcription minutes this month. Choose local Whisper transcription until the allowance renews.`, { reason: 'allowance-exhausted', usedMinutes: Math.ceil(used / 60_000), limitMinutes: options.monthlyMinutes });
    }
    tx.set(usage, { period, usedMs: FieldValue.increment(durationMs), requests: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return used + durationMs;
  });
  try {
    const transcript = normalizeTranscript(await options.transcribe({ audio, mimeType: 'audio/ogg', durationMs }), durationMs);
    return { model: options.model, durationMs, ...transcript, allowance: { usedMinutes: Math.ceil(usedMs / 60_000), limitMinutes: options.monthlyMinutes } };
  } catch (error) {
    await usage.set({ usedMs: FieldValue.increment(-durationMs), requests: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch((refund) => logger.error('transcription allowance refund failed', { organizationId: input.organizationId, durationMs, error: String(refund) }));
    logger.error('gemini transcription failed', { organizationId: input.organizationId, projectId: input.projectId, durationMs, error: String(error) });
    throw new CommandError('unavailable', 'Gemini transcription is unavailable right now. Try again, or choose local Whisper transcription.');
  }
}
