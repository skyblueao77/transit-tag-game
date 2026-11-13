/**
 * In-memory Firestore + Security Rules Contract Simulator.
 *
 * Mirrors every collection and rule expression in `firestore.rules` so that
 * client payloads, multi-document transactions/batches, and server-vs-client
 * clock skew can be tested deterministically without requiring Java 21+.
 */

export class FsTimestamp {
  constructor(ms) {
    this._ms = ms;
  }
  toMillis() {
    return this._ms;
  }
  toDate() {
    return new Date(this._ms);
  }
  static fromMillis(ms) {
    return new FsTimestamp(ms);
  }
}

export const SERVER_TIMESTAMP_SENTINEL = Object.freeze({ __sentinel: 'SERVER_TIMESTAMP' });

export function incrementSentinel(delta) {
  return { __sentinel: 'INCREMENT', delta };
}

export class RulePermissionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'RulePermissionError';
    this.code = 'permission-denied';
    this.detail = detail;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof FsTimestamp);
}

function deepClone(value) {
  if (value instanceof FsTimestamp) return new FsTimestamp(value.toMillis());
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = deepClone(v);
    }
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  if (a instanceof FsTimestamp && b instanceof FsTimestamp) return a.toMillis() === b.toMillis();
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isTs(v) {
  return v instanceof FsTimestamp;
}

function tsToMillis(v) {
  return v instanceof FsTimestamp ? v.toMillis() : null;
}

class KeySet {
  constructor(obj) {
    this._keys = new Set(obj && typeof obj === 'object' ? Object.keys(obj) : []);
  }
  hasOnly(allowed) {
    for (const k of this._keys) {
      if (!allowed.includes(k)) return false;
    }
    return true;
  }
  hasAll(required) {
    return required.every(k => this._keys.has(k));
  }
  hasAny(candidates) {
    return candidates.some(k => this._keys.has(k));
  }
  size() {
    return this._keys.size;
  }
}

function wrapKeys(obj) {
  return new KeySet(obj);
}

function affectedKeysDiff(afterObj, beforeObj) {
  const keys = new Set([
    ...(afterObj ? Object.keys(afterObj) : []),
    ...(beforeObj ? Object.keys(beforeObj) : []),
  ]);
  const changed = {};
  for (const k of keys) {
    const inAfter = afterObj && Object.hasOwn(afterObj, k);
    const inBefore = beforeObj && Object.hasOwn(beforeObj, k);
    if (inAfter !== inBefore || !deepEqual(afterObj?.[k], beforeObj?.[k])) {
      changed[k] = true;
    }
  }
  return new KeySet(changed);
}

function resolveMaterializedDoc(baseDoc, op, serverNowMs) {
  if (op.type === 'delete') return null;
  const resolveVal = (v, prevVal) => {
    if (v === SERVER_TIMESTAMP_SENTINEL || (v && v.__sentinel === 'SERVER_TIMESTAMP')) {
      return new FsTimestamp(serverNowMs);
    }
    if (v && typeof v === 'object' && v.__sentinel === 'INCREMENT') {
      const prevNum = typeof prevVal === 'number' ? prevVal : 0;
      return prevNum + v.delta;
    }
    if (Array.isArray(v)) return v.map(item => resolveVal(item, undefined));
    if (isPlainObject(v)) {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        if (val !== undefined) out[k] = resolveVal(val, undefined);
      }
      return out;
    }
    return deepClone(v);
  };

  if (op.type === 'set' && !op.merge) {
    const out = {};
    for (const [k, v] of Object.entries(op.data)) {
      if (v !== undefined) out[k] = resolveVal(v, baseDoc?.[k]);
    }
    return out;
  }

  // set with merge OR update
  const out = baseDoc ? deepClone(baseDoc) : {};
  for (const [k, v] of Object.entries(op.data)) {
    if (v !== undefined) {
      out[k] = resolveVal(v, out[k]);
    }
  }
  return out;
}

export class SimulatedFirestore {
  constructor(initialNowMs = 1_750_000_000_000) {
    this.docs = new Map();
    this.serverNowMs = initialNowMs;
    this.listeners = new Set();
  }

  seed(path, data) {
    const resolved = resolveMaterializedDoc(null, { type: 'set', data, merge: false }, this.serverNowMs);
    this.docs.set(path, resolved);
    return deepClone(resolved);
  }

  rawGet(path) {
    const d = this.docs.get(path);
    return d ? deepClone(d) : null;
  }

  setServerTime(ms) {
    this.serverNowMs = ms;
  }

  advanceServerTime(deltaMs) {
    this.serverNowMs += deltaMs;
  }

  // ---- Security Rules Engine mirroring firestore.rules ----
  _evalRead(path, auth, snapshotMap) {
    const exists = p => snapshotMap.has(p);
    const get = p => ({ data: snapshotMap.get(p) });
    const signedIn = () => auth !== null && typeof auth.uid === 'string';
    const isAdmin = () => signedIn() && exists(`admins/${auth.uid}`);
    const hasCurrentGameSession = () => {
      const cp = 'game_config/current';
      if (!exists(cp)) return false;
      const d = get(cp).data;
      return typeof d.gameSessionId === 'string' && d.gameSessionId.length > 0
        && isInt(d.sessionStartedAt) && d.sessionStartedAt >= 0
        && isInt(d.sessionSchemaVersion) && d.sessionSchemaVersion >= 2;
    };
    const isCurrentParticipant = uid => {
      if (!signedIn() || !hasCurrentGameSession()) return false;
      const up = `users/${uid}`;
      if (!exists(up)) return false;
      const u = get(up).data;
      return (u.team === 'A' || u.team === 'B') && u.gameSessionId === get('game_config/current').data.gameSessionId;
    };
    const isRevealViewer = () => signedIn() && (isAdmin() || isCurrentParticipant(auth.uid));

    const parts = path.split('/');
    const [col, id, sub, subId] = parts;

    if (path === 'system/admin_bootstrap') return true;
    if (col === 'admins' && id && !sub) {
      return signedIn() && (auth.uid === id || isAdmin());
    }
    if (col === 'admins' && id && sub && subId) {
      return signedIn() && auth.uid === id && isAdmin();
    }
    if (col === 'privateLocations' && id && !sub) {
      return signedIn() && auth.uid === id;
    }
    if (col === 'exposedLocations' && id && !sub) {
      if (isAdmin()) return true;
      if (!isRevealViewer()) return false;
      if (auth.uid === id) return true;
      const resource = snapshotMap.get(path) ?? null;
      if (resource === null) return true;
      if (!hasCurrentGameSession()) return false;
      const cfg = get('game_config/current').data;
      const targetUser = get(`users/${id}`)?.data;
      if (!targetUser) return false;
      return resource.gameSessionId === cfg.gameSessionId
        && targetUser.status !== 'EMERGENCY'
        && targetUser.status !== 'RETIRED';
    }
    if (col === 'emergencyLocationProjections' && id && !sub) {
      return isAdmin() || (signedIn() && auth.uid === id);
    }
    if (col === 'users' && id && !sub) {
      return signedIn() && (isAdmin() || isCurrentParticipant(auth.uid) || auth.uid === id);
    }
    if (col === 'missions' && id && !sub) {
      return signedIn();
    }
    if (col === 'missionCompletions' && id && !sub) {
      return signedIn() && (isAdmin() || isCurrentParticipant(auth.uid));
    }
    if (col === 'game_config' && id && !sub) {
      return signedIn();
    }
    return false;
  }

  _evalList(collectionName, auth) {
    const exists = p => this.docs.has(p);
    const get = p => ({ data: this.docs.get(p) });
    const signedIn = () => auth !== null && typeof auth.uid === 'string';
    const isAdmin = () => signedIn() && exists(`admins/${auth.uid}`);
    const hasCurrentGameSession = () => {
      const cp = 'game_config/current';
      if (!exists(cp)) return false;
      const d = get(cp).data;
      return typeof d.gameSessionId === 'string' && d.gameSessionId.length > 0
        && isInt(d.sessionStartedAt) && d.sessionStartedAt >= 0
        && isInt(d.sessionSchemaVersion) && d.sessionSchemaVersion >= 2;
    };
    const isCurrentParticipant = uid => {
      if (!signedIn() || !hasCurrentGameSession()) return false;
      const up = `users/${uid}`;
      if (!exists(up)) return false;
      const u = get(up).data;
      return (u.team === 'A' || u.team === 'B') && u.gameSessionId === get('game_config/current').data.gameSessionId;
    };

    if (collectionName === 'users') {
      return signedIn() && (isAdmin() || isCurrentParticipant(auth.uid));
    }
    if (collectionName === 'missions') {
      return signedIn();
    }
    if (collectionName === 'missionCompletions') {
      return signedIn() && (isAdmin() || isCurrentParticipant(auth.uid));
    }
    if (collectionName === 'exposedLocations') {
      return isAdmin();
    }
    if (collectionName === 'emergencyLocationProjections') {
      return isAdmin();
    }
    if (collectionName === 'game_config') {
      return signedIn();
    }
    return false;
  }

  _evalWrite(op, beforeMap, afterMap, auth) {
    const path = op.path;
    const beforeData = beforeMap.get(path) ?? null;
    const afterData = afterMap.get(path) ?? null;
    const opKind = beforeData === null && afterData !== null
      ? 'create'
      : beforeData !== null && afterData === null
        ? 'delete'
        : 'update';

    const nowMs = this.serverNowMs;
    const exists = p => beforeMap.has(p);
    const get = p => ({ data: beforeMap.get(p) });
    const existsAfter = p => afterMap.has(p);
    const getAfter = p => ({ data: afterMap.get(p) });

    const signedIn = () => auth !== null && typeof auth.uid === 'string';
    const isAdmin = () => signedIn() && exists(`admins/${auth.uid}`);
    const isPasswordUser = () => signedIn() && auth.signInProvider === 'password';
    const hasCurrentGameSession = () => {
      const cp = 'game_config/current';
      if (!exists(cp)) return false;
      const d = get(cp).data;
      return typeof d.gameSessionId === 'string' && d.gameSessionId.length > 0
        && isInt(d.sessionStartedAt) && d.sessionStartedAt >= 0
        && isInt(d.sessionSchemaVersion) && d.sessionSchemaVersion >= 2;
    };
    const hasNoCoordinates = data => {
      return !wrapKeys(data).hasAny(['latitude', 'longitude', 'privateLatitude', 'privateLongitude', 'lastLat', 'lastLng']);
    };
    const isCurrentParticipant = uid => {
      if (!signedIn() || !hasCurrentGameSession()) return false;
      const up = `users/${uid}`;
      if (!exists(up)) return false;
      const u = get(up).data;
      return (u.team === 'A' || u.team === 'B') && u.gameSessionId === get('game_config/current').data.gameSessionId;
    };
    const isActiveDeadline = deadline => {
      if (isTs(deadline)) return nowMs < deadline.toMillis();
      if (isInt(deadline)) return nowMs < deadline;
      return false;
    };
    const expiresWithinDeadline = (exp, deadline) => {
      if (!isTs(exp)) return false;
      if (isTs(deadline)) return exp.toMillis() <= deadline.toMillis() + 60_000;
      if (isInt(deadline)) return exp.toMillis() <= deadline + 60_000;
      return false;
    };

    const parts = path.split('/');
    const [col, id, sub, subId] = parts;

    // 1. system/admin_bootstrap
    if (path === 'system/admin_bootstrap') {
      if (opKind !== 'create') return false;
      const d = afterData;
      return isPasswordUser()
        && !exists(`users/${auth.uid}`)
        && !exists('system/admin_bootstrap')
        && wrapKeys(d).hasOnly(['initializedBy', 'initializedAt'])
        && d.initializedBy === auth.uid
        && isTs(d.initializedAt);
    }

    // 2. admins/{uid} & subcollections
    if (col === 'admins' && id && !sub) {
      if (opKind !== 'create') return false;
      const d = afterData;
      const bootstrapCreate = isPasswordUser()
        && auth.uid === id
        && !exists(`users/${auth.uid}`)
        && !exists('system/admin_bootstrap')
        && existsAfter('system/admin_bootstrap')
        && getAfter('system/admin_bootstrap').data.initializedBy === auth.uid
        && wrapKeys(d).hasOnly(['role', 'createdAt'])
        && d.role === 'admin'
        && isTs(d.createdAt);
      const adminCreate = isAdmin()
        && wrapKeys(d).hasOnly(['role', 'createdAt'])
        && d.role === 'admin'
        && isTs(d.createdAt);
      return bootstrapCreate || adminCreate;
    }
    if (col === 'admins' && id && sub && subId) {
      return signedIn() && auth.uid === id && isAdmin();
    }

    // 3. privateLocations/{uid}
    if (col === 'privateLocations' && id && !sub) {
      if (opKind === 'delete') return isAdmin();
      const d = afterData;
      return signedIn()
        && auth.uid === id
        && hasCurrentGameSession()
        && wrapKeys(d).hasOnly(['gameSessionId', 'latitude', 'longitude', 'updatedAt'])
        && wrapKeys(d).hasAll(['gameSessionId', 'latitude', 'longitude', 'updatedAt'])
        && d.gameSessionId === get('game_config/current').data.gameSessionId
        && isNum(d.latitude) && d.latitude >= -90 && d.latitude <= 90
        && isNum(d.longitude) && d.longitude >= -180 && d.longitude <= 180
        && isTs(d.updatedAt);
    }

    // 4. exposedLocations/{uid}
    if (col === 'exposedLocations' && id && !sub) {
      if (opKind === 'delete') {
        return isAdmin()
          || (signedIn() && auth.uid === id && existsAfter(`users/${id}`)
            && ['EMERGENCY', 'RETIRED'].includes(getAfter(`users/${id}`).data.status));
      }
      const validScope = (data, uid) => {
        if (!exists('game_config/current') || !exists(`users/${uid}`)) return false;
        const cfg = get('game_config/current').data;
        const me = get(`users/${uid}`).data;
        const expMs = tsToMillis(data.expiresAt);
        if (expMs === null) return false;
        if ((!wrapKeys(data).hasAny(['revealScope']) || data.revealScope === 'INDIVIDUAL')
          && expMs <= nowMs + 6 * 60_000) return true;
        if (data.revealScope === 'GLOBAL'
          && wrapKeys(cfg).hasAny(['locationRevealUntil'])
          && isActiveDeadline(cfg.locationRevealUntil)
          && expiresWithinDeadline(data.expiresAt, cfg.locationRevealUntil)
          && expMs <= nowMs + 61 * 60_000) return true;
        if (data.revealScope === 'TEAM_A'
          && me.team === 'A'
          && wrapKeys(cfg).hasAny(['teamARevealUntil'])
          && isActiveDeadline(cfg.teamARevealUntil)
          && expiresWithinDeadline(data.expiresAt, cfg.teamARevealUntil)
          && expMs <= nowMs + 61 * 60_000) return true;
        if (data.revealScope === 'TEAM_B'
          && me.team === 'B'
          && wrapKeys(cfg).hasAny(['teamBRevealUntil'])
          && isActiveDeadline(cfg.teamBRevealUntil)
          && expiresWithinDeadline(data.expiresAt, cfg.teamBRevealUntil)
          && expMs <= nowMs + 61 * 60_000) return true;
        if (data.revealScope === 'PENALTY'
          && wrapKeys(me).hasAny(['penaltyRevealUntil'])
          && isActiveDeadline(me.penaltyRevealUntil)
          && expiresWithinDeadline(data.expiresAt, me.penaltyRevealUntil)
          && expMs <= nowMs + 61 * 60_000) return true;
        return false;
      };
      const validOwnerWrite = uid => {
        if (!signedIn() || isAdmin() || auth.uid !== uid || !hasCurrentGameSession()) return false;
        if (!exists('game_config/current') || !exists(`users/${uid}`)) return false;
        const data = afterData;
        const cfg = get('game_config/current').data;
        const me = get(`users/${uid}`).data;
        const dk = wrapKeys(data);
        return dk.hasOnly(['gameSessionId', 'latitude', 'longitude', 'capturedAt', 'expiresAt', 'revealScope', 'playerId'])
          && dk.hasAll(['gameSessionId', 'latitude', 'longitude', 'capturedAt', 'expiresAt'])
          && (!dk.hasAny(['playerId']) || data.playerId === uid)
          && data.gameSessionId === cfg.gameSessionId
          && isNum(data.latitude) && data.latitude >= -90 && data.latitude <= 90
          && isNum(data.longitude) && data.longitude >= -180 && data.longitude <= 180
          && isTs(data.capturedAt)
          && isTs(data.expiresAt)
          && nowMs < data.expiresAt.toMillis()
          && validScope(data, uid)
          && isCurrentParticipant(uid)
          && me.status !== 'EMERGENCY'
          && me.status !== 'RETIRED'
          && ['DAY1_ACTIVE', 'DAY2_ACTIVE'].includes(cfg.gameStatus);
      };
      if (opKind === 'create') return validOwnerWrite(id);
      if (opKind === 'update') {
        if (!validOwnerWrite(id)) return false;
        const oldData = beforeData;
        const newData = afterData;
        const oldScope = wrapKeys(oldData).hasAny(['revealScope']) ? oldData.revealScope : 'INDIVIDUAL';
        const newScope = wrapKeys(newData).hasAny(['revealScope']) ? newData.revealScope : 'INDIVIDUAL';
        if (!wrapKeys(oldData).hasAny(['gameSessionId']) || !hasCurrentGameSession()) return true;
        if (oldData.gameSessionId !== get('game_config/current').data.gameSessionId) return true;
        if (!isTs(oldData.expiresAt) || oldData.expiresAt.toMillis() <= nowMs) return true;
        if (oldScope === 'PENALTY' && newScope === 'PENALTY'
          && newData.expiresAt.toMillis() >= oldData.expiresAt.toMillis() - 1000) return true;
        if (['GLOBAL', 'TEAM_A', 'TEAM_B'].includes(oldScope)
          && (newScope === 'PENALTY'
            || (['TEAM_A', 'TEAM_B'].includes(oldScope) && newScope === 'GLOBAL')
            || (newScope === oldScope && newData.expiresAt.toMillis() > oldData.expiresAt.toMillis() + 5000))) {
          return true;
        }
        return oldScope === 'INDIVIDUAL';
      }
      return false;
    }

    // 5. emergencyLocationProjections/{uid}
    if (col === 'emergencyLocationProjections' && id && !sub) {
      if (opKind === 'delete') {
        return isAdmin()
          || (signedIn() && auth.uid === id && existsAfter(`users/${id}`)
            && getAfter(`users/${id}`).data.status !== 'EMERGENCY');
      }
      const d = afterData;
      const dk = wrapKeys(d);
      return signedIn()
        && auth.uid === id
        && hasCurrentGameSession()
        && dk.hasOnly(['playerId', 'gameSessionId', 'latitude', 'longitude', 'projectedAt', 'sourceLocationUpdatedAt', 'expiresAt', 'safetyStatus', 'projectionKind'])
        && dk.hasAll(['playerId', 'gameSessionId', 'latitude', 'longitude', 'projectedAt', 'sourceLocationUpdatedAt', 'expiresAt', 'safetyStatus', 'projectionKind'])
        && d.playerId === id
        && d.gameSessionId === get('game_config/current').data.gameSessionId
        && d.safetyStatus === 'EMERGENCY'
        && d.projectionKind === 'EMERGENCY'
        && existsAfter(`users/${id}`)
        && getAfter(`users/${id}`).data.status === 'EMERGENCY'
        && isNum(d.latitude) && d.latitude >= -90 && d.latitude <= 90
        && isNum(d.longitude) && d.longitude >= -180 && d.longitude <= 180
        && isTs(d.projectedAt)
        && isTs(d.sourceLocationUpdatedAt)
        && isTs(d.expiresAt)
        && d.expiresAt.toMillis() > nowMs
        && d.expiresAt.toMillis() <= nowMs + 3 * 60_000;
    }

    // 6. users/{uid}
    if (col === 'users' && id && !sub) {
      if (opKind === 'delete') return isAdmin();
      if (opKind === 'create') {
        if (!signedIn() || isAdmin() || auth.uid !== id || !hasCurrentGameSession()) return false;
        const d = afterData;
        const dk = wrapKeys(d);
        return dk.hasOnly([
          'id', 'name', 'role', 'team', 'color', 'score', 'status',
          'gameSessionId', 'invincibleCards', 'lastCompletionId', 'lastStation',
          'protectionZone', 'shinkansenSegmentCount', 'penaltyRevealUntil',
        ])
          && (!dk.hasAny(['lastStation']) || (typeof d.lastStation === 'string' && Buffer.byteLength(d.lastStation, 'utf8') <= 250))
          && (!dk.hasAny(['protectionZone']) || ['NONE', 'GREEN_CAR', 'SAFE_ZONE'].includes(d.protectionZone))
          && (!dk.hasAny(['shinkansenSegmentCount']) || (isInt(d.shinkansenSegmentCount) && d.shinkansenSegmentCount >= 0))
          && (!dk.hasAny(['penaltyRevealUntil']) || (isInt(d.penaltyRevealUntil) && d.penaltyRevealUntil >= 0))
          && dk.hasAll(['id', 'name', 'role', 'team', 'color', 'score', 'status', 'gameSessionId', 'invincibleCards'])
          && d.id === id
          && typeof d.name === 'string' && Buffer.byteLength(d.name, 'utf8') > 0 && Buffer.byteLength(d.name, 'utf8') <= 80
          && d.role === 'RUNNER'
          && (d.team === 'A' || d.team === 'B')
          && typeof d.color === 'string'
          && d.status === 'ACTIVE'
          && isInt(d.score) && d.score === 0
          && isInt(d.invincibleCards) && d.invincibleCards === 0
          && d.gameSessionId === get('game_config/current').data.gameSessionId;
      }

      // update
      if (isAdmin() && hasNoCoordinates(afterData)) return true;

      // validSelfUserUpdate
      const validSelf = () => {
        const b = beforeData;
        const a = afterData;
        const ak = wrapKeys(a);
        const bk = wrapKeys(b);
        const diff = affectedKeysDiff(a, b);
        const hasCfg = hasCurrentGameSession();
        if (!hasCfg && diff.hasAny(['protectionZone', 'shinkansenStartTime', 'shinkansenSegmentCount', 'invincibleCards', 'invincibleUntil'])) {
          // mirrors rules get(configPath).data usage safely
        }
        const cfg = exists('game_config/current') ? get('game_config/current').data : {};
        const isActivePhase = hasCfg && ['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION'].includes(cfg.gameStatus);
        const myRole = hasCfg ? (b.team === 'A' ? cfg.teamARole : cfg.teamBRole) : '';

        if (!signedIn() || auth.uid !== id || !hasNoCoordinates(a)
          || a.id !== b.id || a.team !== b.team || a.role !== b.role || a.gameSessionId !== b.gameSessionId) {
          return false;
        }

        if (diff.hasOnly(['name']) && typeof a.name === 'string' && Buffer.byteLength(a.name, 'utf8') > 0 && Buffer.byteLength(a.name, 'utf8') <= 80) return true;
        if (diff.hasOnly(['lastStation']) && typeof a.lastStation === 'string' && Buffer.byteLength(a.lastStation, 'utf8') <= 250) return true;
        if (diff.hasOnly(['name', 'lastStation'])
          && typeof a.name === 'string' && Buffer.byteLength(a.name, 'utf8') > 0 && Buffer.byteLength(a.name, 'utf8') <= 80
          && typeof a.lastStation === 'string' && Buffer.byteLength(a.lastStation, 'utf8') <= 250) return true;

        if (diff.hasOnly(['protectionZone'])
          && isActivePhase && b.status === 'ACTIVE' && myRole === 'RUNNER'
          && ['NONE', 'GREEN_CAR', 'SAFE_ZONE'].includes(a.protectionZone)) return true;

        if (diff.hasOnly(['shinkansenStartTime', 'shinkansenSegmentCount'])
          && isActivePhase && b.status === 'ACTIVE' && myRole === 'RUNNER'
          && isInt(a.shinkansenSegmentCount) && a.shinkansenSegmentCount >= 0
          && (
            ((!bk.hasAny(['shinkansenStartTime']) || b.shinkansenStartTime === 0 || b.shinkansenStartTime === null)
              && isInt(a.shinkansenStartTime)
              && a.shinkansenStartTime >= nowMs - 60_000
              && a.shinkansenStartTime <= nowMs + 60_000
              && a.shinkansenSegmentCount === 0)
            || ((a.shinkansenStartTime === 0 || a.shinkansenStartTime === null)
              && bk.hasAny(['shinkansenStartTime'])
              && isInt(b.shinkansenStartTime)
              && nowMs <= b.shinkansenStartTime + 60_000
              && (!bk.hasAny(['shinkansenSegmentCount']) || b.shinkansenSegmentCount === 0)
              && a.shinkansenSegmentCount === 0)
          )) return true;

        if (diff.hasOnly(['shinkansenSegmentCount'])
          && isActivePhase && b.status === 'ACTIVE' && myRole === 'RUNNER'
          && bk.hasAny(['shinkansenStartTime']) && isInt(b.shinkansenStartTime) && b.shinkansenStartTime > 0
          && isInt(a.shinkansenSegmentCount)
          && a.shinkansenSegmentCount === (bk.hasAny(['shinkansenSegmentCount']) && isInt(b.shinkansenSegmentCount) ? b.shinkansenSegmentCount : 0) + 1) {
          return true;
        }

        if (diff.hasOnly(['shinkansenStartTime'])
          && isActivePhase && b.status === 'ACTIVE' && myRole === 'RUNNER'
          && (
            ((!bk.hasAny(['shinkansenStartTime']) || b.shinkansenStartTime === 0 || b.shinkansenStartTime === null)
              && isInt(a.shinkansenStartTime)
              && a.shinkansenStartTime >= nowMs - 60_000
              && a.shinkansenStartTime <= nowMs + 60_000)
            || ((a.shinkansenStartTime === 0 || a.shinkansenStartTime === null)
              && bk.hasAny(['shinkansenStartTime'])
              && isInt(b.shinkansenStartTime)
              && nowMs <= b.shinkansenStartTime + 60_000
              && (!bk.hasAny(['shinkansenSegmentCount']) || b.shinkansenSegmentCount === 0))
          )) return true;

        // Waiting resume
        if (diff.hasOnly(['status', 'waitingUntil', 'shinkansenStartTime'])
          && b.status === 'WAITING' && a.status === 'ACTIVE'
          && isInt(b.waitingUntil) && b.waitingUntil <= nowMs
          && a.waitingUntil === 0
          && (a.shinkansenStartTime === null || a.shinkansenStartTime === 0)) return true;

        // Manual waiting start
        if (diff.hasOnly(['status', 'waitingUntil', 'shinkansenStartTime'])
          && isActivePhase && myRole === 'RUNNER'
          && b.status === 'ACTIVE' && a.status === 'WAITING'
          && (a.shinkansenStartTime === null || a.shinkansenStartTime === 0)
          && isInt(a.waitingUntil) && a.waitingUntil > nowMs
          && (a.waitingUntil <= nowMs + 3_660_000
            || (wrapKeys(cfg).hasAny(['postShinkansenWaitMinutes'])
              && isInt(cfg.postShinkansenWaitMinutes)
              && cfg.postShinkansenWaitMinutes >= 1
              && cfg.postShinkansenWaitMinutes <= 180
              && a.waitingUntil <= nowMs + cfg.postShinkansenWaitMinutes * 60_000 + 60_000))
          && a.waitingUntil <= nowMs + 10_860_000) return true;

        // Invincibility card use
        if (diff.hasOnly(['invincibleCards', 'invincibleUntil'])
          && isActivePhase && myRole === 'RUNNER' && b.status === 'ACTIVE'
          && (!bk.hasAny(['invincibleUntil']) || !isInt(b.invincibleUntil) || b.invincibleUntil <= nowMs)
          && isInt(b.invincibleCards) && b.invincibleCards >= 1
          && a.invincibleCards === b.invincibleCards - 1
          && isInt(a.invincibleUntil) && a.invincibleUntil > nowMs
          && a.invincibleUntil <= nowMs + 1_860_000) return true;

        // Safety action
        if (diff.hasOnly(['status', 'waitingUntil', 'shinkansenStartTime', 'invincibleUntil'])
          && b.status !== 'RETIRED'
          && (a.status === 'EMERGENCY' || a.status === 'RETIRED')
          && a.waitingUntil === 0
          && (a.shinkansenStartTime === null || a.shinkansenStartTime === 0)
          && a.invincibleUntil === 0) return true;

        // Mission reward update
        if (diff.hasAny(['score'])) {
          if (!diff.hasOnly(['score', 'invincibleCards', 'lastCompletionId'])
            || !ak.hasAny(['lastCompletionId'])
            || typeof a.lastCompletionId !== 'string') return false;
          const compPath = `missionCompletions/${a.lastCompletionId}`;
          if (exists(compPath) || !existsAfter(compPath)) return false;
          const comp = getAfter(compPath).data;
          if (comp.completedBy !== id || comp.team !== b.team || comp.gameSessionId !== b.gameSessionId) return false;
          if (a.lastCompletionId !== `${b.team}_${b.gameSessionId}_${comp.missionId}`) return false;
          if (!isInt(b.score) || !isInt(a.score) || a.score !== b.score + comp.points) return false;
          if (comp.points <= 0 || comp.points > 100) return false;
          if (a.invincibleCards === b.invincibleCards) return true;
          return isInt(b.invincibleCards)
            && a.invincibleCards === b.invincibleCards + 1
            && wrapKeys(comp).hasAny(['luckyReward'])
            && comp.luckyReward === true;
        }
        return false;
      };

      // validParticipantCaptureUpdate
      const validCaptureUser = () => {
        if (!signedIn() || !isCurrentParticipant(auth.uid) || !hasNoCoordinates(afterData)) return false;
        if (!exists('game_config/current') || !existsAfter('game_config/current')) return false;
        const b = beforeData;
        const a = afterData;
        const bk = wrapKeys(b);
        const diff = affectedKeysDiff(a, b);
        const curConfig = get('game_config/current').data;
        const afterConfig = getAfter('game_config/current').data;
        const me = get(`users/${auth.uid}`).data;
        const myRole = me.team === 'A' ? curConfig.teamARole : curConfig.teamBRole;
        const isSurvival = wrapKeys(curConfig).hasAny(['victoryMode']) && curConfig.victoryMode === 'SURVIVAL';

        if (a.id !== b.id || a.name !== b.name || a.team !== b.team || a.role !== b.role || a.score !== b.score
          || a.gameSessionId !== b.gameSessionId || a.gameSessionId !== curConfig.gameSessionId) return false;
        if (bk.hasAny(['color']) && a.color !== b.color) return false;
        if (!['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION'].includes(curConfig.gameStatus)) return false;
        if (myRole !== 'ONI' || me.status !== 'ACTIVE') return false;
        if (!isSurvival ? afterConfig.teamARole === curConfig.teamARole : afterConfig.teamARole !== curConfig.teamARole) return false;
        if (b.status === 'EMERGENCY' || b.status === 'RETIRED') return false;

        if (isSurvival
          && b.team !== me.team
          && afterConfig.lastCaptureTargetId === id
          && ((me.team === 'A' && afterConfig.teamAScore === curConfig.teamAScore + 50 && afterConfig.teamBScore === curConfig.teamBScore)
            || (me.team === 'B' && afterConfig.teamBScore === curConfig.teamBScore + 50 && afterConfig.teamAScore === curConfig.teamAScore))
          && b.status === 'ACTIVE'
          && (!bk.hasAny(['invincibleUntil']) || !isInt(b.invincibleUntil) || b.invincibleUntil <= nowMs)
          && (!bk.hasAny(['protectionZone']) || b.protectionZone === 'NONE')
          && diff.hasOnly(['status', 'waitingUntil', 'invincibleUntil'])
          && a.status === 'CAPTURED' && a.waitingUntil === 0 && a.invincibleUntil === 0) {
          return true;
        }
        if (!isSurvival && b.team !== me.team
          && diff.hasOnly(['status', 'waitingUntil', 'invincibleUntil'])
          && a.status === 'WAITING'
          && isInt(a.waitingUntil) && a.waitingUntil > nowMs
          && (a.waitingUntil <= nowMs + 1_860_000
            || (wrapKeys(curConfig).hasAny(['captureWaitMinutes'])
              && isInt(curConfig.captureWaitMinutes)
              && curConfig.captureWaitMinutes >= 1 && curConfig.captureWaitMinutes <= 120
              && a.waitingUntil <= nowMs + curConfig.captureWaitMinutes * 60_000 + 60_000))
          && a.waitingUntil <= nowMs + 7_260_000
          && a.invincibleUntil === 0) {
          return true;
        }
        if (!isSurvival && b.team === me.team
          && diff.hasOnly(['status', 'waitingUntil', 'invincibleCards'])
          && a.status === 'ACTIVE'
          && a.waitingUntil === 0
          && a.invincibleCards === (bk.hasAny(['invincibleCards']) ? b.invincibleCards : 0) + 1) {
          return true;
        }
        return false;
      };

      return validSelf() || validCaptureUser();
    }

    // 7. missions/{missionId}
    if (col === 'missions' && id && !sub) {
      return isAdmin();
    }

    // 8. missionCompletions/{completionId}
    if (col === 'missionCompletions' && id && !sub) {
      if (opKind !== 'create') return isAdmin();
      if (isAdmin()) return true;
      if (!signedIn() || !isCurrentParticipant(auth.uid) || !hasCurrentGameSession()) return false;
      const data = afterData;
      const dk = wrapKeys(data);
      const config = get('game_config/current').data;
      const ck = wrapKeys(config);
      const user = get(`users/${auth.uid}`).data;
      const missionPath = `missions/${data.missionId}`;
      if (!exists(missionPath)) return false;
      const mission = get(missionPath).data;
      const mk = wrapKeys(mission);
      if (!dk.hasOnly(['gameSessionId', 'missionId', 'team', 'completedBy', 'points', 'luckyReward', 'isFinalMission', 'completedAt'])) return false;
      if (!dk.hasAll(['gameSessionId', 'missionId', 'team', 'completedBy', 'points', 'isFinalMission', 'completedAt'])) return false;
      if (data.completedBy !== auth.uid || data.gameSessionId !== config.gameSessionId
        || data.team !== user.team || user.status !== 'ACTIVE') return false;
      if (mk.hasAny(['isFinalMission']) && mission.isFinalMission !== data.isFinalMission) return false;
      if (!isInt(data.points) || data.points !== mission.points || typeof data.isFinalMission !== 'boolean') return false;
      if (!['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION'].includes(config.gameStatus)) return false;

      const finalOk = data.isFinalMission === true
        && config.gameStatus === 'FINAL_MISSION'
        && config.isFinalMissionActive === true
        && ck.hasAny(['activeFinalMissionId'])
        && config.activeFinalMissionId === data.missionId;
      const normalOk = data.isFinalMission === false
        && ['DAY1_ACTIVE', 'DAY2_ACTIVE'].includes(config.gameStatus)
        && ((!ck.hasAny(['activeMissionA']) && !ck.hasAny(['activeMissionB']))
          || (data.team === 'A' && (!ck.hasAny(['activeMissionA']) || config.activeMissionA === data.missionId))
          || (data.team === 'B' && (!ck.hasAny(['activeMissionB']) || config.activeMissionB === data.missionId)));
      if (!finalOk && !normalOk) return false;
      if (dk.hasAny(['luckyReward']) && typeof data.luckyReward !== 'boolean') return false;
      if (!isTs(data.completedAt)) return false;
      return id === `${data.team}_${data.gameSessionId}_${data.missionId}`;
    }

    // 9. game_config/{configId}
    if (col === 'game_config' && id && !sub) {
      if (opKind === 'create' || opKind === 'delete') return isAdmin();
      if (isAdmin()) return true;

      if (!signedIn() || id !== 'current' || !isCurrentParticipant(auth.uid) || !hasCurrentGameSession()) return false;
      const currentData = beforeData;
      const newData = afterData;
      const diff = affectedKeysDiff(newData, currentData);
      if (newData.gameSessionId !== currentData.gameSessionId
        || newData.sessionStartedAt !== currentData.sessionStartedAt
        || newData.sessionSchemaVersion !== currentData.sessionSchemaVersion
        || newData.gameStatus !== currentData.gameStatus
        || newData.day !== currentData.day
        || newData.missionMode !== currentData.missionMode
        || newData.isGameOver !== currentData.isGameOver) {
        return false;
      }

      const validLogEntry = (entry, allowedTypes) => {
        if (!isPlainObject(entry)) return false;
        const ek = wrapKeys(entry);
        return ek.hasOnly(['id', 'timestamp', 'message', 'type'])
          && ek.hasAll(['id', 'timestamp', 'message', 'type'])
          && typeof entry.id === 'string' && Buffer.byteLength(entry.id, 'utf8') > 0 && Buffer.byteLength(entry.id, 'utf8') <= 100
          && isInt(entry.timestamp)
          && typeof entry.message === 'string' && Buffer.byteLength(entry.message, 'utf8') > 0 && Buffer.byteLength(entry.message, 'utf8') <= 300
          && allowedTypes.includes(entry.type);
      };

      const validPrependedLogs = (cur, nw, allowedTypes) => {
        const prevLogs = wrapKeys(cur).hasAny(['logs']) && Array.isArray(cur.logs) ? cur.logs : [];
        if (!Array.isArray(nw.logs) || nw.logs.length < 1 || nw.logs.length > 200) return false;
        const expectedLen = prevLogs.length >= 200 ? 200 : prevLogs.length + 1;
        if (nw.logs.length !== expectedLen) return false;
        if (!validLogEntry(nw.logs[0], allowedTypes)) return false;
        return prevLogs.length === 0 || deepEqual(nw.logs[1], prevLogs[0]);
      };

      if (diff.hasOnly(['logs']) && diff.size() === 1) {
        return validPrependedLogs(currentData, newData, ['SYSTEM', 'EMERGENCY'])
          && newData.teamARole === currentData.teamARole
          && newData.teamBRole === currentData.teamBRole
          && newData.teamAScore === currentData.teamAScore
          && newData.teamBScore === currentData.teamBScore
          && (!wrapKeys(currentData).hasAny(['nextRevealTime']) || newData.nextRevealTime === currentData.nextRevealTime);
      }

      if (diff.hasAny(['teamARole', 'teamBRole', 'lastCaptureTargetId'])) {
        const mePath = `users/${auth.uid}`;
        const targetPath = `users/${newData.lastCaptureTargetId}`;
        const isSurvival = wrapKeys(currentData).hasAny(['victoryMode']) && currentData.victoryMode === 'SURVIVAL';
        if (!exists(mePath)) return false;
        const me = get(mePath).data;
        if (!['DAY1_ACTIVE', 'DAY2_ACTIVE', 'FINAL_MISSION'].includes(currentData.gameStatus)) return false;
        if ((me.team === 'A' ? currentData.teamARole : currentData.teamBRole) !== 'ONI') return false;
        if (me.status !== 'ACTIVE') return false;
        if (!diff.hasOnly(['teamARole', 'teamBRole', 'teamAScore', 'teamBScore', 'nextRevealTime', 'lastCaptureTargetId', 'logs'])) return false;

        if (!isSurvival) {
          const t = newData.nextRevealTime;
          const validBound = isInt(t) && t > nowMs && t <= nowMs + 7_260_000
            && (t <= nowMs + 1_860_000
              || (wrapKeys(currentData).hasAny(['captureWaitMinutes'])
                && isInt(currentData.captureWaitMinutes)
                && currentData.captureWaitMinutes >= 1 && currentData.captureWaitMinutes <= 120
                && t <= nowMs + currentData.captureWaitMinutes * 60_000 + 60_000));
          if (!validBound) return false;
        } else if (!wrapKeys(currentData).hasAny(['nextRevealTime'])) {
          if (wrapKeys(newData).hasAny(['nextRevealTime']) && !isInt(newData.nextRevealTime)) return false;
        } else if (newData.nextRevealTime !== currentData.nextRevealTime) {
          return false;
        }

        if (wrapKeys(currentData).hasAny(['startTime']) && isInt(currentData.startTime) && nowMs < currentData.startTime + 1_800_000) {
          return false;
        }
        if (typeof newData.lastCaptureTargetId !== 'string' || !exists(targetPath) || !existsAfter(targetPath)) return false;
        const tBefore = get(targetPath).data;
        const tAfter = getAfter(targetPath).data;
        if (tBefore.gameSessionId !== currentData.gameSessionId
          || (tBefore.team !== 'A' && tBefore.team !== 'B')
          || tBefore.team === me.team
          || tBefore.status !== 'ACTIVE') return false;
        if (wrapKeys(tBefore).hasAny(['invincibleUntil']) && isInt(tBefore.invincibleUntil) && tBefore.invincibleUntil > nowMs) return false;
        if (wrapKeys(tBefore).hasAny(['protectionZone']) && tBefore.protectionZone !== 'NONE') return false;

        if (isSurvival) {
          if (tAfter.status !== 'CAPTURED' || tAfter.waitingUntil !== 0
            || newData.teamARole !== currentData.teamARole || newData.teamBRole !== currentData.teamBRole) return false;
          const scoreOk = me.team === 'A'
            ? (newData.teamAScore === currentData.teamAScore + 50 && newData.teamBScore === currentData.teamBScore)
            : (newData.teamBScore === currentData.teamBScore + 50 && newData.teamAScore === currentData.teamAScore);
          if (!scoreOk) return false;
        } else {
          if (tAfter.status !== 'WAITING' || !isInt(tAfter.waitingUntil) || tAfter.waitingUntil <= nowMs) return false;
          const waitOk = tAfter.waitingUntil <= nowMs + 1_860_000
            || (wrapKeys(currentData).hasAny(['captureWaitMinutes'])
              && isInt(currentData.captureWaitMinutes)
              && currentData.captureWaitMinutes >= 1 && currentData.captureWaitMinutes <= 120
              && tAfter.waitingUntil <= nowMs + currentData.captureWaitMinutes * 60_000 + 60_000);
          if (!waitOk || tAfter.waitingUntil > nowMs + 7_260_000) return false;
          const swapOk = me.team === 'A'
            ? (currentData.teamARole === 'ONI' && newData.teamARole === 'RUNNER' && newData.teamBRole === 'ONI'
              && newData.teamAScore === currentData.teamAScore + 50 && newData.teamBScore === currentData.teamBScore)
            : (currentData.teamBRole === 'ONI' && newData.teamBRole === 'RUNNER' && newData.teamARole === 'ONI'
              && newData.teamBScore === currentData.teamBScore + 50 && newData.teamAScore === currentData.teamAScore);
          if (!swapOk) return false;
        }
        return !diff.hasAny(['logs']) || validPrependedLogs(currentData, newData, ['CAPTURE']);
      }

      if (diff.hasAny(['teamAScore', 'teamBScore'])) {
        const mePath = `users/${auth.uid}`;
        if (!existsAfter(mePath)) return false;
        const meAfter = getAfter(mePath).data;
        if (!wrapKeys(meAfter).hasAny(['lastCompletionId']) || typeof meAfter.lastCompletionId !== 'string') return false;
        const compPath = `missionCompletions/${meAfter.lastCompletionId}`;
        if (exists(compPath) || !existsAfter(compPath)) return false;
        const comp = getAfter(compPath).data;
        if (comp.completedBy !== auth.uid || comp.team !== meAfter.team || comp.gameSessionId !== currentData.gameSessionId) return false;
        if (comp.points <= 0 || comp.points > 100) return false;
        if (newData.teamARole !== currentData.teamARole || newData.teamBRole !== currentData.teamBRole) return false;
        if (wrapKeys(currentData).hasAny(['nextRevealTime']) && newData.nextRevealTime !== currentData.nextRevealTime) return false;
        if (diff.hasAny(['logs']) && !validPrependedLogs(currentData, newData, ['MISSION'])) return false;
        if (meAfter.team === 'A') {
          return diff.hasOnly(['teamAScore', 'logs'])
            && newData.teamAScore === currentData.teamAScore + comp.points
            && newData.teamBScore === currentData.teamBScore;
        }
        return diff.hasOnly(['teamBScore', 'logs'])
          && newData.teamBScore === currentData.teamBScore + comp.points
          && newData.teamAScore === currentData.teamAScore;
      }

      return false;
    }

    return false;
  }

  getDoc(path, auth) {
    if (!this._evalRead(path, auth, this.docs)) {
      throw new RulePermissionError(`PERMISSION_DENIED on get(${path})`, { path, uid: auth?.uid ?? null });
    }
    return this.rawGet(path);
  }

  listCollection(collectionName, auth, predicate = null) {
    if (!this._evalList(collectionName, auth)) {
      throw new RulePermissionError(`PERMISSION_DENIED on list(${collectionName})`, { collectionName, uid: auth?.uid ?? null });
    }
    const prefix = `${collectionName}/`;
    const results = [];
    for (const [k, v] of this.docs.entries()) {
      if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
        const doc = { id: k.slice(prefix.length), data: deepClone(v) };
        if (!predicate || predicate(doc)) results.push(doc);
      }
    }
    return results;
  }

  commitBatch(ops, auth) {
    if (ops.length > 500) {
      throw new Error(`FIRESTORE_LIMIT_EXCEEDED: batch/transaction writes ${ops.length} > 500`);
    }
    const beforeMap = new Map();
    for (const [k, v] of this.docs.entries()) beforeMap.set(k, deepClone(v));

    const afterMap = new Map();
    for (const [k, v] of this.docs.entries()) afterMap.set(k, deepClone(v));

    for (const op of ops) {
      const prev = afterMap.get(op.path) ?? null;
      if (op.type === 'update' && prev === null) {
        throw new Error(`NOT_FOUND: update target ${op.path} does not exist`);
      }
      const next = resolveMaterializedDoc(prev, op, this.serverNowMs);
      if (next === null) afterMap.delete(op.path);
      else afterMap.set(op.path, next);
    }

    for (const op of ops) {
      const allowed = this._evalWrite(op, beforeMap, afterMap, auth);
      if (!allowed) {
        throw new RulePermissionError(`PERMISSION_DENIED on ${op.type}(${op.path})`, {
          op: op.type,
          path: op.path,
          uid: auth?.uid ?? null,
          serverNowMs: this.serverNowMs,
        });
      }
    }

    this.docs = afterMap;
    return { writeCount: ops.length };
  }
}

export function createActiveParticipantDb(overrides = {}) {
  const db = new SimulatedFirestore(overrides.serverNowMs ?? 1_750_000_000_000);
  const sessionId = overrides.gameSessionId ?? '11111111-1111-4111-8111-111111111111';
  db.seed('system/admin_bootstrap', {
    initializedBy: 'admin-1',
    initializedAt: FsTimestamp.fromMillis(db.serverNowMs - 10_000),
  });
  db.seed('admins/admin-1', {
    role: 'admin',
    createdAt: FsTimestamp.fromMillis(db.serverNowMs - 10_000),
  });
  db.seed('game_config/current', {
    gameSessionId: sessionId,
    sessionStartedAt: db.serverNowMs - 3_600_000,
    sessionSchemaVersion: 2,
    gameStatus: 'DAY1_ACTIVE',
    day: 1,
    missionMode: 'DIFFERENT',
    isGameOver: false,
    isFinalMissionActive: false,
    finalMissionEndTime: 0,
    victoryMode: 'SURVIVAL',
    teamARole: 'RUNNER',
    teamBRole: 'ONI',
    teamAScore: 0,
    teamBScore: 0,
    startTime: db.serverNowMs - 3_600_000,
    nextRevealTime: db.serverNowMs + 1_800_000,
    captureWaitMinutes: 30,
    postShinkansenWaitMinutes: 60,
    periodicRevealIntervalMinutes: 30,
    periodicRevealDurationMinutes: 5,
    missionPenaltyRevealMinutes: 60,
    shinkansenMaxMinutes: 150,
    shinkansenMaxSegments: 0,
    logs: [],
    ...overrides.config,
  });
  return { db, sessionId };
}
