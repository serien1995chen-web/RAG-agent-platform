import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  S5AiproxyHttpAdapter,
  type S5HttpTransportPort,
} from '../../packages/service/src/modules/knowledge/adapter/s5-aiproxy-http.adapter';
import { redactProviderEvidence } from '../real-provider/s11-real-helpers';

const context = {
  workspaceId: 'ws-b15-security',
  requestId: 'req-b15-security',
  traceId: 'trace-b15-security',
};

describe('L1-B15-B model security and redaction', () => {
  it('L1-B15-B-MODEL-006-Q01 keeps bearer tokens and provider response bodies out of surfaced errors', async () => {
    const transport: S5HttpTransportPort = {
      async request<T>() {
        return {
          status: 401,
          headers: {},
          data: {
            message: 'provider echoed sensitive-business-prompt',
            authorization: 'Bearer provider-secret-token',
          } as T,
        };
      },
    };
    const adapter = new S5AiproxyHttpAdapter({
      baseUrl: 'https://aiproxy.example.invalid',
      token: 'provider-secret-token',
      transport,
    });

    let caught: unknown;
    try {
      await adapter.invoke(
        {
          kind: 'llm',
          modelId: 'llm-primary',
          messages: [{ role: 'user', content: 'sensitive-business-prompt' }],
          maxOutputTokens: 32,
        },
        context,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ kind: 'auth', status: 401 });
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain('provider-secret-token');
    expect(serialized).not.toContain('sensitive-business-prompt');
    expect(serialized).not.toContain('authorization');
  });

  it('L1-B15-B-MODEL-004-Q01 recursively redacts model credentials and object keys from evidence', () => {
    const evidence = {
      requestId: 'safe-request',
      authorization: 'Bearer secret',
      token: 'secret',
      prompt: 'internal prompt',
      nested: {
        objectKey: 'private/tenant/object.png',
        apiKey: 'secret',
        attempts: 3,
      },
    };

    const redacted = redactProviderEvidence(evidence) as Record<string, unknown>;
    expect(redacted).toMatchObject({
      requestId: 'safe-request',
      authorization: '[REDACTED]',
      token: '[REDACTED]',
      prompt: 'internal prompt',
      nested: {
        objectKey: '[REDACTED]',
        apiKey: '[REDACTED]',
        attempts: 3,
      },
    });
  });

  it('L1-B15-B-MODEL-003-Q01 provider adapter does not log request bodies or authorization headers', () => {
    const source = readFileSync(
      join(
        import.meta.dirname,
        '..',
        '..',
        'packages',
        'service',
        'src',
        'modules',
        'knowledge',
        'adapter',
        's5-aiproxy-http.adapter.ts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/console\.(?:log|info|warn|error)/);
    expect(source).not.toMatch(/logger\.(?:log|info|warn|error).*input\.body/s);
    expect(source).not.toMatch(/logger\.(?:log|info|warn|error).*Authorization/s);
  });
});
