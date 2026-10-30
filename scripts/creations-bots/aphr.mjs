/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	checkoutPath, readRequest, TEXT_ONLY_POLICY, validateOutput, validateRequest,
} from './protocol.mjs';

// Only these upstream modules are entry points. Never import src/index, config/env,
// persona/loader, storage/db, handlers, bridge or scheduler entry points.
export async function loadUpstream() {
	const root = checkoutPath('aphr');
	const require = createRequire(join(root, 'package.json'));
	const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
	const load = (path) => tsImport(pathToFileURL(join(root, ...path)).href, import.meta.url);
	const [pipeline, prompts, provider, markup, sdk] = await Promise.all([
		load(['src', 'bot', 'pipeline.ts']),
		load(['src', 'bot', 'character', 'prompt-builder.ts']),
		load(['src', 'ai', 'anthropic.ts']),
		load(['src', 'bot', 'tools', 'xml-call-salvage.ts']),
		import(pathToFileURL(require.resolve('@anthropic-ai/sdk')).href),
	]);
	return { root, ...pipeline, ...prompts, ...provider, ...markup, Anthropic: sdk.default };
}

export async function generate(request, { client } = {}) {
	validateRequest(request);
	const upstream = await loadUpstream();
	const now = new Date();
	// Deliberately do not use loadPersonaContent: it unconditionally reads the old RP file.
	const cbtRoot = join(upstream.root, '.cbt-datas');
	const cbtDatas = readdirSync(cbtRoot)
		.filter((name) => /^[a-z0-9-]+\.md$/.test(name))
		.sort()
		.map((filename) => ({ filename, content: readFileSync(join(cbtRoot, filename), 'utf8') }));
	const systemPrompt = upstream.buildSystemPrompt({
		roleplayPrompt: request.reference || 'Respond as a helpful text-only conversational assistant.',
		cbtDatas,
	}, { channel: 'misskey', now }) + '\n\n' + TEXT_ONLY_POLICY;
	const key = process.env.ANTHROPIC_API_KEY?.trim();
	// The SDK is constructed lazily: deterministic crisis responses need no paid call.
	let provider;
	const aiProvider = {
		async generateReply(params) {
			if (!key) throw new Error('Provider key missing');
			provider ??= upstream.createAnthropicProvider(
				key,
				process.env.CREATIONS_BOT_MODEL?.trim() || undefined,
				client ?? new upstream.Anthropic({
					apiKey: key,
					baseURL: 'https://api.anthropic.com',
					timeout: 30_000,
					maxRetries: 0,
				}),
			);
			const result = await provider.generateReply({
				...params,
				tools: [],
				executeTool: async () => { throw new Error('Tools are unavailable'); },
			});
			if (upstream.containsLeakedToolCallMarkup(result.text)) {
				throw new Error('Tool markup is not a text response');
			}
			return result;
		},
	};
	// These are stateless host ports, NOT upstream stores. Nothing is persisted or
	// remembered across requests, and upstream tools cannot access any store.
	const handler = upstream.createMessagePipeline({
		aiProvider,
		systemPrompt,
		sessionStore: {
			getHistory: () => request.context.map((message) => ({ ...message })),
			getLastInteractionAt: () => null,
			appendExchange() {},
		},
		rateLimiter: {
			check: () => ({ allowed: true, exempt: true }),
			recordReply() {},
		},
		safetyIncidentStore: { record() {} },
		toolHandlerDeps: new Proxy({}, {
			get() { throw new Error('Storage is unavailable'); },
		}),
		now: () => now,
	});
	const result = await handler('host-request', request.text, 'misskey');
	if (result.suppressed) throw new Error('Suppressed response');
	return validateOutput(result.replyText);
}

export async function main(options) {
	const stdout = process.stdout.write.bind(process.stdout);
	const stderr = process.stderr.write.bind(process.stderr);
	// Neither dependency logs nor raw provider errors belong on the IPC channels.
	process.stdout.write = () => true;
	process.stderr.write = () => true;
	try {
		const result = await generate(await readRequest(process.stdin), options);
		stdout(JSON.stringify(result) + '\n');
	} catch {
		stderr('creations-bots/aphr: request failed; check setup and provider configuration.\n');
		process.exitCode = 1;
	} finally {
		process.stdout.write = stdout;
		process.stderr.write = stderr;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
