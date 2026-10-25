import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE_KEYS } from '../../src/i18n/error-message-keys';
import { formatDate, toProblemView } from '../../src/i18n';
import { messages } from '../../src/i18n/messages';

describe('knowledge i18n and problem rendering', () => {
  it('keeps complete zh-CN and en key sets', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages['zh-CN']).sort());
    expect(Object.keys(messages['zh-CN']).length).toBeGreaterThan(100);
  });

  it('maps every declared Knowledge error code to local copy', () => {
    expect(Object.keys(ERROR_MESSAGE_KEYS)).toHaveLength(22);
    for (const key of Object.values(ERROR_MESSAGE_KEYS)) {
      expect(messages['zh-CN'][key]).toBeTruthy();
      expect(messages.en[key]).toBeTruthy();
    }
  });

  it('derives a safe ProblemView without backend message text', () => {
    const view = toProblemView({
      success: false,
      error: {
        code: 'KNOWLEDGE_CONFLICT',
        message: '<script>must-not-render</script>',
        retryable: false,
        details: { field: 'name', attempt: 2, nested: { unsafe: true } },
      },
      traceId: 'trace-a',
      requestId: 'request-a',
    });
    expect(view).toEqual({
      code: 'KNOWLEDGE_CONFLICT',
      messageKey: 'errors.conflict',
      params: { field: 'name', attempt: 2 },
      traceId: 'trace-a',
      requestId: 'request-a',
      retryable: false,
    });
    expect(JSON.stringify(view)).not.toContain('must-not-render');
  });

  it('falls back safely for unknown codes and formats dates by locale', () => {
    const view = toProblemView({
      success: false,
      error: {
        code: 'KNOWLEDGE_FUTURE_CODE' as never,
        message: 'internal provider response',
        retryable: true,
        details: {},
      },
      traceId: 'trace-b',
      requestId: 'request-b',
    });
    expect(view.code).toBe('UNKNOWN_ERROR');
    expect(view.messageKey).toBe('errors.unknown');
    expect(formatDate('2026-10-24T12:00:00.000Z', 'zh-CN')).not.toBe(
      formatDate('2026-10-24T12:00:00.000Z', 'en'),
    );
  });

  it('fails typecheck for an unknown MessageKey fixture', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..');
    const tsc = resolve(repositoryRoot, 'node_modules/typescript/bin/tsc');
    const messagesModule = resolve(repositoryRoot, 'packages/web/src/i18n/messages').replaceAll(
      '\\',
      '/',
    );
    const directory = mkdtempSync(join(tmpdir(), 'kb-message-key-'));
    try {
      const valid = join(directory, 'valid.ts');
      const invalid = join(directory, 'invalid.ts');
      writeFileSync(
        valid,
        `import type { MessageKey } from '${messagesModule}';\n` +
          "const validKey: MessageKey = 'spaces.title';\nvoid validKey;\n",
      );
      writeFileSync(
        invalid,
        `import type { MessageKey } from '${messagesModule}';\n` +
          "const invalidKey: MessageKey = 'spaces.notARealKey';\nvoid invalidKey;\n",
      );
      const args = [
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'Bundler',
      ];
      const validResult = spawnSync(process.execPath, [tsc, ...args, valid], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      expect(validResult.status, `${validResult.stdout}\n${validResult.stderr}`).toBe(0);

      const invalidResult = spawnSync(process.execPath, [tsc, ...args, invalid], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      expect(invalidResult.status).not.toBe(0);
      expect(`${invalidResult.stdout}\n${invalidResult.stderr}`).toContain('TS2322');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
