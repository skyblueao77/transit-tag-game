import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(root, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js');
const preloadPath = path.join(root, 'functions', 'test', 'projectionTracePreload.cjs').replaceAll('\\', '/');
const functionsRoot = path.join(root, 'functions');
const existingNodeOptions = process.env.NODE_OPTIONS ?? '';
const traceEnabled = process.argv[3] !== 'no-trace';
const nodeOptions = traceEnabled
  ? `${existingNodeOptions} --require ${JSON.stringify(preloadPath)}`.trim()
  : existingNodeOptions;
const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
  NODE_OPTIONS: nodeOptions,
  TTG_PROJECTION_TRACE: traceEnabled ? '1' : '0',
  TTG_FUNCTIONS_ROOT: functionsRoot,
};
const testCommand = process.argv[2] ?? 'node --test --test-reporter=spec functions/test/safety.integration.test.mjs';
const args = [
  cliPath,
  'emulators:exec',
  '--project', 'demo-no-project',
  '--only', 'auth,firestore,functions',
  testCommand,
];

console.log(JSON.stringify({
  mode: traceEnabled ? 'emulator-only-transaction-trace' : 'node-22-emulator-validation',
  node: process.version,
  preloadPath,
  target: testCommand,
}));

function parseMarkedJsonLines(text, marker) {
  return text.split(/\r?\n/).flatMap(line => {
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) return [];
    const jsonIndex = line.indexOf('{', markerIndex + marker.length);
    if (jsonIndex < 0) return [];
    try {
      return [JSON.parse(line.slice(jsonIndex))];
    } catch {
      return [];
    }
  });
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    minMs: sorted[0],
    medianMs: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted[sorted.length - 1],
  };
}

function reportSuccessfulProjectionTimings(text) {
  const traces = parseMarkedJsonLines(text, 'PROJECTION_TRACE ');
  const samples = parseMarkedJsonLines(text, 'PROJECTION_LATENCY_SAMPLE ');
  if (!samples.length) return;
  const transactions = new Map();
  for (const record of traces) {
    if (record.traceId === undefined) continue;
    const key = `${record.pid ?? 'unknown'}:${record.traceId}`;
    const records = transactions.get(key) ?? [];
    records.push(record);
    transactions.set(key, records);
  }

  const dispatchLatencies = [];
  const triggerToProjectionLatencies = [];
  let matched = 0;
  for (const sample of samples) {
    const transaction = [...transactions.values()].find(records => records.some(record =>
      record.event === 'write-queued'
      && record.path === `emergencyLocationProjections/${sample.uid}`
      && record.fields?.sourceLocationUpdatedAt === sample.sourceUpdatedAt)
      && records.some(record => record.event === 'transaction-committed'));
    const write = transaction?.find(record => record.event === 'write-queued'
      && record.path === `emergencyLocationProjections/${sample.uid}`
      && record.fields?.sourceLocationUpdatedAt === sample.sourceUpdatedAt);
    const triggerStart = traces.find(record => record.event === 'trigger-start'
      && record.eventId === write?.eventId
      && record.pid === write?.pid);
    if (!triggerStart || typeof sample.locationCommitAt !== 'string' || typeof sample.projectionCommitAt !== 'string') continue;

    const locationCommitMs = Date.parse(sample.locationCommitAt);
    const projectionCommitMs = Date.parse(sample.projectionCommitAt);
    const dispatchLatencyMs = triggerStart.atMs - locationCommitMs;
    const triggerToProjectionLatencyMs = projectionCommitMs - triggerStart.atMs;
    dispatchLatencies.push(dispatchLatencyMs);
    triggerToProjectionLatencies.push(triggerToProjectionLatencyMs);
    matched += 1;
    console.log(`PROJECTION_TRIGGER_TIMING_SAMPLE ${JSON.stringify({
      uid: sample.uid,
      sourceUpdatedAt: sample.sourceUpdatedAt,
      eventId: triggerStart.eventId,
      triggerDocument: triggerStart.triggerDocument,
      locationCommitAt: sample.locationCommitAt,
      triggerStartedAt: new Date(triggerStart.atMs).toISOString(),
      projectionCommitAt: sample.projectionCommitAt,
      commitToCommitLatencyMs: sample.commitToCommitLatencyMs,
      locationCommitToTriggerStartMs: dispatchLatencyMs,
      triggerStartToProjectionCommitMs: triggerToProjectionLatencyMs,
    })}`);
  }
  console.log(`PROJECTION_TRIGGER_TIMING_SUMMARY ${JSON.stringify({
    matchedSamples: matched,
    sampleCount: samples.length,
    locationCommitToTriggerStart: summarize(dispatchLatencies),
    triggerStartToProjectionCommit: summarize(triggerToProjectionLatencies),
    commitToCommit: summarize(samples.map(sample => sample.commitToCommitLatencyMs)),
    environment: 'Node 22 local Emulator only; no Production extrapolation',
  })}`);
}

const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk.toString(); });
child.stderr.on('data', chunk => { stderr += chunk.toString(); });
child.once('error', error => {
  console.error('Unable to launch Firebase Emulator CLI:', error.message);
  process.exitCode = 1;
});
child.once('close', code => {
  process.exitCode = code ?? 1;
  const combined = `${stdout}\n${stderr}`;
  if (process.exitCode === 0) {
    const summaryLines = combined.split(/\r?\n/).filter(line => /✔|tests? \d+|suites? \d+|duration_ms|socket hang up|ECONNRESET|ETIMEDOUT|"run"|"phase":"complete"|PROJECTION_LATENCY_(?:SAMPLE|SUMMARY)|PROJECTION_TRACE .*"event":"trigger-(?:start|end)".*"triggerDocument":"privateLocations\/\{uid\}"/i.test(line));
    process.stdout.write(`${summaryLines.join('\n')}\n`);
    reportSuccessfulProjectionTimings(combined);
    return;
  }
  const failureUids = [...new Set([...combined.matchAll(/Projection (?:condition not met|source timestamp not observed) for ([A-Za-z0-9_-]+)/g)]
    .map(match => match[1]))];
  console.error(JSON.stringify({ exitCode: process.exitCode, failureUids }));
  if (!failureUids.length) {
    console.error(combined.split(/\r?\n/).slice(-120).join('\n'));
    return;
  }

  const traceRecords = [];
  for (const line of combined.split(/\r?\n/)) {
    const marker = line.indexOf('PROJECTION_TRACE ');
    if (marker < 0) continue;
    try {
      traceRecords.push(JSON.parse(line.slice(marker + 'PROJECTION_TRACE '.length)));
    } catch {
      console.error(`Unparseable projection trace line: ${line}`);
    }
  }

  for (const uid of failureUids) {
    const relevantRecords = traceRecords.filter(record => typeof record.path === 'string' && record.path.includes(uid));
    const relatedTransactionKeys = new Set(relevantRecords
      .filter(record => record.traceId !== undefined)
      .map(record => `${record.pid ?? 'unknown'}:${record.traceId}`));
    console.error(`Failure UID ${uid}; transactions ${JSON.stringify([...relatedTransactionKeys])}`);
    for (const transactionKey of relatedTransactionKeys) {
      const records = traceRecords.filter(record => `${record.pid ?? 'unknown'}:${record.traceId}` === transactionKey);
      const summary = {
        transactionKey,
        functionTarget: records.find(record => record.functionTarget)?.functionTarget,
        traceStartedAt: records.find(record => record.atMs !== undefined)?.atMs,
        traceEndedAt: [...records].reverse().find(record => record.atMs !== undefined)?.atMs,
        attempts: [...new Set(records.map(record => record.attempt).filter(value => value !== undefined))],
        reads: records.filter(record => record.event === 'read-complete' || record.event === 'read-error')
          .map(({ path, exists, fields, code }) => ({ path, exists, fields, code })),
        writes: records.filter(record => record.event === 'write-queued')
          .map(({ method, path, fields }) => ({ method, path, fields })),
        result: records.filter(record => record.event.startsWith('transaction-')
          && !['transaction-attempt-start'].includes(record.event))
          .map(({ event, attempt, attempts, writeCount, code, atMs }) => ({ event, attempt, attempts, writeCount, code, atMs })),
      };
      console.error(`PROJECTION_TRANSACTION ${JSON.stringify(summary)}`);
    }
  }

  console.error('Failure assertion summaries:');
  for (const line of combined.split(/\r?\n/)) {
    if (/not ok|ERR_ASSERTION|Projection condition not met for/.test(line)) console.error(line);
  }
  const uidLifecycleLines = combined.split(/\r?\n/).filter(line => failureUids.some(uid => line.includes(uid))
    && !line.includes('PROJECTION_TRACE '));
  if (uidLifecycleLines.length) {
    console.error('UID-correlated Emulator lifecycle lines:');
    for (const line of uidLifecycleLines) console.error(line);
  }
});
