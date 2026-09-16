const CALL_TYPE = 'default';
const RING_TIMEOUT_MS = 30_000;
const ACCEPTED_CALL_SAFETY_TIMEOUT_MS = 60 * 60 * 1000;
const STALE_RING_GRACE_MS = 10_000;
const STREAM_OPERATION_ATTEMPTS = 3;
const TERMINAL_STATES = new Set(['declined', 'busy', 'no_answer', 'cancelled', 'ended']);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env, origin);
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      let response;
      if (path === '/health') response = json({ ok: true });
      else if (path === '/v1/homeowner/profile' && request.method === 'POST') response = await createOrGetProperty(await requireHomeowner(request, env), env);
      else if (path === '/v1/homeowner/session' && request.method === 'POST') {
        const homeowner = await requireHomeowner(request, env);
        const body = await request.json().catch(() => ({}));
        response = await homeownerSession(homeowner, body, env);
      }
      else if (path === '/v1/homeowner/property/regenerate' && request.method === 'POST') response = await regenerateProperty(await requireHomeowner(request, env), env);
      else if (path === '/v1/visitor-sessions' && request.method === 'POST') {
        const body = await request.json().catch(() => { throw httpError(400, 'invalid_request'); });
        response = await createVisitorSession(body, env);
      }
      else if (/^\/v1\/calls\/[^/]+\/events$/.test(path) && request.method === 'GET') response = await callEvents(path.split('/')[3], request, env);
      else if (/^\/v1\/calls\/[^/]+\/(accept|reject|cancel|end)$/.test(path) && request.method === 'POST') {
        const [, callId, action] = path.match(/^\/v1\/calls\/([^/]+)\/(accept|reject|cancel|end)$/);
        response = await transitionCall(callId, action, request, env);
      } else response = json({ error: 'not_found' }, 404);
      return cors(response, env, origin);
    } catch (error) {
      return cors(json({ error: error.message || 'internal_error' }, error.status || 500), env, origin);
    }
  },
};

export class PropertyCallCoordinator {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') return this.init(await request.json());
    const call = await this.state.storage.get('call');
    if (!call) return json({ error: 'call_not_found' }, 404);
    // This internal Durable Object endpoint is only reached through the Worker.
    // The Worker removes the visitor session secret before responding externally.
    if (url.pathname === '/state') return json(call);
    if (url.pathname === '/transition') return this.transition(call, await request.json());
    return json({ error: 'not_found' }, 404);
  }
  async init(input) {
    let active = await this.state.storage.get('call');
    // Calls created by the previous release did not record `acceptedAt`, and
    // its End transition was ignored.  Retire only those legacy orphaned calls
    // so a deployment repairs a property that is already stuck Busy without
    // ever terminating a call accepted by this release.
    const now = Date.now();
    const staleLegacyAccepted = active?.status === 'accepted' && !active.acceptedAt;
    const staleAccepted = active?.status === 'accepted' && active.acceptedAt && now - active.acceptedAt >= ACCEPTED_CALL_SAFETY_TIMEOUT_MS;
    const staleRinging = (active?.status === 'calling' || active?.status === 'ringing') && now - (active.updatedAt || active.createdAt) >= RING_TIMEOUT_MS + STALE_RING_GRACE_MS;
    if (staleLegacyAccepted || staleAccepted || staleRinging) {
      active.status = staleRinging ? 'no_answer' : 'ended'; active.updatedAt = now;
      await this.state.storage.put('call', active);
      await endStreamCall(this.env, active);
    }
    if (active && !TERMINAL_STATES.has(active.status)) {
      // Retrying the same browser request after a lost response must return
      // the original credentials rather than report the homeowner as Busy.
      if (input.requestId && active.requestId === input.requestId) return json(active);
      return json({ status: 'busy', callId: active.callId }, 409);
    }
    const call = { ...input, status: 'calling', createdAt: now, updatedAt: now };
    await this.state.storage.put('call', call);
    // Cover the small crash window between persisting `calling` and receiving
    // Stream's response. A later alarm can always release the property.
    await this.state.storage.setAlarm(now + RING_TIMEOUT_MS + STALE_RING_GRACE_MS);
    try {
      await createStreamCall(this.env, call);
    } catch (error) {
      call.status = 'ended'; call.updatedAt = Date.now();
      await this.state.storage.put('call', call);
      await this.state.storage.deleteAlarm();
      throw error;
    }
    call.status = 'ringing';
    call.updatedAt = Date.now();
    await this.state.storage.put('call', call);
    await this.state.storage.setAlarm(Date.now() + RING_TIMEOUT_MS);
    return json(publicCall(call));
  }
  async transition(call, { action, actor, sessionToken }) {
    const isHomeowner = actor === `homeowner:${call.homeownerUid}`;
    const isVisitor = actor === 'visitor' && sessionToken === call.sessionToken;
    if (!isHomeowner && !isVisitor) return json({ error: 'forbidden' }, 403);
    if ((action === 'accept' || action === 'reject') && !isHomeowner) return json({ error: 'forbidden' }, 403);
    if (action === 'cancel' && !isVisitor) return json({ error: 'forbidden' }, 403);
    // An accepted call remains live until either participant ends it.  The
    // previous implementation treated `accepted` as terminal here, so an End
    // request was ignored and the property stayed Busy forever.
    if (TERMINAL_STATES.has(call.status) || (call.status === 'accepted' && action !== 'end')) return json(publicCall(call));
    call.status = action === 'accept' ? 'accepted' : action === 'reject' ? 'declined' : action === 'cancel' ? 'cancelled' : 'ended';
    if (call.status === 'accepted') call.acceptedAt = Date.now();
    call.updatedAt = Date.now();
    await this.state.storage.put('call', call);
    if (call.status === 'accepted') {
      await this.state.storage.setAlarm(call.acceptedAt + ACCEPTED_CALL_SAFETY_TIMEOUT_MS);
    } else if (TERMINAL_STATES.has(call.status)) {
      await this.state.storage.deleteAlarm(); await endStreamCall(this.env, call);
    }
    return json(publicCall(call));
  }
  async alarm() {
    const call = await this.state.storage.get('call');
    if (!call) return;
    if (call.status === 'accepted') {
      const deadline = (call.acceptedAt || call.updatedAt) + ACCEPTED_CALL_SAFETY_TIMEOUT_MS;
      if (Date.now() < deadline) { await this.state.storage.setAlarm(deadline); return; }
      call.status = 'ended';
    } else if (call.status === 'ringing' || call.status === 'calling') {
      call.status = 'no_answer';
    } else return;
    call.updatedAt = Date.now();
    await this.state.storage.put('call', call); await endStreamCall(this.env, call);
  }
}

async function createVisitorSession(body, env) {
  if (!body?.propertyId || typeof body.propertyId !== 'string') throw httpError(400, 'invalid_property');
  const requestId = typeof body.requestId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId) ? body.requestId : crypto.randomUUID().replaceAll('-', '');
  const property = await env.DB.prepare('SELECT public_id, homeowner_uid, homeowner_stream_id, homeowner_name FROM properties WHERE public_id = ? AND revoked_at IS NULL').bind(body.propertyId).first();
  if (!property) throw httpError(404, 'property_not_found');
  const callId = crypto.randomUUID().replaceAll('-', '');
  const visitorId = `visitor_${crypto.randomUUID().replaceAll('-', '')}`;
  const sessionToken = crypto.randomUUID().replaceAll('-', '');
  const stub = env.PROPERTY_CALLS.get(env.PROPERTY_CALLS.idFromName(property.public_id));
  const initial = await stub.fetch('https://call/init', { method: 'POST', body: JSON.stringify({ callId, requestId, propertyId: property.public_id, homeownerUid: property.homeowner_uid, homeownerStreamId: property.homeowner_stream_id, homeownerName: property.homeowner_name || 'Homeowner', visitorId, sessionToken }) });
  if (initial.status === 409) throw httpError(409, 'busy');
  if (!initial.ok) throw httpError(initial.status, 'call_creation_failed');
  const state = await initial.json();
  const streamToken = (await stream(env)).generateCallToken({ user_id: state.visitorId, call_cids: [`${CALL_TYPE}:${state.callId}`], validity_in_seconds: 3600 });
  // The API key is public by design.  Returning the exact key that minted the
  // token prevents a deployed visitor web build from connecting to a different
  // Stream application than the Worker.
  return json({ ...publicCall(state), visitorId: state.visitorId, streamToken, sessionToken: state.sessionToken, streamApiKey: env.STREAM_API_KEY, expiresInSeconds: 3600 });
}

async function callEvents(callId, request, env) {
  const propertyId = request.headers.get('X-Property-Id'); const token = request.headers.get('X-Visitor-Session');
  if (!propertyId || !token) throw httpError(401, 'missing_session');
  const state = await (await env.PROPERTY_CALLS.get(env.PROPERTY_CALLS.idFromName(propertyId)).fetch('https://call/state')).json();
  if (state.callId !== callId || token !== state.sessionToken) throw httpError(403, 'forbidden');
  return json(publicCall(state));
}

async function transitionCall(callId, action, request, env) {
  const body = await request.json().catch(() => ({})); const propertyId = request.headers.get('X-Property-Id') || body.propertyId;
  if (!propertyId) throw httpError(400, 'missing_property');
  let actor = 'visitor';
  try { actor = `homeowner:${(await requireHomeowner(request, env)).uid}`; } catch (error) { if (action === 'accept' || action === 'reject') throw error; }
  const response = await env.PROPERTY_CALLS.get(env.PROPERTY_CALLS.idFromName(propertyId)).fetch('https://call/transition', { method: 'POST', body: JSON.stringify({ action, actor, sessionToken: request.headers.get('X-Visitor-Session') || body.sessionToken }) });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

async function homeownerSession(homeowner, body, env) {
  const property = await ensureProperty(homeowner, env, homeownerName(body?.displayName, homeowner.name)); const client = await stream(env);
  await withStreamRetry(() => client.upsertUsers([{ id: property.homeowner_stream_id, name: property.homeowner_name || 'Homeowner' }]));
  return json({ homeownerId: property.homeowner_stream_id, streamToken: client.generateUserToken({ user_id: property.homeowner_stream_id, validity_in_seconds: 3600 }), propertyId: property.public_id });
}
async function createOrGetProperty(homeowner, env) { return json(await ensureProperty(homeowner, env)); }
async function ensureProperty(homeowner, env, displayName) {
  let property = await env.DB.prepare('SELECT public_id, homeowner_uid, homeowner_stream_id, homeowner_name FROM properties WHERE homeowner_uid = ? AND revoked_at IS NULL').bind(homeowner.uid).first();
  if (property) {
    if (displayName && displayName !== property.homeowner_name) {
      await env.DB.prepare('UPDATE properties SET homeowner_name = ? WHERE public_id = ?').bind(displayName, property.public_id).run();
      property.homeowner_name = displayName;
    }
    return property;
  }
  property = { public_id: randomPublicId(), homeowner_uid: homeowner.uid, homeowner_stream_id: `home_${homeowner.uid}`, homeowner_name: displayName || 'Homeowner' };
  await env.DB.prepare('INSERT INTO properties (public_id, homeowner_uid, homeowner_stream_id, homeowner_name, created_at) VALUES (?, ?, ?, ?, ?)').bind(property.public_id, property.homeowner_uid, property.homeowner_stream_id, property.homeowner_name, Date.now()).run();
  return property;
}
async function regenerateProperty(homeowner, env) {
  const current = await ensureProperty(homeowner, env); const next = randomPublicId();
  await env.DB.prepare('UPDATE properties SET revoked_at = ? WHERE homeowner_uid = ? AND revoked_at IS NULL').bind(Date.now(), homeowner.uid).run();
  await env.DB.prepare('INSERT INTO properties (public_id, homeowner_uid, homeowner_stream_id, homeowner_name, created_at) VALUES (?, ?, ?, ?, ?)').bind(next, homeowner.uid, current.homeowner_stream_id, current.homeowner_name || 'Homeowner', Date.now()).run();
  return json({ ...current, public_id: next });
}
async function createStreamCall(env, call) {
  const client = await stream(env);
  await withStreamRetry(() => client.upsertUsers([{ id: call.visitorId, name: 'Visitor' }, { id: call.homeownerStreamId, name: call.homeownerName || 'Homeowner' }]));
  await withStreamRetry(() => client.video.call(CALL_TYPE, call.callId).getOrCreate({
    // `ring` performs delivery to the homeowner. Stream rejects requests
    // that also set the separate `notify` flag.
    ring: true,
    data: {
      // The visitor initiated the doorbell call. Stream does not ring the
      // creator, so making the homeowner the creator suppresses delivery to
      // the intended callee.
      created_by_id: call.visitorId,
      members: [{ user_id: call.visitorId }, { user_id: call.homeownerStreamId }],
      custom: { qringer: true },
    },
  }));
}
async function endStreamCall(env, call) {
  try { await withStreamRetry(async () => (await stream(env)).video.call(CALL_TYPE, call.callId).end()); }
  catch (error) { console.error('Unable to end Stream call', call.callId, error?.message || error); }
}
async function withStreamRetry(operation) {
  let lastError;
  for (let attempt = 1; attempt <= STREAM_OPERATION_ATTEMPTS; attempt++) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      const status = Number(error?.statusCode || error?.status || error?.response?.status || 0);
      const permanentClientError = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanentClientError || attempt === STREAM_OPERATION_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError;
}
let cachedStreamClient;
let cachedStreamCredentials;
async function stream(env) {
  if (!env.STREAM_API_KEY || !env.STREAM_API_SECRET) throw httpError(503, 'signaling_not_configured');
  if (env.__STREAM_CLIENT) return env.__STREAM_CLIENT;
  const credentials = `${env.STREAM_API_KEY}:${env.STREAM_API_SECRET}`;
  if (cachedStreamClient && cachedStreamCredentials === credentials) return cachedStreamClient;
  const { StreamClient } = await import('@stream-io/node-sdk');
  cachedStreamCredentials = credentials;
  cachedStreamClient = new StreamClient(env.STREAM_API_KEY, env.STREAM_API_SECRET);
  return cachedStreamClient;
}
async function requireHomeowner(request, env) { const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''); if (!token) throw httpError(401, 'missing_authorization'); return verifyFirebaseToken(token, env); }
async function verifyFirebaseToken(token, env) {
  const [headerPart, payloadPart, signaturePart] = token.split('.'); if (!headerPart || !payloadPart || !signaturePart) throw httpError(401, 'invalid_authorization');
  const header = JSON.parse(atobUrl(headerPart)); const payload = JSON.parse(atobUrl(payloadPart)); const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` || !payload.sub || payload.exp * 1000 <= Date.now()) throw httpError(401, 'invalid_authorization');
  // Firebase's x509 endpoint returns certificate PEMs, not raw SPKI public
  // keys. Import Google's equivalent JWK instead, which Web Crypto supports
  // directly and avoids parsing certificate text as base64.
  if (header.alg !== 'RS256') throw httpError(401, 'invalid_authorization');
  const jwk = await firebaseJwk(header.kid);
  if (!jwk) throw httpError(401, 'invalid_authorization');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`))) throw httpError(401, 'invalid_authorization');
  return { uid: payload.user_id || payload.sub, name: payload.name };
}
let cachedFirebaseJwks;
let cachedFirebaseJwksAt = 0;
async function firebaseJwk(kid) {
  const cached = cachedFirebaseJwks?.keys?.find(candidate => candidate.kid === kid);
  if (cached && Date.now() - cachedFirebaseJwksAt < 60 * 60 * 1000) return cached;
  try {
    const response = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
    if (!response.ok) throw new Error(`firebase_jwk_${response.status}`);
    cachedFirebaseJwks = await response.json(); cachedFirebaseJwksAt = Date.now();
    return cachedFirebaseJwks.keys?.find(candidate => candidate.kid === kid);
  } catch (error) {
    // A cached matching key is still cryptographically valid during a brief
    // Google endpoint outage; Firebase key rotation is handled on the next hit.
    if (cached) return cached;
    throw httpError(503, 'firebase_keys_unavailable');
  }
}
function publicCall(call) { const { sessionToken, requestId, ...safe } = call; return safe; }
function randomPublicId() { return crypto.randomUUID().replaceAll('-', '').slice(0, 20); }
function homeownerName(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (candidate && candidate.length <= 80) return candidate;
  return typeof fallback === 'string' && fallback.trim() ? fallback.trim().slice(0, 80) : 'Homeowner';
}
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
function cors(response, env, origin) { if (origin && origin === env.VISITOR_WEB_ORIGIN) response.headers.set('Access-Control-Allow-Origin', origin); response.headers.set('Vary', 'Origin'); response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Property-Id, X-Visitor-Session'); response.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); return response; }
function httpError(status, message) { const error = new Error(message); error.status = status; return error; }
function atobUrl(value) {
  // JWT header, payload, and signature segments use unpadded base64url.
  // Cloudflare's atob implementation requires valid base64 padding.
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const remainder = normalized.length % 4;
  if (remainder === 1) throw new Error('invalid_base64url');
  return atob(normalized + '='.repeat((4 - remainder) % 4));
}
function base64UrlBytes(value) { const binary = atobUrl(value); return Uint8Array.from(binary, char => char.charCodeAt(0)); }
