import type { AdminPhaseGateway, TransitionGamePhaseInput, TransitionGamePhaseResult } from './gameplayPorts';

export async function transitionGamePhase(input: TransitionGamePhaseInput, gateway: AdminPhaseGateway): Promise<TransitionGamePhaseResult> {
  try { return await gateway.transitionGamePhase(input); }
  catch { return { ok: false, reason: 'PERSISTENCE_ERROR' }; }
}
