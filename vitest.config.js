import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		deps: {
			optimizer: {
				ssr: {
					enabled: true,
					include: ['@stream-io/node-sdk'],
				},
			},
		},
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
			},
		},
	},
});
