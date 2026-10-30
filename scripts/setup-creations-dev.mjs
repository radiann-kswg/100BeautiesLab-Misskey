/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = resolve(root, '.config');
if (process.argv.includes('--test')) {
	const { load } = await import('js-yaml');
	const sample = load(await readFile(resolve(root, '.github', 'misskey', 'test.yml'), 'utf8'));
	const dev = load(await readFile(resolve(config, 'default.yml'), 'utf8'));
	sample.db = { ...dev.db, db: 'creations_e2e' };
	sample.redis = { ...dev.redis, db: 5, prefix: 'creations-e2e' };
	sample.port = 62812;
	await writeFile(resolve(config, 'creations-test.yml'), JSON.stringify(sample), { flag: 'wx', mode: 0o600 });
	console.log('Created isolated e2e config for database creations_e2e, Redis db 5, ports 62812/63812.');
	process.exit(0);
}
const targets = ['default.yml', 'creations-db.env'];
for (const name of targets) {
	try {
		await access(resolve(config, name));
		throw new Error(`${name} already exists. Existing configuration is never read, imported or overwritten.`);
	} catch (error) {
		if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
	}
}
const password = randomBytes(32).toString('hex');
await mkdir(config, { recursive: true, mode: 0o700 });
await writeFile(resolve(config, 'creations-db.env'),
	`POSTGRES_USER=misskey\nPOSTGRES_DB=misskey\nPOSTGRES_PASSWORD=${password}\n`, { flag: 'wx', mode: 0o600 });
await writeFile(resolve(config, 'default.yml'), `url: http://localhost:61820
port: 61820
db:
  host: 127.0.0.1
  port: 65432
  db: misskey
  user: misskey
  pass: ${password}
redis:
  host: 127.0.0.1
  port: 56379
  db: 0
  prefix: creations
id: aidx
clusterLimit: 1
fulltextSearch:
  provider: sqlLike
`, { flag: 'wx', mode: 0o600 });
console.log('Created private development configuration. No existing settings or credentials were imported.');
console.log('Database ports bind only to loopback. Keep the app behind your LAN/VPN and firewall.');
