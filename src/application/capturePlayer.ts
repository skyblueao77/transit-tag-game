import { resolveCapture } from '../game/capture.ts';
import type { CapturePlayerInput, CapturePlayerResult, CaptureStore } from './gameplayPorts.ts';

export async function capturePlayer(
  input: CapturePlayerInput,
  store: CaptureStore,
): Promise<CapturePlayerResult> {
  const capture = resolveCapture(input);
  if (capture.allowed === false) {
    return {
      ok: false,
      reason: 'CAPTURE_REJECTED',
      domainReason: capture.reason,
    };
  }

  try {
    await store.applyCapture(capture);
    return { ok: true, capture };
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
