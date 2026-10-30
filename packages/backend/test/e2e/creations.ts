/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { beforeAll, afterAll, describe, test, expect } from 'vitest';
import { compiledConfigFilePath, loadConfig } from '@/config.js';
import { canonicalIdentity, object } from '@/core/creations/catalog.js';
import { MiUser } from '@/models/User.js';
import { initTestDb, sendEnvResetRequest, sendEnvUpdateRequest, createAppToken } from '../utils.js';
import type { DataSource } from 'typeorm';

const config = loadConfig();
const base = `http://localhost:${config.port}/api/`;
let root: { id: string; token: string };
let directory: string;
let db: DataSource;
let characterId: string;
const identity = { work_key: '#Works_SyntheticE2E', db_key: '#DB_Character', index: { Category: 'test', No: 1 } };
const key = canonicalIdentity(identity);

async function request(endpoint: string, data: Record<string, unknown>, token?: string) {
	const response = await fetch(`${base}${endpoint}`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...data, ...(token ? { i: token } : {}) }),
	});
	const body: unknown = response.status === 204 ? null : await response.json();
	return { status: response.status, body };
}

function record(value: unknown): Record<string, unknown> {
	if (!object(value)) throw new Error('Expected object response');
	return value;
}

function string(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Expected string field');
	return value;
}

describe('Local character administration HTTP boundary', () => {
	beforeAll(async () => {
		// The common setup drops the schema after creating its app; refresh cached root metadata afterward.
		await sendEnvResetRequest();
		const state = resolve(dirname(compiledConfigFilePath), '..', '.config', 'creations-test.sqlite');
		await rm(state, { force: true });
		await rm(`${state}-wal`, { force: true });
		await rm(`${state}-shm`, { force: true });
		directory = await mkdtemp(resolve(tmpdir(), 'misskey-creations-e2e-'));
		db = await initTestDb(true);
		await sendEnvUpdateRequest({ key: 'CREATIONS_OPENAI_API_KEY', value: '' });
		const results = await Promise.all(['owner_one', 'owner_two'].map(username => request('admin/accounts/create', {
			username, password: 'synthetic-e2e-only-password', setupPassword: config.setupPassword,
		})));
		const successes = results.filter(result => result.status === 200);
		expect(successes).toHaveLength(1);
		const body = record(successes[0].body);
		root = { id: string(body.id), token: string(body.token) };
		expect(await db.getRepository(MiUser).countBy({ isBot: false })).toBe(1);
	});

	afterAll(async () => {
		await db?.destroy();
		if (directory) await rm(directory, { recursive: true });
	});

	test('has a real root-only status route and rejects anonymous/delegated credentials', async () => {
		expect((await request('admin/creations', { action: 'status' })).status).not.toBe(200);
		const status = await request('admin/creations', { action: 'status' }, root.token);
		expect(status.status).toBe(200);
		expect(record(status.body).monthlyLimitJpy).toBe(3000);
		const delegated = await createAppToken(root, ['read:account']);
		expect((await request('admin/creations', { action: 'status' }, delegated)).status).not.toBe(200);
	});

	test('does not allow public, invitation or additional administrator-created humans', async () => {
		expect((await request('signup', { username: 'forbidden', password: 'test', invitationCode: 'any-code' })).status).toBe(403);
		expect((await request('signup-pending', { code: 'any-code' })).status).toBe(403);
		expect((await request('admin/accounts/create', { username: 'forbidden', password: 'test' }, root.token)).status).not.toBe(200);
		expect(await db.getRepository(MiUser).countBy({ isBot: false })).toBe(1);
	});

	test('AJV rejects unknown functions, unknown actions and zero pricing rather than dropping fields', async () => {
		for (const params of [
			{ action: 'execute' }, { action: 'character', functions: ['shell'] },
			{ action: 'bot', bot: 'tarot', budgetJpy: 0 },
			{ action: 'configure', inputJpyPerMillion: 0 },
		]) {
			const response = await request('admin/creations', params, root.token);
			expect(response.status).toBe(400);
			expect(record(record(response.body).error).code).toBe('INVALID_PARAM');
		}
	});

	test('known service errors are mapped without exposing keys or arbitrary exceptions', async () => {
		const response = await request('admin/creations', { action: 'start' }, root.token);
		expect(response.status).toBe(400);
		const error = record(record(response.body).error);
		expect(error.code).toBe('CREATIONS_OPERATION_FAILED');
		expect(record(error.info).reason).toBe('PROVIDER_KEY_NOT_CONFIGURED');
	});

	test('creates one passwordless Bot for a selected permitted canonical record and reuses it', async () => {
		const path = resolve(directory, 'catalog.json');
		await writeFile(path, JSON.stringify({ characters: [{
			record_identity: identity, display_name: 'Synthetic HTTP test',
			text_rp_inference: { status: 'allowed', allowed: true, reason: 'original synthetic fixture' },
			text_rp_reference: { source: 'record_fields', fields: { Character_JP: 'Synthetic test persona.' } },
		}] }));
		expect((await request('admin/creations', { action: 'catalog', catalogPath: path }, root.token)).status).toBe(200);
		for (let i = 0; i < 2; i++) {
			const response = await request('admin/creations', {
				action: 'character', characterKey: key, enabled: true, functions: ['aphr', 'tarot'],
			}, root.token);
			expect(response.status).toBe(200);
			const catalog = record(response.body).catalog;
			if (!Array.isArray(catalog)) throw new Error('Expected catalog');
			const id = string(record(catalog[0]).userId);
			if (characterId) expect(id).toBe(characterId);
			characterId = id;
		}
		const character = await db.getRepository(MiUser).findOneByOrFail({ id: characterId });
		expect(character.isBot).toBe(true);
		expect(await db.getRepository(MiUser).countBy({ isBot: false })).toBe(1);
		expect((await request('admin/creations', { action: 'status' }, character.token ?? undefined)).status).not.toBe(200);
	});

	test('can reset a saved Bot model to upstream default and stop with a minimal request', async () => {
		expect((await request('admin/creations', { action: 'bot', bot: 'tarot', model: 'synthetic-model' }, root.token)).status).toBe(200);
		const reset = await request('admin/creations', { action: 'bot', bot: 'tarot', resetModel: true }, root.token);
		expect(reset.status).toBe(200);
		const bots = record(reset.body).botStatus;
		if (!Array.isArray(bots)) throw new Error('Expected bot status');
		expect(record(bots.find(bot => record(bot).id === 'tarot')).model).toBe('');
		expect((await request('admin/creations', { action: 'bot', bot: 'tarot', enabled: false }, root.token)).status).toBe(200);
	});

	test('cannot reenable federation and has matching blocked timeline APIs', async () => {
		await request('admin/update-meta', { federation: 'all', disableRegistration: false }, root.token);
		const meta = record((await request('meta', {})).body);
		expect(meta.federation).toBe('none');
		expect(meta.disableRegistration).toBe(true);
		for (const [endpoint, code] of [['notes/global-timeline', 'GTL_DISABLED'], ['notes/hybrid-timeline', 'STL_DISABLED']]) {
			const response = await request(endpoint, {}, root.token);
			expect(record(record(response.body).error).code).toBe(code);
		}
		expect((await request('notes/timeline', {}, root.token)).status).toBe(200);
		expect((await request('notes/local-timeline', { withReplies: true }, root.token)).status).toBe(200);
	});
});
