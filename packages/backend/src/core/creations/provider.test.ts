/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { CreationsStore, defaultSettings } from './store.js';
import { generate } from './provider.js';

afterEach(() => vi.unstubAllEnvs());

describe('explicit OpenAI/Gemini provider and cost gates', () => {
	test('uses only the selected provider, sets no-storage and accounts usage', async () => {
		vi.stubEnv('CREATIONS_OPENAI_API_KEY', 'synthetic-test-key');
		const store = new CreationsStore(':memory:');
		store.write('terms:openai', 'confirmed');
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
			choices: [{ message: { content: '{"route":"chat","text":"hello"}' } }],
			usage: { prompt_tokens: 100, completion_tokens: 10 },
		})));
		try {
			const settings = { ...defaultSettings, inputJpyPerMillion: 100, outputJpyPerMillion: 400 };
			expect(await generate(settings, store, 'JSON only', [{ role: 'user', content: 'hello' }], request)).toContain('hello');
			expect(request).toHaveBeenCalledOnce();
			expect(request.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
			expect(JSON.parse(String(request.mock.calls[0][1]?.body)).store).toBe(false);
			expect(store.spent('conversation')).toBeCloseTo(0.014);
		} finally {
			store.close();
		}
	});

	test('missing cost never becomes zero and a failed provider never falls back', async () => {
		vi.stubEnv('CREATIONS_OPENAI_API_KEY', 'synthetic-test-key');
		const store = new CreationsStore(':memory:');
		store.write('terms:openai', 'confirmed');
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
			choices: [{ message: { content: 'unpriced' } }],
		})));
		try {
			await expect(generate({ ...defaultSettings, inputJpyPerMillion: 100, outputJpyPerMillion: 400 },
				store, 'JSON only', [{ role: 'user', content: 'hello' }], request)).rejects.toThrow('COST_UNKNOWN');
			expect(store.spent('conversation')).toBeGreaterThan(0);
			expect(request).toHaveBeenCalledOnce();
		} finally {
			store.close();
		}
	});

	test('Gemini uses the explicitly selected paid API and accounts all output tokens', async () => {
		vi.stubEnv('CREATIONS_GEMINI_API_KEY', 'synthetic-test-key');
		const store = new CreationsStore(':memory:');
		store.write('terms:gemini', 'confirmed');
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
			candidates: [{ content: { parts: [{ text: '{"route":"chat","text":"hello"}' }] } }],
			usageMetadata: { promptTokenCount: 100, totalTokenCount: 130 },
		})));
		try {
			await generate({ ...defaultSettings, provider: 'gemini', model: 'gemini-2.5-flash',
				inputJpyPerMillion: 100, outputJpyPerMillion: 400 },
			store, 'JSON only', [{ role: 'user', content: 'hello' }], request);
			expect(request).toHaveBeenCalledOnce();
			expect(request.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
			expect(request.mock.calls[0][1]?.headers).toHaveProperty('x-goog-api-key', 'synthetic-test-key');
			expect(store.spent('conversation')).toBeCloseTo(0.022);
		} finally {
			store.close();
		}
	});

	test('does not send text before pricing and data-use terms have been confirmed', async () => {
		vi.stubEnv('CREATIONS_GEMINI_API_KEY', 'synthetic-test-key');
		const store = new CreationsStore(':memory:');
		const request = vi.fn<typeof fetch>();
		try {
			await expect(generate({ ...defaultSettings, provider: 'gemini' }, store, 'private', [], request))
				.rejects.toThrow('PROVIDER_TERMS_NOT_CONFIRMED');
			expect(request).not.toHaveBeenCalled();
		} finally {
			store.close();
		}
	});
});
