import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [name, command, runId] = process.argv.slice(2);
if (!name || !command || !runId) {
  throw new Error('usage: node run-command.mjs <name> <command> <runId>');
}

const root = resolve(import.meta.dirname, '../../..');
const resultDir = resolve(root, 'test-results', 'b13b', runId);
const logDir = resolve(resultDir, 'logs');
await mkdir(logDir, { recursive: true });
const startedAt = new Date().toISOString();
const started = Date.now();
const child = spawn(command, {
  cwd: root,
  shell: true,
  env: { ...process.env, CODEXB_RUN_ID: runId, CODEXB_COMMAND_NAME: name },
});
const stdout = [];
const stderr = [];
child.stdout.on('data', (chunk) => {
  stdout.push(Buffer.from(chunk));
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  stderr.push(Buffer.from(chunk));
  process.stderr.write(chunk);
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolveExit(code ?? 1));
});
const endedAt = new Date().toISOString();
const commandsPath = resolve(resultDir, 'commands.json');
let previous = { schemaVersion: 1, runId, commands: [] };
try {
  previous = JSON.parse(await readFile(commandsPath, 'utf8'));
} catch {
  // The first captured command initializes the evidence file.
}
await Promise.all([
  writeFile(resolve(logDir, `${name}.stdout.log`), Buffer.concat(stdout)),
  writeFile(resolve(logDir, `${name}.stderr.log`), Buffer.concat(stderr)),
  writeFile(
    commandsPath,
    JSON.stringify(
      {
        ...previous,
        commands: [
          ...(previous.commands ?? []),
          {
            commandId: randomUUID(),
            name,
            command,
            startedAt,
            endedAt,
            durationMs: Date.now() - started,
            exitCode,
            stdoutLog: `logs/${name}.stdout.log`,
            stderrLog: `logs/${name}.stderr.log`,
          },
        ],
      },
      null,
      2,
    ),
  ),
]);
process.exitCode = exitCode;
