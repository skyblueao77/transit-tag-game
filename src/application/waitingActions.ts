import type {
  ResumeWaitingInput,
  ResumeWaitingResult,
  StartWaitingInput,
  StartWaitingResult,
  WaitingGateway,
} from './gameplayPorts.ts';

export async function startWaiting(
  input: StartWaitingInput,
  gateway: WaitingGateway,
): Promise<StartWaitingResult> {
  try {
    return await gateway.startWaiting(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}

export async function resumeWaiting(
  input: ResumeWaitingInput,
  gateway: WaitingGateway,
): Promise<ResumeWaitingResult> {
  try {
    return await gateway.resumeWaiting(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
