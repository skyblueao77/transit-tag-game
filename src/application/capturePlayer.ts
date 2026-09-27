import type {
  CaptureGateway,
  CapturePlayerInput,
  CapturePlayerResult,
} from './gameplayPorts.ts';

export async function capturePlayer(
  input: CapturePlayerInput,
  gateway: CaptureGateway,
): Promise<CapturePlayerResult> {
  try {
    return await gateway.capture({ targetId: input.targetId });
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
