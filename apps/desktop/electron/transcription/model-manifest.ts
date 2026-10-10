export const WHISPER_RUNTIME = {
  name: 'whisper.cpp' as const,
  version: '1.9.4',
  license: 'MIT',
  sourceUrl: 'https://github.com/ggml-org/whisper.cpp/tree/v1.9.4',
};

export interface WhisperModelManifest {
  id: string;
  displayName: string;
  family: 'whisper';
  variant: string;
  quantization: string;
  multilingual: true;
  supportedLanguages: 'multilingual';
  byteLength: number;
  sha256: string;
  license: string;
  sourceUrl: string;
  fileName: string;
}

export const DEFAULT_WHISPER_MODEL: WhisperModelManifest = {
  id: 'whisper-small-q5_1-multilingual',
  displayName: 'Whisper Small · multilingual',
  family: 'whisper' as const,
  variant: 'small',
  quantization: 'q5_1',
  multilingual: true,
  supportedLanguages: 'multilingual' as const,
  byteLength: 190_085_487,
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  license: 'MIT runtime; model weights distributed by the whisper.cpp project from OpenAI Whisper weights',
  sourceUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin',
  fileName: 'ggml-small-q5_1.bin',
};
