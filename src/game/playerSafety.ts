export type SafetyAction = 'EMERGENCY' | 'RETIRE';

export type SafetyReasonCode =
  | 'ILLNESS_OR_INJURY'
  | 'EQUIPMENT_ISSUE'
  | 'OTHER'
  | 'RETIREMENT_REQUEST';

export type PlayerSafetyStatus =
  | 'ACTIVE'
  | 'WAITING'
  | 'EMERGENCY'
  | 'RETIRED'
  | 'CAPTURED';

export type SafetyRejectionReason =
  | 'INVALID_ACTION'
  | 'INVALID_REASON_CODE'
  | 'REASON_ACTION_MISMATCH'
  | 'INVALID_STATUS'
  | 'RETIRED_TERMINAL';

export interface PlayerSafetyInput {
  action: unknown;
  reasonCode: unknown;
  status: unknown;
}

export type PlayerSafetyResult =
  | {
      allowed: true;
      changed: boolean;
      status: 'EMERGENCY' | 'RETIRED';
      waitingUntil: 0;
      shinkansenStartTime: null;
      invincibleUntil: 0;
    }
  | { allowed: false; reason: SafetyRejectionReason };

const actions: readonly SafetyAction[] = ['EMERGENCY', 'RETIRE'];
const reasonCodes: readonly SafetyReasonCode[] = [
  'ILLNESS_OR_INJURY',
  'EQUIPMENT_ISSUE',
  'OTHER',
  'RETIREMENT_REQUEST',
];
const statuses: readonly PlayerSafetyStatus[] = [
  'ACTIVE',
  'WAITING',
  'EMERGENCY',
  'RETIRED',
  'CAPTURED',
];

export function resolvePlayerSafetyAction(input: PlayerSafetyInput): PlayerSafetyResult {
  if (typeof input.action !== 'string' || !actions.includes(input.action as SafetyAction)) {
    return { allowed: false, reason: 'INVALID_ACTION' };
  }
  if (typeof input.reasonCode !== 'string' || !reasonCodes.includes(input.reasonCode as SafetyReasonCode)) {
    return { allowed: false, reason: 'INVALID_REASON_CODE' };
  }

  const action = input.action as SafetyAction;
  const reasonCode = input.reasonCode as SafetyReasonCode;
  if ((action === 'EMERGENCY' && reasonCode === 'RETIREMENT_REQUEST')
    || (action === 'RETIRE' && reasonCode !== 'RETIREMENT_REQUEST')) {
    return { allowed: false, reason: 'REASON_ACTION_MISMATCH' };
  }
  if (typeof input.status !== 'string' || !statuses.includes(input.status as PlayerSafetyStatus)) {
    return { allowed: false, reason: 'INVALID_STATUS' };
  }

  if (input.status === 'RETIRED') {
    if (action === 'RETIRE') {
      return {
        allowed: true,
        changed: false,
        status: 'RETIRED',
        waitingUntil: 0,
        shinkansenStartTime: null,
        invincibleUntil: 0,
      };
    }
    return { allowed: false, reason: 'RETIRED_TERMINAL' };
  }

  const nextStatus = action === 'EMERGENCY' ? 'EMERGENCY' : 'RETIRED';
  if (input.status === nextStatus) {
    return {
      allowed: true,
      changed: false,
      status: nextStatus,
      waitingUntil: 0,
      shinkansenStartTime: null,
      invincibleUntil: 0,
    };
  }

  return {
    allowed: true,
    changed: true,
    status: nextStatus,
    waitingUntil: 0,
    shinkansenStartTime: null,
    invincibleUntil: 0,
  };
}
