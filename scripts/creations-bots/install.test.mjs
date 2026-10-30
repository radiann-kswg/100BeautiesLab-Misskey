/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkoutPath, PROTOCOL_VERSION, READY_MARKER, REPO_ROOT } from './protocol.mjs';

const upstreams = JSON.parse(readFileSync(new URL('./upstreams.json', import.meta.url), 'utf8'));

test('installer verifies fixed production runtimes without keys and persists exact readiness markers', () => {
	const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'creations-bots', 'install.mjs'), 'all'], {
		cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000,
		env: { ...process.env, ANTHROPIC_API_KEY: '', CREATIONS_BOT_MODEL: '' },
	});
	assert.equal(result.status, 0, result.stderr);
	for (const name of ['aphr', 'tarot']) {
		const path = checkoutPath(name);
		assert.ok(result.stdout.includes(`.creations-bots\\${name}\\${READY_MARKER}`));
		assert.deepEqual(JSON.parse(readFileSync(join(path, READY_MARKER), 'utf8')), {
			schemaVersion: 1,
			status: 'ready',
			protocol: PROTOCOL_VERSION,
			worker: name,
			repository: upstreams[name].repository,
			commit: upstreams[name].commit,
		});
	}
	const python = join(checkoutPath('tarot'), '.venv',
		process.platform === 'win32' ? 'Scripts' : 'bin',
		process.platform === 'win32' ? 'python.exe' : 'python');
	assert.ok(existsSync(python));
	const pythonVersion = spawnSync(python, ['--version'], { encoding: 'utf8', timeout: 10_000 });
	assert.equal(pythonVersion.status, 0, pythonVersion.stderr);
	assert.match(pythonVersion.stdout, /^Python 3\./);
});
