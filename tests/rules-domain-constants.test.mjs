import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CAPTURE_WAIT_DURATION_MS,
  INVINCIBILITY_DURATION_MS,
  SHINKANSEN_WAIT_DURATION_MS,
} from '../src/game/time.ts';

test('Domain time constants align with firestore.rules threshold limits (+60s tolerance)', () => {
  const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
  const rulesContent = fs.readFileSync(rulesPath, 'utf-8');

  // Tolerance allowance for client-server clock skew in firestore.rules is 60,000ms (60s)
  const CLOCK_SKEW_TOLERANCE_MS = 60_000;

  // 1. Invincibility max allowed limit in rules
  const expectedInvincibilityLimit = INVINCIBILITY_DURATION_MS + CLOCK_SKEW_TOLERANCE_MS;
  assert.equal(INVINCIBILITY_DURATION_MS, 30 * 60 * 1000, 'Domain invincibility duration must be 30 minutes (1,800,000 ms)');
  assert.equal(expectedInvincibilityLimit, 1860000);
  assert.ok(
    rulesContent.includes(`a.invincibleUntil <= nowMs + ${expectedInvincibilityLimit}`),
    `firestore.rules must enforce invincibleUntil <= nowMs + ${expectedInvincibilityLimit}`,
  );

  // 2. Capture waiting time max limit in rules
  const expectedCaptureWaitLimit = CAPTURE_WAIT_DURATION_MS + CLOCK_SKEW_TOLERANCE_MS;
  assert.equal(CAPTURE_WAIT_DURATION_MS, 30 * 60 * 1000, 'Domain capture wait duration must be 30 minutes (1,800,000 ms)');
  assert.equal(expectedCaptureWaitLimit, 1860000);
  assert.ok(
    rulesContent.includes(`a.waitingUntil <= nowMs + ${expectedCaptureWaitLimit}`),
    `firestore.rules must enforce waitingUntil <= nowMs + ${expectedCaptureWaitLimit}`,
  );
  assert.ok(
    rulesContent.includes(`getAfter(targetPath).data.waitingUntil <= nowMs + ${expectedCaptureWaitLimit}`),
    `firestore.rules validCaptureConfigUpdate must enforce waitingUntil <= nowMs + ${expectedCaptureWaitLimit}`,
  );

  // 3. Shinkansen wait duration limit in rules
  const expectedShinkansenLimit = SHINKANSEN_WAIT_DURATION_MS + CLOCK_SKEW_TOLERANCE_MS;
  assert.equal(SHINKANSEN_WAIT_DURATION_MS, 60 * 60 * 1000, 'Domain shinkansen wait duration must be 60 minutes (3,600,000 ms)');
  assert.equal(expectedShinkansenLimit, 3660000);
  assert.ok(
    rulesContent.includes(`a.waitingUntil <= nowMs + ${expectedShinkansenLimit}`),
    `firestore.rules must enforce shinkansen waitingUntil <= nowMs + ${expectedShinkansenLimit}`,
  );
});
