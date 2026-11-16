import { beforeAll, describe, expect, it } from 'vitest';
import { AxiosS5HttpTransport } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5AiproxyHttpAdapter } from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { S5ModelTransportError } from '../../packages/service/src/modules/knowledge/application/s5-model-gateway.port';
import {
  providerContext,
  requiredProviderEnv,
  safeHostHash,
  sha256,
  writeProviderEvidence,
} from './s11-real-helpers';

type NativeTtsResult = {
  status: number;
  requestId: string | null;
  audio: Uint8Array;
  audioHash: string;
  audioUrl: string | null;
  audioHostHash: string | null;
  usageCharacters: number | null;
};

type NativeSttResult = {
  status: number;
  requestId: string | null;
  text: string;
  safeErrorCode: string | null;
  usage: unknown;
};

const baseUrl = () => requiredProviderEnv('AIPROXY_BASE_URL').replace(/\/+$/, '');
const token = () => requiredProviderEnv('AIPROXY_API_TOKEN');

let nativeTts: NativeTtsResult;
let nativeStt: NativeSttResult;
let adapterError: { kind: string; status: number | null; safeReason: string } | null = null;

beforeAll(async () => {
  const base = baseUrl();
  const auth = { Authorization: `Bearer ${token()}` };
  const ttsResponse = await fetch(new URL('/gateway/minimax/v1/t2a_v2', base), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: requiredProviderEnv('S11_AIPROXY_TTS_MODEL'),
      text: '你好',
      output_format: 'url',
      voice_setting: {
        voice_id: requiredProviderEnv('S11_AIPROXY_TTS_VOICE'),
        speed: 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1,
      },
    }),
  });
  const ttsPayload = (await ttsResponse.json()) as {
    data?: { audio?: string };
    extra_info?: { usage_characters?: number };
  };
  const encodedAudio = ttsPayload.data?.audio ?? '';
  const audioUrl = /^https?:\/\//.test(encodedAudio) ? encodedAudio : null;
  const audio = audioUrl ? new Uint8Array() : Uint8Array.from(Buffer.from(encodedAudio, 'hex'));
  nativeTts = {
    status: ttsResponse.status,
    requestId: ttsResponse.headers.get('x-request-id'),
    audio,
    audioHash: audio.byteLength > 0 ? sha256(audio) : '',
    audioUrl,
    audioHostHash: audioUrl ? safeHostHash(audioUrl) : null,
    usageCharacters: ttsPayload.extra_info?.usage_characters ?? null,
  };

  const sttResponse = await fetch(new URL('/gateway/v1/chat/completions', base), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: requiredProviderEnv('S11_AIPROXY_STT_MODEL'),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: audioUrl ?? '' },
            },
          ],
        },
      ],
    }),
  });
  const sttPayload = (await sttResponse.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
    error?: { code?: string };
  };
  nativeStt = {
    status: sttResponse.status,
    requestId: sttResponse.headers.get('x-request-id'),
    text: sttPayload.choices?.[0]?.message?.content ?? '',
    safeErrorCode: sttPayload.error?.code ?? null,
    usage: sttPayload.usage ?? null,
  };

  const adapter = new S5AiproxyHttpAdapter({
    baseUrl: base,
    token: token(),
    transport: new AxiosS5HttpTransport(),
  });
  try {
    await adapter.invoke(
      {
        kind: 'tts',
        modelId: requiredProviderEnv('S11_AIPROXY_TTS_MODEL'),
        text: '你好',
        voice: requiredProviderEnv('S11_AIPROXY_TTS_VOICE'),
      },
      providerContext,
    );
  } catch (error) {
    if (error instanceof S5ModelTransportError) {
      adapterError = {
        kind: error.kind,
        status: error.status,
        safeReason: error.safeReason,
      };
    } else {
      adapterError = {
        kind: 'unknown',
        status: null,
        safeReason: error instanceof Error ? error.name : 'unknown_error',
      };
    }
  }

  writeProviderEvidence('t02-b15-audio.json', {
    subcases: ['L1-B15-A-MODEL-005-P01', 'L1-B15-A-MODEL-005-P02', 'L1-B15-A-MODEL-005-F01'],
    provider: 'aiproxy',
    endpointHostHash: safeHostHash(base),
    models: {
      stt: requiredProviderEnv('S11_AIPROXY_STT_MODEL'),
      tts: requiredProviderEnv('S11_AIPROXY_TTS_MODEL'),
      voice: requiredProviderEnv('S11_AIPROXY_TTS_VOICE'),
    },
    nativeTts: {
      status: nativeTts.status,
      requestId: nativeTts.requestId,
      audioBytes: nativeTts.audio.byteLength,
      audioHash: nativeTts.audioHash,
      audioUrlPresent: nativeTts.audioUrl !== null,
      audioHostHash: nativeTts.audioHostHash,
      usageCharacters: nativeTts.usageCharacters,
      mime: 'audio/mpeg',
    },
    nativeStt: {
      status: nativeStt.status,
      requestId: nativeStt.requestId,
      textLength: nativeStt.text.length,
      safeErrorCode: nativeStt.safeErrorCode,
      usage: nativeStt.usage,
    },
    openAiAudioAdapter: {
      error: adapterError,
    },
  });
}, 180_000);

describe('L1 B15 A TokenDance speech protocol validation', () => {
  it('L1-B15-A-MODEL-005-P01 TokenDance 原生 TTS 返回可播放音频和真实 usage', () => {
    expect(nativeTts.status).toBe(200);
    expect(nativeTts.audioUrl).not.toBeNull();
    expect(nativeTts.audioHostHash).toMatch(/^[a-f0-9]{16}$/);
    expect(nativeTts.usageCharacters).toBeGreaterThan(0);
  });

  it('L1-B15-A-MODEL-005-P02 TokenDance STT 识别短句并返回非空文本', () => {
    expect(nativeStt.status).toBe(200);
    expect(nativeStt.text.trim().length).toBeGreaterThan(0);
  });

  it('L1-B15-A-MODEL-005-F01 OpenAI 语音路径不把 TokenDance 404 伪装为成功', () => {
    expect(adapterError).not.toBeNull();
    expect(adapterError?.status).toBe(404);
    expect(adapterError?.safeReason).toBe('aiproxy_http_error');
  });
});
