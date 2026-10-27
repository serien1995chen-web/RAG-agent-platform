import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const compose = readFileSync(join(root, 'deploy', 'docker-compose.yml'), 'utf8');

function serviceBlock(name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = compose.indexOf(marker);
  if (start < 0) return '';
  const next = compose.slice(start + marker.length).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return next < 0 ? compose.slice(start) : compose.slice(start, start + marker.length + next);
}

describe('TEST-X-COMPOSE-READY AIProxy Compose contract', () => {
  it('pins the approved AIProxy and PostgreSQL digests', () => {
    expect(serviceBlock('aiproxy')).toContain(
      'registry.cn-hangzhou.aliyuncs.com/labring/aiproxy:v0.7.3@sha256:da8d8394634eacdcf72533953c77c1e0ca3e28920545354dd20bdaa0aaa9ee4b',
    );
    expect(serviceBlock('aiproxy-postgres')).toContain(
      'registry.cn-hangzhou.aliyuncs.com/fastgpt/pgvector:0.8.0-pg15@sha256:92be4ea0424cccf17003f5803d54448e2864ac27a70e6ac5d24b3d8b463c689c',
    );
    expect(compose).not.toMatch(/aiproxy[^\n]*:latest/i);
  });

  it('keeps both local AIProxy services behind the aiproxy profile', () => {
    for (const name of ['aiproxy', 'aiproxy-postgres']) {
      const block = serviceBlock(name);
      expect(block).toContain('profiles:');
      expect(block).toContain("profiles: ['aiproxy']");
    }
  });

  it('uses an independent PostgreSQL database and readiness probes', () => {
    const database = serviceBlock('aiproxy-postgres');
    const proxy = serviceBlock('aiproxy');
    expect(database).toContain('POSTGRES_DB: aiproxy');
    expect(database).toContain('pg_isready');
    expect(proxy).toContain('aiproxy-postgres:5432/aiproxy');
    expect(proxy).toContain('http://127.0.0.1:3000/api/status');
  });

  it('passes all S5 configuration keys to app and worker without a plaintext token', () => {
    for (const name of ['app', 'worker']) {
      const block = serviceBlock(name);
      expect(block).toContain('*knowledge-environment');
    }
    for (const key of [
      'AIPROXY_MODE',
      'AIPROXY_BASE_URL',
      'AIPROXY_API_TOKEN_REF',
      'KB_EXTERNAL_MODEL_MODE',
    ]) {
      expect(compose).toContain(key);
    }
    expect(compose).toContain(
      'AIPROXY_API_TOKEN_REF: ${AIPROXY_API_TOKEN_REF:-env:AIPROXY_API_TOKEN}',
    );
    expect(serviceBlock('aiproxy')).toContain(
      'ADMIN_KEY: ${AIPROXY_API_TOKEN:-kb-local-aiproxy-token}',
    );
    expect(compose).not.toMatch(/AIPROXY_API_TOKEN:\s+(?!\$\{AIPROXY_API_TOKEN)/);
  });
});
