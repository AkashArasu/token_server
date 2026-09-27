import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { StreamClient } from '@stream-io/node-sdk';
import worker, { PropertyCallCoordinator } from '../src/index.js';

function coordinatorHarness({ transientUpsertFailures = 0 } = {}) {
  const values = new Map();
  const alarms = [];
  const sockets = [];
  let upsertAttempts = 0;
  let createdCallRequest;
  const streamClient = {
    async upsertUsers() {
      upsertAttempts += 1;
      if (upsertAttempts <= transientUpsertFailures) {
        const error = new Error('temporary upstream failure');
        error.statusCode = 503;
        throw error;
      }
    },
    video: {
      call: () => ({
        getOrCreate: async request => { createdCallRequest = request; return {}; },
        end: async () => ({}),
      }),
    },
  };
  const state = {
    acceptWebSocket: socket => { socket.accept(); sockets.push(socket); },
    getWebSockets: () => sockets,
    storage: {
      get: async key => values.get(key),
      put: async (key, value) => values.set(key, structuredClone(value)),
      setAlarm: async time => alarms.push(time),
      deleteAlarm: async () => alarms.push(null),
    },
  };
  return {
    coordinator: new PropertyCallCoordinator(state, {
      STREAM_API_KEY: 'test-key',
      STREAM_API_SECRET: 'test-secret',
      __STREAM_CLIENT: streamClient,
    }),
    values,
    alarms,
    sockets,
    get upsertAttempts() { return upsertAttempts; },
    get createdCallRequest() { return createdCallRequest; },
  };
}

function newCall(overrides = {}) {
  return {
    callId: 'call-1',
    requestId: 'request_1234567890',
    propertyId: 'property-1',
    homeownerUid: 'firebase-home-1',
    homeownerStreamId: 'home-1',
    homeownerName: 'Akash',
    visitorId: 'visitor-1',
    sessionToken: 'visitor-secret-1',
    ...overrides,
  };
}

async function internalPost(coordinator, path, body) {
  return coordinator.fetch(new Request(`https://call${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  }));
}

describe('QRinger signaling worker', () => {
  it('exposes a health endpoint without exposing token issuance', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('https://example.com/health'), env, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('does not retain the legacy arbitrary token endpoint', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('https://example.com/token', { method: 'POST' }), env, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(404);
  });

  it('does not expose homeowner call state without Firebase authentication', async () => {
    const response = await worker.fetch(new Request(
      'https://example.com/v1/homeowner/calls/call-1',
      { headers: { 'X-Property-Id': 'a'.repeat(20) } },
    ), env);
    expect(response.status).toBe(401);
  });

  it('rejects unsigned Stream webhooks and applies a signed call-ended event', async () => {
    const harness = coordinatorHarness();
    const propertyId = 'a'.repeat(20);
    await internalPost(harness.coordinator, '/init', newCall({ propertyId }));
    await internalPost(harness.coordinator, '/transition', {
      callId: 'call-1', action: 'accept', actor: 'homeowner:firebase-home-1',
    });
    const webhookEnv = {
      STREAM_API_KEY: 'test-key',
      STREAM_API_SECRET: 'test-secret',
      __STREAM_CLIENT: new StreamClient('test-key', 'test-secret'),
      PROPERTY_CALLS: {
        idFromName: name => name,
        get: name => {
          expect(name).toBe(propertyId);
          return { fetch: (input, init) => harness.coordinator.fetch(new Request(input, init)) };
        },
      },
    };
    const body = JSON.stringify({
      type: 'call.ended', call_cid: 'default:call-1',
      call: { id: 'call-1', custom: { property_id: propertyId } },
    });
    const unsigned = await worker.fetch(new Request('https://example.com/v1/stream/webhook', {
      method: 'POST', body,
    }), webhookEnv);
    expect(unsigned.status).toBe(401);
    expect(harness.values.get('call').status).toBe('accepted');

    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const signed = await worker.fetch(new Request('https://example.com/v1/stream/webhook', {
      method: 'POST', body, headers: { 'X-Signature': signature },
    }), webhookEnv);
    expect(signed.status, await signed.text()).toBe(200);
    expect(harness.values.get('call').status).toBe('ended');
  });

  it('permits live visitor signaling only from the configured web origin', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall({ sessionToken: 'a'.repeat(32) }));
    const routeEnv = {
      VISITOR_WEB_ORIGIN: 'https://qringer-web.pages.dev',
      PROPERTY_CALLS: {
        idFromName: name => name,
        get: () => ({ fetch: (input, init) => harness.coordinator.fetch(new Request(input, init)) }),
      },
    };
    const makeRequest = origin => new Request(
      'https://example.com/v1/calls/call-1/events?propertyId=property-1',
      { headers: {
        Origin: origin,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `qronly.v1, session.${'a'.repeat(32)}`,
      } },
    );
    const forbidden = await worker.fetch(makeRequest('https://other.example'), routeEnv);
    expect(forbidden.status).toBe(403);
    const subscribed = await worker.fetch(makeRequest('https://qringer-web.pages.dev'), routeEnv);
    expect(subscribed.status).toBe(101);
  });
});

describe('PropertyCallCoordinator reliability', () => {
  it('makes a repeated visitor request idempotent but keeps another visitor busy', async () => {
    const harness = coordinatorHarness();
    const first = await internalPost(harness.coordinator, '/init', newCall());
    expect(first.status).toBe(200);
    const firstCall = await first.json();
    expect(firstCall.status).toBe('ringing');
    expect(firstCall.sessionToken).toBe('visitor-secret-1');

    const retry = await internalPost(
      harness.coordinator,
      '/init',
      newCall({ callId: 'different-generated-id' }),
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).callId).toBe('call-1');

    const competing = await internalPost(
      harness.coordinator,
      '/init',
      newCall({ callId: 'call-2', requestId: 'another_request_1234' }),
    );
    expect(competing.status).toBe(409);
  });

  it('does not ring when a visitor abandons before session creation completes', async () => {
    const harness = coordinatorHarness();
    const abandoned = await internalPost(harness.coordinator, '/abandon', {
      requestId: 'request_1234567890',
    });
    expect(abandoned.status).toBe(200);
    const lateCreate = await internalPost(harness.coordinator, '/init', newCall());
    expect(lateCreate.status).toBe(410);
    expect(harness.values.get('call')).toBeUndefined();
    expect(harness.upsertAttempts).toBe(0);
  });

  it('cancels an in-flight session by request ID and keeps retries idempotent', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    await internalPost(harness.coordinator, '/abandon', {
      requestId: 'request_1234567890',
    });
    expect(harness.values.get('call').status).toBe('cancelled');
    const retry = await internalPost(harness.coordinator, '/init', newCall());
    expect((await retry.json()).status).toBe('cancelled');
    expect(harness.upsertAttempts).toBe(1);
  });

  it('releases the property after an accepted call ends', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    const accepted = await internalPost(harness.coordinator, '/transition', {
      action: 'accept',
      actor: 'homeowner:firebase-home-1',
    });
    expect((await accepted.json()).status).toBe('accepted');

    const ended = await internalPost(harness.coordinator, '/transition', {
      action: 'end',
      actor: 'visitor',
      sessionToken: 'visitor-secret-1',
    });
    expect((await ended.json()).status).toBe('ended');

    const next = await internalPost(
      harness.coordinator,
      '/init',
      newCall({ callId: 'call-2', requestId: 'next_request_123456' }),
    );
    expect(next.status).toBe(200);
  });

  it('keeps homeowner actions authorized and idempotent', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());

    const visitorAccept = await internalPost(harness.coordinator, '/transition', {
      action: 'accept',
      actor: 'visitor',
      sessionToken: 'visitor-secret-1',
    });
    expect(visitorAccept.status).toBe(403);

    const firstAccept = await internalPost(harness.coordinator, '/transition', {
      action: 'accept',
      actor: 'homeowner:firebase-home-1',
    });
    expect((await firstAccept.json()).status).toBe('accepted');
    const duplicateAccept = await internalPost(harness.coordinator, '/transition', {
      action: 'accept',
      actor: 'homeowner:firebase-home-1',
    });
    expect((await duplicateAccept.json()).status).toBe('accepted');
  });

  it('does not let a stale notification act on a newer call', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    const stale = await internalPost(harness.coordinator, '/transition', {
      callId: 'older-call', action: 'accept', actor: 'homeowner:firebase-home-1',
    });
    expect(stale.status).toBe(404);
    expect(harness.values.get('call').status).toBe('ringing');
  });

  it('turns an unanswered ringing call into no_answer', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    await harness.coordinator.alarm();
    expect(harness.values.get('call').status).toBe('no_answer');
  });

  it('keeps Stream and Worker ringing windows aligned at 30 seconds', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    expect(harness.createdCallRequest.data.settings_override.ring).toEqual({
      auto_cancel_timeout_ms: 30000,
      incoming_call_timeout_ms: 30000,
      missed_call_timeout_ms: 30000,
    });
  });

  it('broadcasts a native Reject as declined but never turns cancellation into a miss', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    const rejected = await internalPost(harness.coordinator, '/transition', {
      callId: 'call-1', action: 'reject', actor: 'homeowner:firebase-home-1',
    });
    expect((await rejected.json()).status).toBe('declined');
    await harness.coordinator.alarm();
    expect(harness.values.get('call').status).toBe('declined');

    await internalPost(harness.coordinator, '/init',
      newCall({ callId: 'call-2', requestId: 'next_request_123456' }));
    const cancelled = await internalPost(harness.coordinator, '/transition', {
      callId: 'call-2', action: 'cancel', actor: 'visitor', sessionToken: 'visitor-secret-1',
    });
    expect((await cancelled.json()).status).toBe('cancelled');
    await harness.coordinator.alarm();
    expect(harness.values.get('call').status).toBe('cancelled');
  });

  it('retries transient Stream failures before ringing', async () => {
    const harness = coordinatorHarness({ transientUpsertFailures: 2 });
    const response = await internalPost(harness.coordinator, '/init', newCall());
    expect(response.status).toBe(200);
    expect(harness.upsertAttempts).toBe(3);
  });

  it('releases an accepted call when a signed Stream webhook is forwarded', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    await internalPost(harness.coordinator, '/transition', {
      action: 'accept', actor: 'homeowner:firebase-home-1',
    });
    const ended = await internalPost(harness.coordinator, '/webhook-end', {
      callId: 'call-1', type: 'call.session_ended',
    });
    expect((await ended.json()).status).toBe('ended');
    const next = await internalPost(harness.coordinator, '/init',
      newCall({ callId: 'call-2', requestId: 'next_request_123456' }));
    expect(next.status).toBe(200);
  });

  it('throttles repeated calls from one source without consuming retries', async () => {
    const harness = coordinatorHarness();
    for (let index = 0; index < 20; index++) {
      const call = newCall({
        callId: `call-${index}`,
        requestId: `request_${index}_1234567890`,
        sourceKey: 'source-a',
      });
      const created = await internalPost(harness.coordinator, '/init', call);
      expect(created.status).toBe(200);
      const retry = await internalPost(harness.coordinator, '/init', call);
      expect(retry.status).toBe(200);
      await internalPost(harness.coordinator, '/transition', {
        action: 'cancel', actor: 'visitor', sessionToken: 'visitor-secret-1',
      });
    }
    const blocked = await internalPost(harness.coordinator, '/init',
      newCall({ callId: 'blocked', requestId: 'blocked_request_123456', sourceKey: 'source-a' }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const otherSource = await internalPost(harness.coordinator, '/init',
      newCall({ callId: 'other', requestId: 'other_request_123456', sourceKey: 'source-b' }));
    expect(otherSource.status).toBe(200);
  });

  it('authenticates the live signaling channel without putting its secret in the URL', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    const forbidden = await harness.coordinator.fetch(new Request(
      'https://call/subscribe?callId=call-1',
      { headers: { 'X-Visitor-Session': 'wrong' } },
    ));
    expect(forbidden.status).toBe(403);
    const subscribed = await harness.coordinator.fetch(new Request(
      'https://call/subscribe?callId=call-1',
      { headers: { 'X-Visitor-Session': 'visitor-secret-1' } },
    ));
    expect(subscribed.status).toBe(101);
    expect(harness.sockets).toHaveLength(1);
  });
});
