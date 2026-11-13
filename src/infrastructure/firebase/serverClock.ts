const MAX_PENDING_WRITE_AGE_MS = 30_000;

let serverTimeOffsetMs = 0;
let pendingWriteStartedClientMs: number | null = null;

export function getServerTimeOffsetMs(): number {
  return serverTimeOffsetMs;
}

export function getServerNowMs(clientNowMs = Date.now()): number {
  return clientNowMs + serverTimeOffsetMs;
}

export function markServerTimestampWriteSent(clientNowMs = Date.now()): void {
  if (!Number.isFinite(clientNowMs)) return;
  pendingWriteStartedClientMs = clientNowMs;
}

export function recordConfirmedServerTimestamp(
  serverTimestampMs: number,
  options?: {
    hasPendingWrites?: boolean;
    fromCache?: boolean;
    clientNowMs?: number;
  },
): boolean {
  if (options?.hasPendingWrites || options?.fromCache) return false;
  if (!Number.isFinite(serverTimestampMs) || serverTimestampMs <= 0) return false;
  if (pendingWriteStartedClientMs === null) return false;

  const receivedClientMs = options?.clientNowMs ?? Date.now();
  if (!Number.isFinite(receivedClientMs) || receivedClientMs < pendingWriteStartedClientMs) {
    pendingWriteStartedClientMs = null;
    return false;
  }

  const rttMs = receivedClientMs - pendingWriteStartedClientMs;
  if (rttMs > MAX_PENDING_WRITE_AGE_MS) {
    pendingWriteStartedClientMs = null;
    return false;
  }

  const midpointClientMs = Math.round((pendingWriteStartedClientMs + receivedClientMs) / 2);
  serverTimeOffsetMs = serverTimestampMs - midpointClientMs;
  pendingWriteStartedClientMs = null;
  return true;
}

export function setServerTimeOffsetMsForTest(offsetMs: number): void {
  serverTimeOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
}

export function resetServerClockForTest(): void {
  serverTimeOffsetMs = 0;
  pendingWriteStartedClientMs = null;
}
