/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { checkoutPath, PROTOCOL_VERSION, READY_MARKER, REPO_ROOT } from './protocol.mjs';

const upstreams = JSON.parse(readFileSync(new URL('./upstreams.json', import.meta.url), 'utf8'));
const container = join(REPO_ROOT, '.creations-bots');
const work = join(container, 'install-work');
const env = { ...process.env };
for (const name of Object.keys(env)) {
	if (/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) delete env[name];
}
Object.assign(env, {
	TEMP: work, TMP: work, TMPDIR: work,
	npm_config_cache: join(container, 'npm-cache'),
	PIP_CACHE_DIR: join(container, 'pip-cache'),
	UV_CACHE_DIR: join(container, 'uv-cache'),
	GIT_TERMINAL_PROMPT: '0',
});

function command(executable, args, cwd = REPO_ROOT) {
	return spawnSync(executable, args, { cwd, env, encoding: 'utf8', windowsHide: true, shell: false });
}

function run(executable, args, cwd) {
	const result = command(executable, args, cwd);
	if (result.error || result.status !== 0) {
		// Subprocess errors may contain credentials, registry configuration or provider output.
		throw new Error('A fixed installation command failed; check Git, npm/Python and network access.');
	}
	return result.stdout.trim();
}

function independentDirectory(path) {
	if (!existsSync(path)) mkdirSync(path);
	if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) {
		throw new Error('Refusing a linked or non-directory installation path.');
	}
}

function refuseLinkedDirectory(path) {
	if (existsSync(path) && (!lstatSync(path).isDirectory() || realpathSync(path) !== path)) {
		throw new Error('Refusing to install dependencies through a linked directory.');
	}
}

function prepareCheckout(name) {
	const spec = upstreams[name];
	const path = join(container, name);
	if (!existsSync(path)) {
		run('git', ['clone', '--quiet', '--no-checkout', '--', spec.repository, path]);
		run('git', ['-C', path, 'checkout', '--quiet', '--detach', spec.commit]);
	}
	checkoutPath(name);
	// A failed repair/reinstall must not leave a stale success marker behind.
	rmSync(join(path, READY_MARKER), { force: true });
	if (!lstatSync(join(path, '.git')).isDirectory() ||
		run('git', ['-C', path, 'rev-parse', '--show-toplevel']).replaceAll('\\', '/') !== path.replaceAll('\\', '/') ||
		run('git', ['-C', path, 'remote', 'get-url', 'origin']) !== spec.repository ||
		run('git', ['-C', path, 'rev-parse', 'HEAD']) !== spec.commit ||
		run('git', ['-C', path, 'status', '--porcelain', '--untracked-files=no']) !== '') {
		throw new Error('Existing checkout is not the clean pinned independent upstream; refusing to overwrite it.');
	}
	if (!readFileSync(join(path, 'LICENCE'), 'utf8').startsWith('Attribution-NonCommercial 4.0 International')) {
		throw new Error('Upstream license is missing or unexpected.');
	}
	return path;
}

function npmCli() {
	const candidates = [
		join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
		...(process.env.PATH || '').split(delimiter)
			.map((path) => join(path, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
	];
	const path = candidates.find((candidate) => existsSync(candidate));
	if (!path) throw new Error('Install Node.js with npm before setting up APHR.');
	return path;
}

function installAphr(path) {
	refuseLinkedDirectory(join(path, 'node_modules'));
	const npm = npmCli();
	const check = command(process.execPath, [npm, 'ls', '--depth=0', '--include=dev', '--json'], path);
	if (check.error || check.status !== 0) {
		run(process.execPath, [
			npm, 'install', '--include=dev', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund',
		], path);
	}
	// No build/start/dev command, lifecycle scripts or native SQLite build is needed.
}

function pythonCommand() {
	for (const [executable, args] of [['python', []], ['py', ['-3']]]) {
		const result = command(executable, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)']);
		if (!result.error && result.status === 0) return [executable, args];
	}
	const discovered = command('uv', ['python', 'find', '--no-managed-python', '--no-python-downloads']);
	if (!discovered.error && discovered.status === 0) {
		const python = discovered.stdout.trim();
		const result = command(python, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)']);
		if (!result.error && result.status === 0) return [python, []];
	}
	throw new Error('Install Python 3.11+ with venv/pip; the Windows Store alias alone is not Python.');
}

function installTarot(path) {
	const venv = join(path, '.venv');
	refuseLinkedDirectory(venv);
	const python = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
	if (!existsSync(python)) {
		const [executable, args] = pythonCommand();
		run(executable, [...args, '-m', 'venv', venv], path);
	}
	const check = command(python, ['-c', `
from importlib.metadata import version, PackageNotFoundError
from pathlib import Path
from pip._vendor.packaging.requirements import Requirement
import sys
missing = False
for line in Path("bot/requirements.txt").read_text(encoding="utf-8").splitlines():
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    requirement = Requirement(line)
    try:
        missing |= not requirement.specifier.contains(version(requirement.name))
    except PackageNotFoundError:
        missing = True
sys.exit(1 if missing else 0)
`], path);
	if (check.status !== 0 || check.error) {
		run(python, [
			'-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
			'--only-binary=:all:',
			'--requirement', join(path, 'bot', 'requirements.txt'),
		], path);
	}
}

function verifyWorker(name, path) {
	const executable = name === 'aphr'
		? process.execPath
		: join(path, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
	const script = join(REPO_ROOT, 'scripts', 'creations-bots', name === 'aphr' ? 'aphr.mjs' : 'tarot.py');
	const result = spawnSync(executable, [script], {
		cwd: REPO_ROOT, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000,
		// Both real upstream safety paths return deterministically without any provider key/call.
		input: JSON.stringify({ text: '消えてしまいたい', reference: '', context: [] }),
	});
	let output;
	try {
		output = JSON.parse(result.stdout);
	} catch {
		throw new Error('Worker smoke test failed; no readiness marker was written.');
	}
	if (result.error || result.status !== 0 || !output || Object.keys(output).join(',') !== 'text' ||
		typeof output.text !== 'string' || !output.text.trim()) {
		throw new Error('Worker smoke test failed; no readiness marker was written.');
	}
}

try {
	if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required.');
	const selection = process.argv[2] || 'all';
	if (process.argv.length > 3 || !['all', 'aphr', 'tarot'].includes(selection)) {
		throw new Error('Usage: node scripts\\creations-bots\\install.mjs [all|aphr|tarot]');
	}
	independentDirectory(container);
	independentDirectory(work);
	for (const name of selection === 'all' ? ['aphr', 'tarot'] : [selection]) {
		console.log(`Setting up ${name} at its fixed reviewed revision...`);
		const path = prepareCheckout(name);
		if (name === 'aphr') installAphr(path);
		else installTarot(path);
		verifyWorker(name, path);
		prepareCheckout(name);
		writeFileSync(join(path, READY_MARKER), JSON.stringify({
			schemaVersion: 1,
			status: 'ready',
			protocol: PROTOCOL_VERSION,
			worker: name,
			repository: upstreams[name].repository,
			commit: upstreams[name].commit,
		}, null, '\t') + '\n', { flag: 'wx' });
		console.log(`${name}: ready (.creations-bots\\${name}\\${READY_MARKER}; upstream LICENCE preserved).`);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
