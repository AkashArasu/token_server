import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach} from 'vitest';
import worker from '../src';

// vi.mock('@stream-io/node-sdk', () => {
// 	return {
// 		StreamClient: vi.fn().mockImplementation(() => ({
// 			generateUserToken: vi.fn().mockReturnValue("mock-token")
// 		}))
// 	};
// });

describe('Token Generator worker', () => {
	// beforeEach(() => {
	// 	vi.clearAllMocks()
	// });
	it('responds with Hello World! (unit style)', async () => {
		const request = new Request('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('http://example.com');
		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
	});

	// it('responds with token', async () => {
	// 	const response = await SELF.fetch('http://example.com/token', {
	// 		method: 'POST',
	// 		headers: {
	// 			'Content-Type': 'application/json',
	// 		},
	// 		body: JSON.stringify({ userId: 'test-user' }),
	// 	});
	// 	expect(await response.json()).toEqual({ "token": "mock-token" });
	// });
});
