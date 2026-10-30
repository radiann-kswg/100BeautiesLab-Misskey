/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DataSource } from 'typeorm';
import { MiUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import type { MiMeta, NotesRepository, UsersRepository, FollowingsRepository } from '@/models/_.js';
import type { NoteCreateService } from '@/core/NoteCreateService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { SignupService } from '@/core/SignupService.js';
import type { LoggerService } from '@/core/LoggerService.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type Logger from '@/logger.js';
import { CreationsService } from '@/core/CreationsService.js';
import { canonicalIdentity, CreationsError } from './catalog.js';
import { CreationsStore, defaultSettings } from './store.js';
import { generate, providerKey } from './provider.js';
import { runWorker } from './worker.js';

vi.mock('./provider.js', () => ({ generate: vi.fn(), providerKey: vi.fn(() => 'synthetic-key') }));
vi.mock('./worker.js', () => ({ runWorker: vi.fn(), workerAvailable: vi.fn(() => true) }));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

async function fixture() {
	const directory = await mkdtemp(resolve(tmpdir(), 'misskey-creations-test-'));
	const catalogPath = resolve(directory, 'catalog.json');
	const identity = { work_key: '#Works_Synthetic', db_key: '#DB_Character', index: { No: 1 } };
	const entry = {
		record_identity: identity, display_name: 'Synthetic character',
		text_rp_inference: { status: 'allowed', allowed: true, reason: 'synthetic regression fixture' },
		text_rp_reference: { source: 'record_fields', fields: { Character_JP: 'Synthetic test persona, not a real copyrighted character.' } },
	};
	await writeFile(catalogPath, JSON.stringify({ characters: [entry] }));
	const store = new CreationsStore(':memory:');
	cleanups.push(async () => { store.close(); await rm(directory, { recursive: true }); });
	const key = canonicalIdentity(identity);
	store.write('config', JSON.stringify({ ...defaultSettings, running: true, catalogPath }));
	store.saveSelection({ key, userId: 'character', username: 'char_test', enabled: true, spontaneous: false, functions: [], nextPostAt: Date.now() + 86400000 });
	const meta = mock<MiMeta>({ rootUserId: 'owner' });
	const users = mock<UsersRepository>();
	const root = new MiUser({ id: 'owner', username: 'owner', host: null, isBot: false });
	const actor = new MiUser({ id: 'character', username: 'char_test', host: null, isBot: true });
	users.findOneByOrFail.mockImplementation(async where => !Array.isArray(where) && where.id === actor.id ? actor : root);
	const input = new MiNote({
		id: 'input', userId: 'owner', userHost: null, text: '@char_test hello', mentions: ['character'],
		visibility: 'public', replyId: null, visibleUserIds: [],
	});
	const notes = mock<NotesRepository>();
	notes.find.mockImplementation(async options =>
		options?.where && !Array.isArray(options.where) && options.where.userId === 'owner' ? [input] : []);
	const noteCreate = mock<NoteCreateService>();
	noteCreate.create.mockResolvedValue(new MiNote({ id: 'response' }));
	const visibility = mock<NoteEntityService>();
	visibility.isVisibleForMe.mockResolvedValue(true);
	const signup = mock<SignupService>();
	const logger = mock<LoggerService>();
	logger.getLogger.mockReturnValue(mock<Logger>());
	const followings = mock<FollowingsRepository>();
	const utility = mock<UtilityService>();
	utility.isSelfHost.mockImplementation(host => host === null || host === 'misskey.local');
	const service = new CreationsService(meta, mock<DataSource>(), notes, users, followings, noteCreate, visibility, signup, logger, utility);
	Object.defineProperty(service, 'store', { value: store });
	vi.mocked(generate).mockResolvedValue('{"route":"chat","text":"Synthetic reply"}');
	vi.mocked(providerKey).mockReturnValue('synthetic-key');
	return { service, store, key, input, root, actor, users, notes, followings, noteCreate, signup, entry, catalogPath };
}

describe('connected mention-to-character runtime', () => {
	test('posts exactly once as the selected character, with a public local reply', async () => {
		const f = await fixture();
		await f.service.tick();
		await f.service.tick();
		expect(generate).toHaveBeenCalledOnce();
		expect(f.noteCreate.create).toHaveBeenCalledExactlyOnceWith(f.actor, expect.objectContaining({
			reply: f.input, localOnly: true, visibility: 'public', text: '@owner Synthetic reply',
		}));
		expect(f.store.countPosts(f.key, false)).toBe(0);
	});

	test.each(['ordinary soliloquy', 'reply with only an implicit recipient'])('never auto-replies without an explicit mention: %s', async text => {
		const f = await fixture();
		f.input.text = text;
		await f.service.tick();
		expect(generate).not.toHaveBeenCalled();
		expect(f.noteCreate.create).not.toHaveBeenCalled();
	});

	test.each(['@char_test、こんにちは', '（@char_test）元気？', '@char_test@misskey.local hello'])('accepts native MFM local mentions: %s', async text => {
		const f = await fixture();
		f.input.text = text;
		await f.service.tick();
		expect(generate).toHaveBeenCalledOnce();
		expect(f.noteCreate.create).toHaveBeenCalledOnce();
	});

	test('a remote-looking textual mention cannot activate an implicit local reply recipient', async () => {
		const f = await fixture();
		f.input.text = '@char_test@remote.example hello';
		await f.service.tick();
		expect(generate).not.toHaveBeenCalled();
	});

	test('never follows a bot-authored mention chain', async () => {
		const f = await fixture();
		f.root.isBot = true;
		await f.service.tick();
		expect(generate).not.toHaveBeenCalled();
	});

	test.each(['followers', 'specified'] as const)('does not widen a %s reply to a bot follower audience', async visibility => {
		const f = await fixture();
		f.input.visibility = visibility;
		await f.service.tick();
		expect(f.noteCreate.create).toHaveBeenCalledWith(f.actor, expect.objectContaining({
			visibility: 'specified', visibleUsers: [f.root],
		}));
	});

	test('clarification is a single reply, not a bot execution or duplicate chat', async () => {
		const f = await fixture();
		vi.mocked(generate).mockResolvedValue('{"route":"clarify","text":"Which function?"}');
		await f.service.tick();
		expect(runWorker).not.toHaveBeenCalled();
		expect(f.noteCreate.create).toHaveBeenCalledOnce();
	});

	test('a functional route executes once and posts only the worker response on the same account', async () => {
		const f = await fixture();
		vi.stubEnv('CREATIONS_ANTHROPIC_API_KEY', 'synthetic-key');
		const settings = f.store.settings();
		settings.bots.tarot = { enabled: true, model: '', budgetJpy: 100, estimatePerCallJpy: 10 };
		f.store.write('config', JSON.stringify(settings));
		f.store.write('terms:tarot', 'confirmed');
		const selection = f.store.selections()[0];
		selection.functions = ['tarot'];
		f.store.saveSelection(selection);
		vi.mocked(generate).mockResolvedValue('{"route":"tarot","text":"Never post this routing draft"}');
		vi.mocked(runWorker).mockResolvedValue('The single worker result');
		await f.service.tick();
		expect(runWorker).toHaveBeenCalledOnce();
		expect(f.noteCreate.create).toHaveBeenCalledExactlyOnceWith(f.actor, expect.objectContaining({
			text: '@owner The single worker result',
		}));
		expect(f.store.spent('tarot')).toBe(10);
		expect(f.store.countPosts(f.key, false)).toBe(0);
	});

	test('unknown conversation cost pauses generation and explains the stopped reply', async () => {
		const f = await fixture();
		vi.mocked(generate).mockRejectedValue(new CreationsError('COST_UNKNOWN'));
		await f.service.tick();
		expect(f.store.settings().running).toBe(false);
		expect(f.noteCreate.create).toHaveBeenCalledOnce();
		expect(f.noteCreate.create.mock.calls[0][1].text).toContain('COST_UNKNOWN');
	});

	test('an explicit stop cancels delivery of an in-flight generation', async () => {
		const f = await fixture();
		vi.mocked(generate).mockImplementation(async () => {
			await f.service.manage({ action: 'stop' }, 'owner');
			return '{"route":"chat","text":"Must not post"}';
		});
		await f.service.tick();
		expect(f.noteCreate.create).not.toHaveBeenCalled();
	});

	test('a pending start cannot undo a completed stop or move the cursor', async () => {
		const f = await fixture();
		const settings = f.store.settings();
		settings.running = false;
		settings.inputJpyPerMillion = 100;
		settings.outputJpyPerMillion = 400;
		f.store.write('config', JSON.stringify(settings));
		f.store.write('terms:openai', 'confirmed');
		f.store.write('cursor', 'unchanged');
		let resolveFind: (note: MiNote | null) => void = () => { throw new Error('Find not started'); };
		let started: () => void = () => { throw new Error('Signal not initialized'); };
		const reachedFind = new Promise<void>(resolveStarted => { started = resolveStarted; });
		f.notes.findOne.mockImplementation(async () => {
			started();
			return await new Promise<MiNote | null>(resolveNote => { resolveFind = resolveNote; });
		});
		const start = f.service.manage({ action: 'start' }, 'owner');
		await reachedFind;
		await f.service.manage({ action: 'stop' }, 'owner');
		resolveFind(null);
		await expect(start).rejects.toThrow('START_CANCELLED_BY_STOP');
		expect(f.store.settings().running).toBe(false);
		expect(f.store.read('cursor')).toBe('unchanged');
	});

	test('spontaneous scheduling never overwrites a concurrent character disable', async () => {
		const f = await fixture();
		f.input.text = 'not a mention';
		await f.service.tick();
		const selection = f.store.selections()[0];
		f.store.saveSelection({ ...selection, spontaneous: true, nextPostAt: 0 });
		f.followings.existsBy.mockImplementation(async () => {
			f.store.saveSelection({ ...f.store.selections()[0], enabled: false });
			return false;
		});
		await f.service.tick();
		expect(f.store.selections()[0].enabled).toBe(false);
		expect(generate).not.toHaveBeenCalled();
		expect(f.noteCreate.create).not.toHaveBeenCalled();
	});

	test('a character disabled during spontaneous generation cannot publish', async () => {
		const f = await fixture();
		f.input.text = 'not a mention';
		await f.service.tick();
		f.store.saveSelection({ ...f.store.selections()[0], spontaneous: true, nextPostAt: 0 });
		vi.mocked(generate).mockImplementation(async () => {
			f.store.saveSelection({ ...f.store.selections()[0], enabled: false });
			return '{"route":"chat","text":"Must not post"}';
		});
		await f.service.tick();
		expect(f.noteCreate.create).not.toHaveBeenCalled();
	});

	test('functional spontaneous posts share the character quota but use a separate bot budget', async () => {
		const f = await fixture();
		f.input.text = 'not a mention';
		await f.service.tick();
		vi.stubEnv('CREATIONS_ANTHROPIC_API_KEY', 'synthetic-key');
		const settings = f.store.settings();
		settings.bots.tarot = { enabled: true, model: '', budgetJpy: 100, estimatePerCallJpy: 10 };
		f.store.write('config', JSON.stringify(settings));
		f.store.write('terms:tarot', 'confirmed');
		f.store.recordPost('previous-normal-post', f.key, false);
		f.store.saveSelection({ ...f.store.selections()[0], spontaneous: true, nextPostAt: 0, functions: ['tarot'] });
		vi.mocked(runWorker).mockResolvedValue('Synthetic daily tarot');
		await f.service.tick();
		expect(generate).not.toHaveBeenCalled();
		expect(runWorker).toHaveBeenCalledOnce();
		expect(f.noteCreate.create).toHaveBeenCalledExactlyOnceWith(f.actor, expect.objectContaining({
			text: 'Synthetic daily tarot', visibility: 'public', localOnly: true,
		}));
		expect(f.store.countPosts(f.key, false)).toBe(2);
		expect(f.store.spent('tarot')).toBe(10);
		expect(f.store.spent('conversation')).toBe(0);
	});

	test('unknown spontaneous cost pauses instead of repeatedly generating unpriced posts', async () => {
		const f = await fixture();
		f.input.text = 'not a mention';
		await f.service.tick();
		f.store.saveSelection({ ...f.store.selections()[0], spontaneous: true, nextPostAt: 0 });
		vi.mocked(generate).mockRejectedValue(new CreationsError('COST_UNKNOWN'));
		await f.service.tick();
		expect(f.store.settings().running).toBe(false);
		expect(f.store.read('lastError')).toBe('COST_UNKNOWN');
		expect(f.noteCreate.create).not.toHaveBeenCalled();
	});

	test('permission revocation during generation prevents delivery', async () => {
		const f = await fixture();
		vi.mocked(generate).mockImplementation(async () => {
			await writeFile(f.catalogPath, JSON.stringify({ characters: [{
				...f.entry, text_rp_inference: { status: 'denied', allowed: false, reason: 'revoked' },
			}] }));
			return '{"route":"chat","text":"Must not post"}';
		});
		await f.service.tick();
		expect(f.noteCreate.create).not.toHaveBeenCalled();
	});

	test('root-only management never turns unknown source permission into an account', async () => {
		const f = await fixture();
		await expect(f.service.manage({ action: 'status' }, 'another-account')).rejects.toThrow('ROOT_ACCOUNT_REQUIRED');
		await writeFile(f.catalogPath, JSON.stringify({ characters: [{
			...f.entry, text_rp_inference: { status: 'unknown', allowed: false, reason: 'not confirmed' },
		}] }));
		await expect(f.service.manage({ action: 'character', characterKey: f.key, enabled: true }, 'owner'))
			.rejects.toThrow('TEXT_RP_PERMISSION_REQUIRED');
		expect(f.signup.signupManagedCharacter).not.toHaveBeenCalled();
	});
});
