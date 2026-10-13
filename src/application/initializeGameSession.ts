import type {
  InitializeGameSessionGateway,
  InitializeGameSessionInput,
  InitializeGameSessionResult,
} from './gameplayPorts.ts';

export async function initializeGameSession(
  input: InitializeGameSessionInput,
  gateway: InitializeGameSessionGateway,
): Promise<InitializeGameSessionResult> {
  try {
    return await gateway.initialize(input);
  } catch {
    return { ok: false, reason: 'PERSISTENCE_ERROR' };
  }
}
