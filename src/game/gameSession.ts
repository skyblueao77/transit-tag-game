export const GAME_SESSION_SCHEMA_VERSION = 2;

export interface GameSessionFields {
  gameSessionId: string;
  sessionStartedAt: number;
  sessionSchemaVersion: number;
}

export type GameSessionValidation =
  | { valid: true; session: GameSessionFields }
  | { valid: false; reason: 'MISSING' | 'MALFORMED' };

export function isValidGameSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validateGameSession(config: Record<string, unknown> | null): GameSessionValidation {
  if (!config) return { valid: false, reason: 'MISSING' };
  const hasId = Object.hasOwn(config, 'gameSessionId');
  const hasStartedAt = Object.hasOwn(config, 'sessionStartedAt');
  const hasVersion = Object.hasOwn(config, 'sessionSchemaVersion');
  if (!hasId && !hasStartedAt && !hasVersion) return { valid: false, reason: 'MISSING' };
  if (!hasId || !hasStartedAt || !hasVersion
    || !isValidGameSessionId(config.gameSessionId)
    || typeof config.sessionStartedAt !== 'number'
    || !Number.isSafeInteger(config.sessionStartedAt)
    || config.sessionStartedAt < 0
    || !Number.isSafeInteger(config.sessionSchemaVersion)
    || (config.sessionSchemaVersion as number) < GAME_SESSION_SCHEMA_VERSION) {
    return { valid: false, reason: 'MALFORMED' };
  }
  return {
    valid: true,
    session: {
      gameSessionId: config.gameSessionId,
      sessionStartedAt: config.sessionStartedAt,
      sessionSchemaVersion: config.sessionSchemaVersion as number,
    },
  };
}

export function validateExpectedSession(
  config: Record<string, unknown> | null,
  expectedSessionId: unknown,
): { valid: true; gameSessionId: string } | { valid: false; reason: 'SESSION_CHANGED' } {
  if (!isValidGameSessionId(expectedSessionId)) return { valid: false, reason: 'SESSION_CHANGED' };
  const validation = validateGameSession(config);
  if (!validation.valid || validation.session.gameSessionId !== expectedSessionId) {
    return { valid: false, reason: 'SESSION_CHANGED' };
  }
  return { valid: true, gameSessionId: validation.session.gameSessionId };
}

export function sessionScopedCompletionId(
  gameSessionId: string,
  team: 'A' | 'B',
  missionId: string,
): string {
  if (!isValidGameSessionId(gameSessionId) || !missionId || missionId.includes('/')) {
    throw new Error('Invalid session completion scope');
  }
  const input = JSON.stringify([gameSessionId, team, missionId]);
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const digest = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${team}_${digest}`;
}
