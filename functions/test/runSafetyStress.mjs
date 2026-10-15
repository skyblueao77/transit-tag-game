import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-no-project';
const firestoreClearUrl = `http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`;
const authClearUrl = `http://127.0.0.1:9099/emulator/v1/projects/${projectId}/accounts`;
const runs = Number(process.argv[2] ?? 10);
const clearBetweenRuns = process.argv[3] !== 'no-clear';

if (!Number.isSafeInteger(runs) || runs < 1 || runs > 10) {
  throw new Error('Run count must be an integer between 1 and 10');
}

async function clearEmulatorState() {
  const firestoreResponse = await fetch(firestoreClearUrl, { method: 'DELETE' });
  if (!firestoreResponse.ok) throw new Error(`Firestore clear failed: ${firestoreResponse.status}`);
  const authResponse = await fetch(authClearUrl, { method: 'DELETE' });
  if (!authResponse.ok) throw new Error(`Auth clear failed: ${authResponse.status}`);
}

function runSuite(run) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let output = '';
    const child = spawn(process.execPath, [
      '--test',
      '--test-reporter=spec',
      'functions/test/safety.integration.test.mjs',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.once('error', reject);
    child.once('close', code => {
      const durationMs = Math.round(performance.now() - startedAt);
      const errors = {
        socket: (output.match(/socket hang up|ECONNRESET/gi) ?? []).length,
        timeout: (output.match(/ETIMEDOUT|timed? ?out|Projection condition not met/gi) ?? []).length,
      };
      console.log(JSON.stringify({ run, durationMs, exitCode: code, ...errors }));
      if (code !== 0) reject(new Error(`Safety Integration run ${run} failed with exit code ${code}`));
      else resolve({ run, durationMs, ...errors });
    });
  });
}

const results = [];
for (let run = 1; run <= runs; run += 1) {
  if (clearBetweenRuns) await clearEmulatorState();
  console.log(JSON.stringify({ run, phase: 'start', clearBetweenRuns }));
  results.push(await runSuite(run));
}

console.log(JSON.stringify({
  phase: 'complete',
  node: process.version,
  runs: results.length,
  pass: results.length,
  durationMs: results.map(result => result.durationMs),
  socketErrors: results.reduce((sum, result) => sum + result.socket, 0),
  timeoutErrors: results.reduce((sum, result) => sum + result.timeout, 0),
}));
