import type {
  SafetyActionGateway,
  SafetyActionInput,
  SafetyActionResult,
} from './gameplayPorts.ts';

export async function requestSafetyAction(
  input: SafetyActionInput,
  gateway: SafetyActionGateway,
): Promise<SafetyActionResult> {
  try {
    return await gateway.requestSafetyAction(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
