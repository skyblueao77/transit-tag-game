import { activateInvincibility as resolveInvincibility } from '../../../src/game/powerups';
import { getTeamRole } from '../../../src/game/roles';
import type { GameStatus, Role } from '../../../src/game/types';

export type InvincibilityFailureReason =
  | 'INVALID_ARGUMENT'
  | 'PLAYER_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  | 'INVALID_PLAYER_STATE'
  | 'INVALID_GAME_CONFIG'
  | 'POWERUP_NOT_ALLOWED'
  | 'WRONG_ROLE'
  | 'NO_CARDS'
  | 'ALREADY_ACTIVE'
  | 'PERSISTENCE_ERROR';

export type InvincibilityDomainReason = 'PHASE';

export class InvincibilityServiceError extends Error {
  constructor(
    readonly reason: InvincibilityFailureReason,
    readonly domainReason?: InvincibilityDomainReason,
  ) {
    super(reason);
    this.name = 'InvincibilityServiceError';
  }
}

export interface InvincibilityLog {
  id: string;
  timestamp: number;
  message: string;
  type: 'SYSTEM';
}

export interface InvincibilityWrite {
  playerId: string;
  invincibleCards: number;
  invincibleUntil: number;
  logs: unknown[];
}

export interface InvincibilityTransaction {
  readPlayer(uid: string): Promise<Record<string, unknown> | null>;
  readGameConfig(): Promise<Record<string, unknown> | null>;
  writeInvincibility(write: InvincibilityWrite): void;
}

export interface InvincibilityStore {
  runTransaction<T>(work: (transaction: InvincibilityTransaction) => Promise<T>): Promise<T>;
}

export interface InvincibilityRuntime {
  now(): number;
  createLogId(): string;
}

export interface InvincibilityResult {
  ok: true;
  remainingCards: number;
  invincibleUntil: number;
  duration: number;
}

const gameStatuses: readonly GameStatus[] = [
  'PRE_GAME',
  'DAY1_ACTIVE',
  'DAY1_PAUSED',
  'DAY1_ENDED',
  'DAY2_ACTIVE',
  'DAY2_PAUSED',
  'FINAL_MISSION',
  'GAME_OVER',
];
const roles: readonly Role[] = ['ONI', 'RUNNER'];
const playerStatuses = ['ACTIVE', 'CAPTURED', 'WAITING', 'EMERGENCY', 'RETIRED'] as const;

function isGameStatus(value: unknown): value is GameStatus {
  return typeof value === 'string' && gameStatuses.includes(value as GameStatus);
}

function isRole(value: unknown): value is Role {
  return typeof value === 'string' && roles.includes(value as Role);
}

function createSystemLog(
  id: string,
  timestamp: number,
  team: 'A' | 'B',
  name: string,
): InvincibilityLog {
  const time = new Date(timestamp).toLocaleTimeString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  });
  return {
    id,
    timestamp,
    message: `${time} Team ${team} ${name} が無敵カードを使用`,
    type: 'SYSTEM',
  };
}

export async function activateInvincibilityForPlayer(
  uid: string,
  store: InvincibilityStore,
  runtime: InvincibilityRuntime,
): Promise<InvincibilityResult> {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new InvincibilityServiceError('INVALID_ARGUMENT');
  }

  try {
    const now = runtime.now();
    const logId = runtime.createLogId();
    if (!Number.isFinite(now) || typeof logId !== 'string' || logId.length === 0) {
      throw new InvincibilityServiceError('PERSISTENCE_ERROR');
    }

    return await store.runTransaction(async transaction => {
      const [player, config] = await Promise.all([
        transaction.readPlayer(uid),
        transaction.readGameConfig(),
      ]);

      if (!player) throw new InvincibilityServiceError('PLAYER_NOT_FOUND');
      if (!config) throw new InvincibilityServiceError('CONFIG_NOT_FOUND');

      if (player.id !== uid
        || (player.team !== 'A' && player.team !== 'B')
        || typeof player.name !== 'string'
        || player.name.trim().length === 0
        || typeof player.status !== 'string'
        || !playerStatuses.includes(player.status as typeof playerStatuses[number])
        || typeof player.invincibleCards !== 'number'
        || !Number.isFinite(player.invincibleCards)
        || !Number.isInteger(player.invincibleCards)
        || player.invincibleCards < 0
        || (player.invincibleUntil !== undefined
          && (typeof player.invincibleUntil !== 'number'
            || !Number.isFinite(player.invincibleUntil)
            || player.invincibleUntil < 0))) {
        throw new InvincibilityServiceError('INVALID_PLAYER_STATE');
      }
      if (player.status !== 'ACTIVE') {
        throw new InvincibilityServiceError('POWERUP_NOT_ALLOWED');
      }

      if (!isGameStatus(config.gameStatus)
        || !isRole(config.teamARole)
        || !isRole(config.teamBRole)
        || (config.logs !== undefined && !Array.isArray(config.logs))) {
        throw new InvincibilityServiceError('INVALID_GAME_CONFIG');
      }

      const team = player.team;
      const role = getTeamRole(team, {
        teamARole: config.teamARole,
        teamBRole: config.teamBRole,
      });
      const activation = resolveInvincibility({
        role,
        invincibleCards: player.invincibleCards,
        ...(player.invincibleUntil === undefined
          ? {}
          : { invincibleUntil: player.invincibleUntil }),
        phase: config.gameStatus,
        now,
      });

      if (!activation.allowed) {
        switch (activation.reason) {
          case 'ROLE':
            throw new InvincibilityServiceError('WRONG_ROLE');
          case 'NO_CARDS':
            throw new InvincibilityServiceError('NO_CARDS');
          case 'PHASE':
            throw new InvincibilityServiceError('POWERUP_NOT_ALLOWED', 'PHASE');
          case 'ALREADY_ACTIVE':
            throw new InvincibilityServiceError('ALREADY_ACTIVE');
        }
      }

      const log = createSystemLog(logId, now, team, player.name);
      const logs = [log, ...(config.logs ?? [])].slice(0, 200);
      const remainingCards = player.invincibleCards + activation.cardDelta;
      transaction.writeInvincibility({
        playerId: uid,
        invincibleCards: remainingCards,
        invincibleUntil: activation.invincibleUntil,
        logs,
      });

      return {
        ok: true,
        remainingCards,
        invincibleUntil: activation.invincibleUntil,
        duration: activation.duration,
      };
    });
  } catch (error) {
    if (error instanceof InvincibilityServiceError) throw error;
    throw new InvincibilityServiceError('PERSISTENCE_ERROR');
  }
}
