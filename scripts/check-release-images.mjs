#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const manifestPath = join(repositoryRoot, 'deploy', 'release-images.data.json');
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RESOLVED_REF =
  /^(?<repository>(?:[^/@]+(?:\.[^/:]+|:[0-9]+)?\/)?[^/@:]+):(?<tag>[^@]+)@(?<digest>sha256:[a-f0-9]{64})$/;

export function loadManifest(path = manifestPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  const expected = ['mongo', 'redis', 'pgvector', 'minio', 'aiproxy', 'app', 'worker'];
  const services = new Map(manifest.services.map((entry) => [entry.service, entry]));
  if (services.size !== manifest.services.length) errors.push('service must be unique');
  for (const name of expected) {
    if (!services.has(name)) errors.push(`missing service ${name}`);
  }
  for (const service of manifest.services) {
    if (service.tag === 'latest') errors.push(`${service.service}: latest is forbidden`);
    if (service.platform !== 'linux/amd64') {
      errors.push(`${service.service}: platform must be linux/amd64`);
    }
    if (service.pullPolicy !== 'IfNotPresent') {
      errors.push(`${service.service}: pullPolicy must be IfNotPresent`);
    }
    if (service.digest !== null && !DIGEST.test(service.digest)) {
      errors.push(`${service.service}: digest must be sha256:64hex`);
    }
  }
  const app = services.get('app');
  const worker = services.get('worker');
  if (
    app &&
    worker &&
    (app.repository !== worker.repository || app.tag !== worker.tag || app.digest !== worker.digest)
  ) {
    errors.push('app/worker must use the same image reference');
  }
  return errors;
}

export function parseResolvedImage(value) {
  const match = RESOLVED_REF.exec(value ?? '');
  if (!match?.groups) return null;
  return {
    reference: value,
    repository: match.groups.repository,
    tag: match.groups.tag,
    digest: match.groups.digest,
  };
}

export function inspectCompose(env = process.env) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      join(repositoryRoot, 'deploy', 'docker-compose.yml'),
      '-f',
      join(repositoryRoot, 'deploy', 'docker-compose.release.yml'),
      '--profile',
      'aiproxy',
      'config',
      '--format',
      'json',
    ],
    {
      encoding: 'utf8',
      env,
    },
  );
  if (result.status !== 0) {
    return {
      status: 'FAIL',
      error: (result.stderr || result.stdout).trim().slice(0, 2_000),
      services: {},
    };
  }
  const config = JSON.parse(result.stdout);
  return {
    status: 'PASS',
    error: null,
    services: Object.fromEntries(
      Object.entries(config.services ?? {}).map(([name, service]) => [
        name,
        typeof service === 'object' && service !== null ? (service.image ?? null) : null,
      ]),
    ),
  };
}

export function checkReleaseImages(
  input = {
    env: process.env,
    allowMissingApp: false,
  },
) {
  const manifest = loadManifest();
  const errors = validateManifest(manifest);
  const blockers = [];
  const services = new Map(manifest.services.map((entry) => [entry.service, entry]));
  const providedRef = parseResolvedImage(input.env.KB_APP_IMAGE_REF);
  if (providedRef) {
    for (const name of ['app', 'worker']) {
      const service = services.get(name);
      if (
        !service ||
        service.repository !== providedRef.repository ||
        service.tag !== providedRef.tag ||
        service.digest !== providedRef.digest
      ) {
        errors.push(`${name}: manifest does not match KB_APP_IMAGE_REF repository/tag/digest`);
      }
    }
  } else if (!input.allowMissingApp) {
    errors.push('RELEASE_BLOCKED_APP_IMAGE: KB_APP_IMAGE_REF is missing');
  } else {
    blockers.push({
      code: 'PENDING_RELEASE_EVIDENCE',
      detail: 'application Registry manifest digest is deferred to production release',
    });
  }
  const compose = inspectCompose(input.env);
  if (compose.status !== 'PASS') {
    errors.push(`COMPOSE_CONFIG_FAILED: ${compose.error}`);
  } else {
    for (const [name, expected] of [
      ['mongo', services.get('mongo')],
      ['redis', services.get('redis')],
      ['pgvector', services.get('pgvector')],
      ['minio', services.get('minio')],
      ['aiproxy', services.get('aiproxy')],
      ['aiproxy-postgres', services.get('pgvector')],
      ['aiproxy-init', services.get('pgvector')],
      ['app', services.get('app')],
      ['worker', services.get('worker')],
    ]) {
      const actual = compose.services[name];
      if (!expected || !actual) {
        errors.push(`compose service ${name} is missing`);
        continue;
      }
      const resolved = parseResolvedImage(actual);
      if (
        resolved &&
        (resolved.repository !== expected.repository ||
          resolved.tag !== expected.tag ||
          resolved.digest !== expected.digest)
      ) {
        errors.push(`compose service ${name} does not match release manifest`);
      }
      if (
        !resolved &&
        expected.digest !== null &&
        actual !== `${expected.repository}:${expected.tag}@${expected.digest}`
      ) {
        errors.push(`compose service ${name} has no pinned digest`);
      }
    }
  }
  return {
    status:
      errors.length > 0
        ? 'FAIL'
        : blockers.length > 0 && input.allowMissingApp
          ? 'DEFERRED_TO_PRODUCTION'
          : blockers.length > 0
            ? 'BLOCKED'
            : 'PASS',
    errors,
    blockers,
    appImageRef: providedRef?.reference ?? null,
    thirdPartyDigests: manifest.services
      .filter((entry) => entry.digest !== null)
      .map((entry) => ({
        service: entry.service,
        repository: entry.repository,
        tag: entry.tag,
        digest: entry.digest,
        platform: entry.platform,
      })),
    composeStatus: compose.status,
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const allowMissingApp = argv.includes('--allow-missing-app');
  const result = checkReleaseImages({ env, allowMissingApp });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'PASS') return 0;
  if (result.status === 'DEFERRED_TO_PRODUCTION' && allowMissingApp) {
    console.error('PENDING_RELEASE_EVIDENCE');
    return 0;
  }
  for (const error of result.errors) console.error(error);
  return result.errors.length > 0 ? 1 : 2;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main());
