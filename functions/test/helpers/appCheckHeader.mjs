// Dummy JWT-shaped App Check token for Firebase Functions Emulator.
// The emulator skips signature verification when X-Firebase-AppCheck is present,
// while enforceAppCheck: true still requires the header to be non-empty.
const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: '1:123456789:web:abcdef' })).toString('base64url');

export const EMULATOR_APP_CHECK_TOKEN = `${header}.${payload}.emulator-signature`;
export const APP_CHECK_HEADERS = { 'X-Firebase-AppCheck': EMULATOR_APP_CHECK_TOKEN };
