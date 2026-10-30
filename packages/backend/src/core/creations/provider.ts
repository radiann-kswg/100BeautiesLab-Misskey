/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { CreationsError, object } from './catalog.js';
import type { Message } from './catalog.js';
import type { CreationsStore, Settings } from './store.js';

export function providerKey(settings: Settings): string | undefined {
	return process.env[settings.provider === 'openai' ? 'CREATIONS_OPENAI_API_KEY' : 'CREATIONS_GEMINI_API_KEY'];
}

function tokenCount(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CreationsError('COST_UNKNOWN');
	return value;
}

export async function generate(
	settings: Settings,
	store: CreationsStore,
	system: string,
	messages: Message[],
	request: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<string> {
	const key = providerKey(settings);
	if (!key) throw new CreationsError('PROVIDER_KEY_NOT_CONFIGURED');
	if (store.read(`terms:${settings.provider}`) !== 'confirmed') throw new CreationsError('PROVIDER_TERMS_NOT_CONFIRMED');
	if (settings.inputJpyPerMillion <= 0 || settings.outputJpyPerMillion <= 0) throw new CreationsError('COST_UNKNOWN');
	const maxOutputTokens = 512;
	const body = settings.provider === 'openai' ? {
		model: settings.model,
		messages: [{ role: 'system', content: system }, ...messages],
		max_completion_tokens: maxOutputTokens,
		response_format: { type: 'json_object' },
		store: false,
	} : {
		systemInstruction: { parts: [{ text: system }] },
		contents: messages.map(message => ({
			role: message.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: message.content }],
		})),
		generationConfig: {
			maxOutputTokens,
			responseMimeType: 'application/json',
			thinkingConfig: { thinkingBudget: 0 },
		},
	};
	const serialized = JSON.stringify(body);
	// UTF-8 bytes deliberately overestimate tokenized text, including request framing.
	const reservation = store.reserve('conversation',
		((Buffer.byteLength(serialized, 'utf8') + 2048) * settings.inputJpyPerMillion +
			maxOutputTokens * settings.outputJpyPerMillion) / 1000000, 3000);
	let response: Response;
	try {
		response = await request(settings.provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' :
			`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`, {
			method: 'POST',
			headers: settings.provider === 'openai' ?
				{ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } :
				{ 'Content-Type': 'application/json', 'x-goog-api-key': key },
			body: serialized,
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
		});
	} catch {
		throw new CreationsError('PROVIDER_NETWORK_ERROR_COST_RESERVED');
	}
	if (!response.ok) throw new CreationsError(`PROVIDER_HTTP_${response.status}_COST_RESERVED`);
	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new CreationsError('INVALID_PROVIDER_RESPONSE_COST_RESERVED');
	}
	if (!object(data)) throw new CreationsError('INVALID_PROVIDER_RESPONSE_COST_RESERVED');
	let result: unknown;
	let input: number;
	let output: number;
	if (settings.provider === 'openai') {
		if (!object(data.usage)) throw new CreationsError('COST_UNKNOWN');
		input = tokenCount(data.usage.prompt_tokens);
		output = tokenCount(data.usage.completion_tokens);
		const choice: unknown = Array.isArray(data.choices) ? data.choices[0] : null;
		result = object(choice) && object(choice.message) ? choice.message.content : null;
	} else {
		if (!object(data.usageMetadata)) throw new CreationsError('COST_UNKNOWN');
		input = tokenCount(data.usageMetadata.promptTokenCount);
		const total = tokenCount(data.usageMetadata.totalTokenCount);
		output = tokenCount(total - input);
		const candidate: unknown = Array.isArray(data.candidates) ? data.candidates[0] : null;
		const parts: unknown = object(candidate) && object(candidate.content) ? candidate.content.parts : null;
		result = Array.isArray(parts) ? parts.flatMap(part => object(part) && typeof part.text === 'string' ? [part.text] : []).join('') : null;
	}
	store.settle(reservation, (input * settings.inputJpyPerMillion + output * settings.outputJpyPerMillion) / 1000000);
	if (typeof result !== 'string' || !result.trim()) throw new CreationsError('EMPTY_PROVIDER_RESPONSE');
	return result;
}
