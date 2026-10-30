/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Test-only subprocess driver, never selected by the host's fixed worker launcher.
import { main } from './aphr.mjs';

await main({
	client: { messages: { async create(body) {
		console.log('dependency stdout must not escape');
		console.error('dependency stderr test-provider-secret must not escape');
		if (body.messages.at(-1).content === 'FAIL') throw new Error('test-provider-secret');
		return {
			content: [{ type: 'text', text: 'mock real provider result' }],
			stop_reason: 'end_turn',
			usage: { input_tokens: 1, output_tokens: 1 },
		};
	} } },
});
