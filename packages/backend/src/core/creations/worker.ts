/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CreationsError, object } from './catalog.js';
import type { BotFunction, Message } from './catalog.js';

export function workerExecutable(root: string, bot: BotFunction): string {
	return bot === 'aphr' ? process.execPath : resolve(root, '.creations-bots', 'tarot', '.venv',
		process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

export function workerAvailable(root: string, bot: BotFunction): boolean {
	const marker = resolve(root, '.creations-bots', bot, '.creations-worker-ready.json');
	if (!existsSync(marker) || !existsSync(workerExecutable(root, bot))) return false;
	let ready: unknown;
	let upstreams: unknown;
	try {
		ready = JSON.parse(readFileSync(marker, 'utf8'));
		upstreams = JSON.parse(readFileSync(resolve(root, 'scripts', 'creations-bots', 'upstreams.json'), 'utf8'));
	} catch {
		throw new CreationsError('BOT_INSTALLATION_INVALID');
	}
	const expected = object(upstreams) ? upstreams[bot] : null;
	return object(ready) && object(expected) && ready.schemaVersion === 1 && ready.status === 'ready' &&
		ready.protocol === 'creations-bots-json-v1' && ready.worker === bot &&
		ready.repository === expected.repository && ready.commit === expected.commit;
}

export async function runWorker(root: string, bot: BotFunction, model: string, request: {
	text: string;
	reference: string;
	context: Message[];
}, signal?: AbortSignal): Promise<string> {
	const key = process.env.CREATIONS_ANTHROPIC_API_KEY;
	if (!key) throw new CreationsError('BOT_KEY_NOT_CONFIGURED');
	if (signal?.aborted) throw new CreationsError('BOT_STOPPED');
	return await new Promise<string>((resolveResult, reject) => {
		const executable = workerExecutable(root, bot);
		const worker = resolve(root, 'scripts', 'creations-bots', bot === 'aphr' ? 'aphr.mjs' : 'tarot.py');
		const child = spawn(executable, [worker], {
			cwd: root,
			shell: false,
			windowsHide: true,
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: process.env.HOME,
				USERPROFILE: process.env.USERPROFILE,
				PYTHONIOENCODING: 'utf-8',
				ANTHROPIC_API_KEY: key,
				CREATIONS_BOT_MODEL: model,
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		let output = '';
		let failed = false;
		const abort = () => {
			failed = true;
			child.kill();
			reject(new CreationsError('BOT_STOPPED_COST_RESERVED'));
		};
		signal?.addEventListener('abort', abort, { once: true });
		const timer = setTimeout(() => {
			failed = true;
			child.kill();
			reject(new CreationsError('BOT_TIMEOUT_COST_RESERVED'));
		}, 120000);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			output += chunk;
			if (output.length > 65536) {
				failed = true;
				child.kill();
				reject(new CreationsError('BOT_OUTPUT_TOO_LARGE'));
			}
		});
		child.stderr.resume();
		child.on('error', () => {
			failed = true;
			clearTimeout(timer);
			reject(new CreationsError('BOT_PROCESS_FAILED'));
		});
		child.on('close', code => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (failed) return;
			if (code !== 0) return reject(new CreationsError('BOT_EXECUTION_FAILED_COST_RESERVED'));
			try {
				const result: unknown = JSON.parse(output);
				if (!object(result) || typeof result.text !== 'string' || !result.text.trim()) {
					return reject(new CreationsError('INVALID_BOT_RESPONSE'));
				}
				resolveResult(result.text);
			} catch {
				reject(new CreationsError('INVALID_BOT_RESPONSE'));
			}
		});
		child.stdin.on('error', () => {
			failed = true;
			child.kill();
			clearTimeout(timer);
			reject(new CreationsError('BOT_INPUT_FAILED'));
		});
		child.stdin.end(JSON.stringify(request));
	});
}
