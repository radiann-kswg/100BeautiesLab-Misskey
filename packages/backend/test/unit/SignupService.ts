/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { SignupService } from '@/core/SignupService.js';
import { MiMeta } from '@/models/Meta.js';
import { MiUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiUsedUsername } from '@/models/UsedUsername.js';
import { SignupApiService } from '@/server/api/SignupApiService.js';
import CreateAccountEndpoint from '@/server/api/endpoints/admin/accounts/create.js';
import type { Config } from '@/config.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { UserService } from '@/core/UserService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { IdService } from '@/core/IdService.js';
import type { MetaService } from '@/core/MetaService.js';
import type UsersChart from '@/core/chart/charts/users.js';
import type { MiLocalUser } from '@/models/User.js';
import type { DataSource, EntityManager } from 'typeorm';
import type { FastifyRequest, FastifyReply } from 'fastify';

function database(rootUserId: string | null = null) {
	const meta: MiMeta = Object.assign(new MiMeta(), { id: 'x', rootUserId, preservedUsernames: [], prohibitedWordsForNameOfUser: [] });
	const users: MiUser[] = [];
	const profiles: MiUserProfile[] = [];
	const usedNames: MiUsedUsername[] = [];
	const calls: string[] = [];
	let tail = Promise.resolve();
	let failProfile = false;
	const transaction = vi.fn(async (callback: (manager: EntityManager) => Promise<void>) => {
		let unlock = () => {};
		const pendingUsers: MiUser[] = [];
		const pendingProfiles: MiUserProfile[] = [];
		const pendingNames: MiUsedUsername[] = [];
		let pendingMeta: Partial<MiMeta> = {};
		const manager = {
			query: async (_query: string, params: string[]) => {
				calls.push(params[0]);
				if (params[0] === 'signup:root') {
					const previous = tail;
					tail = new Promise<void>(resolve => { unlock = resolve; });
					await previous;
				}
			},
			find: async () => {
				calls.push('readMeta');
				return [{ ...meta }];
			},
			findOneBy: async (entity: unknown, where: { username?: string; usernameLower?: string }) => {
				if (entity === MiUser) return users.find(x => x.usernameLower === where.usernameLower) ?? null;
				if (entity === MiUsedUsername) return usedNames.find(x => x.username === where.username) ?? null;
				throw new Error('Unexpected entity');
			},
			save: async (entity: object) => {
				if (entity instanceof MiUser) pendingUsers.push(entity);
				if (entity instanceof MiUserProfile) {
					if (failProfile) throw new Error('PROFILE_FAILED');
					pendingProfiles.push(entity);
				}
				if (entity instanceof MiUsedUsername) pendingNames.push(entity);
				return entity;
			},
			update: async (_entity: unknown, _id: string, data: Partial<MiMeta>) => {
				calls.push('writeMeta');
				pendingMeta = { ...pendingMeta, ...data };
			},
		};
		try {
			await callback(manager as unknown as EntityManager);
			users.push(...pendingUsers);
			profiles.push(...pendingProfiles);
			usedNames.push(...pendingNames);
			Object.assign(meta, pendingMeta);
		} finally {
			unlock();
		}
	});
	return {
		db: { transaction } as unknown as DataSource,
		meta, users, profiles, usedNames, calls, transaction,
		failProfile: () => { failProfile = true; },
	};
}

function signupService(store: ReturnType<typeof database>, cachedRoot: string | null = store.meta.rootUserId) {
	const meta = { ...store.meta, rootUserId: cachedRoot };
	const entityService = {
		validateLocalUsername: (username: unknown) => typeof username === 'string' && /^\w{1,20}$/.test(username),
		validatePassword: (password: unknown) => typeof password === 'string' && password.length > 0,
		validateName: (name: unknown) => typeof name === 'string' && name.length > 0 && name.length <= 50,
	};
	const metaService = { update: vi.fn(async () => ({ ...store.meta })) };
	const chart = { update: vi.fn() };
	const webhooks = { notifySystemWebhook: vi.fn() };
	let id = 0;
	const service = new SignupService(
		store.db,
		meta,
		{ isKeyWordIncluded: (username: string, words: string[]) => words.some(x => username.includes(x)) } as UtilityService,
		webhooks as unknown as UserService,
		entityService as unknown as UserEntityService,
		{ gen: () => `user-${++id}` } as IdService,
		metaService as unknown as MetaService,
		chart as unknown as UsersChart,
	);
	return { service, metaService, chart, webhooks };
}

describe('single-human signup boundary', () => {
	test('root creation persists root assignment with the human account', async () => {
		const store = database();
		const { service } = signupService(store);
		const result = await service.signup({ username: 'owner', password: 'password' });
		expect(result.account).toMatchObject({ host: null, isBot: false, name: null, token: result.secret });
		expect(store.profiles[0].password).toMatch(/^\$2/);
		expect(store.meta.rootUserId).toBe(result.account.id);
		expect(store.calls).toEqual(['signup:root', 'readMeta', 'signup:username:owner', 'writeMeta']);
	});

	test('different usernames racing with stale process caches create only one root human', async () => {
		const store = database();
		const first = signupService(store);
		const second = signupService(store);
		const results = await Promise.allSettled([
			first.service.signup({ username: 'owner_a', password: 'password' }),
			second.service.signup({ username: 'owner_b', password: 'password' }),
		]);
		expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
		expect(results.find(x => x.status === 'rejected')).toMatchObject({
			reason: expect.objectContaining({ message: 'REGISTRATION_CLOSED' }),
		});
		expect(store.users).toHaveLength(1);
		expect(store.meta.rootUserId).toBe(store.users[0].id);
	});

	test('account failure rolls back root assignment and all account records', async () => {
		const store = database();
		store.failProfile();
		const { service, metaService, chart } = signupService(store);
		await expect(service.signup({ username: 'owner', password: 'password' })).rejects.toThrow('PROFILE_FAILED');
		expect(store.meta.rootUserId).toBeNull();
		expect(store.users).toHaveLength(0);
		expect(metaService.update).not.toHaveBeenCalled();
		expect(chart.update).not.toHaveBeenCalled();
	});

	test('generic signup options cannot open a managed-character bypass', async () => {
		const store = database('root');
		const { service } = signupService(store, null);
		const opts = {
			username: 'another_human', password: 'password',
			isBot: true, managedCharacter: true, ignorePreservedUsernames: true, host: 'remote.test', passwordHash: null,
		};
		await expect(service.signup(opts)).rejects.toThrow('REGISTRATION_CLOSED');
		expect(store.users).toHaveLength(0);
	});

	test('a cached existing root rejects generic signup before provisioning', async () => {
		const store = database('root');
		const { service } = signupService(store);
		await expect(service.signup({ username: 'extra', password: 'password' })).rejects.toThrow('REGISTRATION_CLOSED');
		expect(store.transaction).not.toHaveBeenCalled();
	});

	test('root bootstrap cannot be made passwordless through legacy options', async () => {
		const store = database();
		const { service } = signupService(store);
		await expect(service.signup({ username: 'owner', passwordHash: 'hash' } as unknown as Parameters<SignupService['signup']>[0]))
			.rejects.toThrow('INVALID_PASSWORD');
		expect(store.transaction).not.toHaveBeenCalled();
	});

	test('managed signup requires completed root setup and never chooses a root', async () => {
		const store = database();
		const { service } = signupService(store);
		await expect(service.signupManagedCharacter({ username: 'character', name: 'Character' })).rejects.toThrow('SETUP_REQUIRED');
		expect(store.meta.rootUserId).toBeNull();
		expect(store.users).toHaveLength(0);
	});

	test('managed signup is local, named, a bot, passwordless and ignores extra credential/privilege options', async () => {
		const store = database('root');
		const { service, metaService } = signupService(store);
		const result = await service.signupManagedCharacter({
			username: 'character', name: 'Character',
			host: 'remote.test', password: 'secret', passwordHash: 'hash', isBot: false, rootUserId: 'other',
		} as Parameters<SignupService['signupManagedCharacter']>[0]);
		expect(result.account).toMatchObject({ username: 'character', name: 'Character', host: null, isBot: true, token: result.secret });
		expect(store.profiles[0].password).toBeNull();
		expect(store.meta.rootUserId).toBe('root');
		expect(metaService.update).not.toHaveBeenCalled();
		expect(store.calls).not.toContain('writeMeta');
	});

	test('managed signup validates names and local usernames', async () => {
		const { service } = signupService(database('root'));
		await expect(service.signupManagedCharacter({ username: 'character', name: '' })).rejects.toThrow('INVALID_NAME');
		await expect(service.signupManagedCharacter({ username: 'system.actor', name: 'Actor' })).rejects.toThrow('INVALID_USERNAME');
	});

	test('concurrent managed signups cannot create duplicate local usernames', async () => {
		const store = database('root');
		const first = signupService(store);
		const second = signupService(store);
		const results = await Promise.allSettled([
			first.service.signupManagedCharacter({ username: 'character', name: 'Character' }),
			second.service.signupManagedCharacter({ username: 'CHARACTER', name: 'Character' }),
		]);
		expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
		expect(results.find(x => x.status === 'rejected')).toMatchObject({
			reason: expect.objectContaining({ message: 'DUPLICATED_USERNAME' }),
		});
		expect(store.users).toHaveLength(1);
		expect(store.meta.rootUserId).toBe('root');
	});

	test('managed signup cannot reuse existing, deleted or reserved usernames', async () => {
		const store = database('root');
		const { service } = signupService(store);
		await service.signupManagedCharacter({ username: 'character', name: 'Character' });
		await expect(service.signupManagedCharacter({ username: 'CHARACTER', name: 'Character' })).rejects.toThrow('DUPLICATED_USERNAME');
		store.users.length = 0;
		await expect(service.signupManagedCharacter({ username: 'character', name: 'Character' })).rejects.toThrow('USED_USERNAME');
		store.meta.preservedUsernames = ['reserved'];
		await expect(service.signupManagedCharacter({ username: 'reserved', name: 'Reserved' })).rejects.toThrow('USED_USERNAME');
		store.meta.prohibitedWordsForNameOfUser = ['blocked'];
		await expect(service.signupManagedCharacter({ username: 'blocked_name', name: 'Blocked' })).rejects.toThrow('USED_USERNAME');
	});
});

describe('signup HTTP boundaries', () => {
	test('public signup, invitations and legacy email completions are always closed', async () => {
		const service = new SignupApiService();
		const reply = {} as FastifyReply;
		for (const body of [
			{ username: 'owner', password: 'password' },
			{ username: 'invitee', password: 'password', invitationCode: 'valid-invite' },
			{ username: 'email', password: 'password', emailAddress: 'person@example.test' },
			{ code: 'pending-email-code' },
		]) {
			const request = { body } as FastifyRequest;
			await expect(service.signup(request, reply)).rejects.toMatchObject({ statusCode: 403, message: 'REGISTRATION_CLOSED' });
			await expect(service.signupPending(request, reply)).rejects.toMatchObject({ statusCode: 403, message: 'REGISTRATION_CLOSED' });
		}
	});

	function endpoint(rootUserId: string | null, setupPassword?: string) {
		const signup = { signup: vi.fn(async () => ({ account: { id: 'root' }, secret: 'token' })) };
		const pack = { pack: vi.fn(async () => ({ id: 'root' })) };
		return {
			signup,
			endpoint: new CreateAccountEndpoint(
				{ setupPassword } as Config,
				{ rootUserId } as MiMeta,
				pack as unknown as UserEntityService,
				signup as unknown as SignupService,
			),
		};
	}

	test('initial setup preserves setup-password protection', async () => {
		const { endpoint: api, signup } = endpoint(null, 'setup-secret');
		await expect(api.exec({ username: 'owner', password: 'password', setupPassword: 'wrong' }, null, null))
			.rejects.toMatchObject({ code: 'INCORRECT_INITIAL_PASSWORD' });
		expect(signup.signup).not.toHaveBeenCalled();
		expect(await api.exec({ username: 'owner', password: 'password', setupPassword: 'setup-secret' }, null, null))
			.toMatchObject({ id: 'root', token: 'token' });
	});

	test('existing root cannot create another generic account', async () => {
		const { endpoint: api, signup } = endpoint('root');
		await expect(api.exec({ username: 'extra', password: 'password' }, { id: 'root' } as MiLocalUser, null))
			.rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		await expect(api.exec({ username: 'extra', password: 'password' }, null, null))
			.rejects.toMatchObject({ code: 'ACCESS_DENIED' });
		expect(signup.signup).not.toHaveBeenCalled();
	});

	test('a concurrent root winner is translated into the existing API access-denied error', async () => {
		const { endpoint: api, signup } = endpoint(null);
		signup.signup.mockRejectedValue(new Error('REGISTRATION_CLOSED'));
		await expect(api.exec({ username: 'loser', password: 'password' }, null, null))
			.rejects.toMatchObject({ code: 'ACCESS_DENIED' });
	});
});
