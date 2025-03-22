/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { StreamClient } from "@stream-io/node-sdk";

export default {
	async fetch(request, env, ctx) {

		const client = new StreamClient(env.STREAM_API_KEY, env.STREAM_API_SECRET);

		const url = new URL(request.url);

		if (url.pathname === '/token') {
			try {
				const body = await request.json();

				// if (!body || typeof body !== 'object' || !body.hasOwnProperty('userId')) {
                //     throw new Error("Invalid request body: 'userId' is required.");
					
                // }

                const userId = body["userId"];
                // if (typeof userId !== 'string') {
                //     throw new Error("Invalid 'userId': must be a string.");
                // }

				const token = client.generateUserToken({ user_id: userId });

				const response = new Response(token, { headers: { 'Content-Type': 'text/plain' }, status: 200 });
				
				return handleCORS(request, response);
			} catch (error) {
				const response = new Response(JSON.stringify({ error: error.message }), { headers: { 'Content-Type': 'application/json' }, status: 400 });
				return handleCORS(request, response);
			}
		}

		const response = new Response('Hello this service is working');
		return handleCORS(request, response);
	},
};

function handleCORS(request, response) {
	// Allow all origins - more permissive
	response.headers.set('Access-Control-Allow-Origin', '*');
	
	// Include all requested headers in preflight response
	const requestHeaders = request.headers.get('Access-Control-Request-Headers');
	if (requestHeaders) {
	  response.headers.set('Access-Control-Allow-Headers', requestHeaders);
	} else {
	  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
	}
	
	// Allow all common methods
	response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
	
	// Allow credentials
	response.headers.set('Access-Control-Allow-Credentials', 'true');

	
	return response;
  }