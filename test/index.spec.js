import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker, { PropertyCallCoordinator } from '../src/index.js';

function coordinatorHarness({ transientUpsertFailures = 0 } = {}) {
  const values = new Map();
  const alarms = [];
  let upsertAttempts = 0;
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
        getOrCreate: async () => ({}),
        end: async () => ({}),
      }),
    },
  };
  const state = {
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
    get upsertAttempts() { return upsertAttempts; },
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

  it('turns an unanswered ringing call into no_answer', async () => {
    const harness = coordinatorHarness();
    await internalPost(harness.coordinator, '/init', newCall());
    await harness.coordinator.alarm();
    expect(harness.values.get('call').status).toBe('no_answer');
  });

  it('retries transient Stream failures before ringing', async () => {
    const harness = coordinatorHarness({ transientUpsertFailures: 2 });
    const response = await internalPost(harness.coordinator, '/init', newCall());
    expect(response.status).toBe(200);
    expect(harness.upsertAttempts).toBe(3);
  });
});
