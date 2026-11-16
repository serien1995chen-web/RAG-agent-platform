import { describe, expect, it } from 'vitest';
import {
  S5AiproxyHttpAdapter,
  type S5HttpRequest,
  type S5HttpResponse,
  type S5HttpTransportPort,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';

const context = {
  workspaceId: 'ws_b15_speech',
  requestId: 'req_b15_speech',
  traceId: 'trace_b15_speech',
};

class RecordingTransport implements S5HttpTransportPort {
  readonly requests: S5HttpRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async request<T = unknown>(input: S5HttpRequest): Promise<S5HttpResponse<T>> {
    this.requests.push(input);
    return {
      status: 200,
      headers: {},
      data: this.responses.shift() as T,
    };
  }
}

describe('L1-B15-A TokenDance speech adapter contract', () => {
  it('L1-B15-A-MODEL-005-P01 uses the MiniMax native TTS endpoint and preserves character usage', async () => {
    const transport = new RecordingTransport([
      {
        data: { audio: 'https://audio.example.invalid/result.mp3' },
        extra_info: { usage_characters: 4 },
      },
    ]);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://tokendance.example.invalid',
      token: 'fake-provider-token',
      transport,
      ttsProtocol: 'minimax-native',
      defaultTtsVoice: 'voice-default',
    });

    const result = await adapter.invoke(
      {
        kind: 'tts',
        modelId: 'tts-native',
        text: '你好',
      },
      context,
    );

    expect(transport.requests[0]).toMatchObject({
      url: 'https://tokendance.example.invalid/gateway/minimax/v1/t2a_v2',
      responseType: 'json',
      body: {
        model: 'tts-native',
        text: '你好',
        output_format: 'url',
        voice_setting: { voice_id: 'voice-default' },
      },
    });
    expect(result).toMatchObject({
      data: {
        audioUrl: 'https://audio.example.invalid/result.mp3',
        mimeType: 'audio/mpeg',
        usageCharacters: 4,
      },
      quantity: 4,
      quantityUnit: 'character',
    });
  });

  it('L1-B15-A-MODEL-005-P02 uses native chat audio for STT and returns non-empty text with usage', async () => {
    const transport = new RecordingTransport([
      {
        choices: [{ message: { content: '你好' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    ]);
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://tokendance.example.invalid',
      token: 'fake-provider-token',
      transport,
      sttProtocol: 'chat-audio-native',
    });

    const result = await adapter.invoke(
      {
        kind: 'stt',
        modelId: 'stt-native',
        audio: Uint8Array.from([1, 2, 3]),
        mimeType: 'audio/mpeg',
      },
      context,
    );

    expect(transport.requests[0]).toMatchObject({
      url: 'https://tokendance.example.invalid/gateway/v1/chat/completions',
      body: {
        model: 'stt-native',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: 'data:audio/mpeg;base64,AQID' },
              },
            ],
          },
        ],
      },
    });
    expect(result).toMatchObject({
      data: { text: '你好' },
      usage: { inputTokens: 7, outputTokens: 2 },
    });
  });
});
