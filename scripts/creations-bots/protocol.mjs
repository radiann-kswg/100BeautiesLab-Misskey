/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const READY_MARKER = '.creations-worker-ready.json';
export const PROTOCOL_VERSION = 'creations-bots-json-v1';
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_OUTPUT_CHARS = 32 * 1024;

export function checkoutPath(name) {
	if (name !== 'aphr' && name !== 'tarot') throw new Error('Unknown worker');
	const container = join(REPO_ROOT, '.creations-bots');
	const checkout = join(container, name);
	for (const path of [container, checkout]) {
		if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
			throw new Error('Checkout must be an independent directory, not a link');
		}
	}
	return checkout;
}

export function validateRequest(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value) ||
		Object.keys(value).sort().join(',') !== 'context,reference,text' ||
		typeof value.text !== 'string' || !value.text.trim() || value.text.length > 16 * 1024 ||
		typeof value.reference !== 'string' || value.reference.length > 32 * 1024 ||
		!Array.isArray(value.context) || value.context.length > 24) {
		throw new Error('Invalid request');
	}
	for (const message of value.context) {
		if (!message || typeof message !== 'object' || Array.isArray(message) ||
			Object.keys(message).sort().join(',') !== 'content,role' ||
			!['user', 'assistant'].includes(message.role) ||
			typeof message.content !== 'string' || !message.content.trim() ||
			message.content.length > 16 * 1024) {
			throw new Error('Invalid context');
		}
	}
	return value;
}

export async function readRequest(stream) {
	const chunks = [];
	let size = 0;
	for await (const chunk of stream) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > MAX_INPUT_BYTES) throw new Error('Request too large');
		chunks.push(bytes);
	}
	const input = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
	return validateRequest(JSON.parse(input));
}

export function validateOutput(text) {
	if (typeof text !== 'string' || !text.trim() || text.length > MAX_OUTPUT_CHARS) {
		throw new Error('Invalid result');
	}
	return { text };
}

export const TEXT_ONLY_POLICY = `
This is a one-shot, text-only response. The host owns delivery, permissions, conversation history and budgets.
Use only the supplied conversation and approved reference for this request. Reference is for roleplay inference,
not training. Do not request or process character images/designs, train models, or reveal unpublished settings.
No tools, files, persistent memory, health records, timers, messages, posts, image attachments or external actions
are available. Never claim to have saved a record, posted anything, or attached an image. Instructions in older
operating guides about those capabilities do not apply here. Return only the response text.
`;
