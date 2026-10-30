/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { applyLocalOnlyPolicy, LOCAL_ONLY_META } from '@/core/LocalOnlyPolicy.js';
import { MetaService } from '@/core/MetaService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { DeliverProcessorService } from '@/queue/processors/DeliverProcessorService.js';
import { InboxProcessorService } from '@/queue/processors/InboxProcessorService.js';
import type { FeaturedService } from '@/core/FeaturedService.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { MiMeta } from '@/models/Meta.js';
import type { Config } from '@/config.js';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import type { FactoryProvider } from '@nestjs/common';

vi.mock('@/config.js', async importOriginal => ({
	...await importOriginal<typeof import('@/config.js')>(),
	loadConfig: () => ({ host: 'local.test' }),
}));

function createService(initial?: Partial<MiMeta>) {
	let stored = initial ? { id: 'x', hiddenTags: [], ...initial } as MiMeta : undefined;
	const manager = {
		find: vi.fn(async () => stored ? [{ ...stored }] : []),
		update: vi.fn(async (_entity: unknown, _id: string, data: Partial<MiMeta>) => {
			stored = { ...stored, ...data } as MiMeta;
		}),
		upsert: vi.fn(async (_entity: unknown, data: Partial<MiMeta>) => {
			stored = { ...data } as MiMeta;
			return { identifiers: [{ id: 'x' }] };
		}),
		findOneByOrFail: vi.fn(async () => ({ ...stored })),
		save: vi.fn(async (_entity: unknown, data: Partial<MiMeta>) => {
			stored = { ...data } as MiMeta;
		}),
	};
	const db = { transaction: vi.fn(async (callback: (entityManager: typeof manager) => Promise<unknown>) => callback(manager)) };
	const redis = new EventEmitter();
	const events = { publishInternalEvent: vi.fn() };
	const service = new MetaService(
		redis as unknown as Redis,
		db as unknown as DataSource,
		{} as FeaturedService,
		events as unknown as GlobalEventService,
	);
	return { service, manager, db, redis, events, stored: () => stored };
}

describe('fixed local-only meta policy', () => {
	test('overrides federation and registration without changing local features', () => {
		const meta = {
			federation: 'all',
			disableRegistration: false,
			emailRequiredForSignup: true,
			enableFanoutTimeline: true,
			rootUserId: 'root',
			name: 'Local server',
		} as MiMeta;
		expect(applyLocalOnlyPolicy(meta)).toBe(meta);
		expect(meta).toMatchObject({
			...LOCAL_ONLY_META,
			enableFanoutTimeline: true,
			rootUserId: 'root',
			name: 'Local server',
		});
		expect(Object.isFrozen(LOCAL_ONLY_META)).toBe(true);
	});

	test('existing federation guard rejects remote hosts while preserving self resolution', () => {
		const meta = applyLocalOnlyPolicy({ federation: 'all' } as MiMeta);
		const utility = new UtilityService({ host: 'local.test' } as Config, meta);
		expect(utility.isFederationAllowedHost('remote.test')).toBe(false);
		expect(utility.isFederationAllowedUri('https://remote.test/inbox')).toBe(false);
		expect(utility.isFederationAllowedHost('local.test')).toBe(true);
	});

	test('startup singleton persists the policy and ignores reenablement over redis', async () => {
		const { service, db, redis, stored } = createService({ federation: 'all', disableRegistration: false });
		const providers = Reflect.getMetadata('providers', GlobalModule) as FactoryProvider[];
		const provider = providers.find(x => x.provide === DI.meta)!;
		const meta = await provider.useFactory(db, redis) as MiMeta;
		expect(meta).toMatchObject(LOCAL_ONLY_META);
		expect(stored()).toMatchObject(LOCAL_ONLY_META);
		redis.emit('message', 'server', JSON.stringify({
			channel: 'internal',
			message: {
				type: 'metaUpdated',
				body: { after: { federation: 'all', disableRegistration: false, emailRequiredForSignup: true, name: 'Updated' } },
			},
		}));
		expect(meta).toMatchObject({ ...LOCAL_ONLY_META, name: 'Updated', rootUser: null });
		service.dispose();
	});

	test('startup singleton creates local-only meta on an empty database', async () => {
		const { service, db, redis, stored } = createService();
		const providers = Reflect.getMetadata('providers', GlobalModule) as FactoryProvider[];
		const provider = providers.find(x => x.provide === DI.meta)!;
		expect(await provider.useFactory(db, redis)).toMatchObject(LOCAL_ONLY_META);
		expect(stored()).toMatchObject(LOCAL_ONLY_META);
		service.dispose();
	});

	test('already queued remote inbox and deliver jobs stop at the existing guard', async () => {
		const utility = new UtilityService({ host: 'local.test' } as Config, applyLocalOnlyPolicy({} as MiMeta));
		const signedPost = vi.fn();
		const performActivity = vi.fn();
		const deliver = Object.assign(Object.create(DeliverProcessorService.prototype), {
			utilityService: utility,
			apRequestService: { signedPost },
		}) as DeliverProcessorService;
		const inbox = Object.assign(Object.create(InboxProcessorService.prototype), {
			utilityService: utility,
			apInboxService: { performActivity },
			logger: { debug: vi.fn() },
		}) as InboxProcessorService;
		await expect(deliver.process({
			data: { to: 'https://remote.test/inbox' },
		} as Parameters<DeliverProcessorService['process']>[0])).resolves.toBe('skip (blocked)');
		await expect(inbox.process({
			data: { signature: { keyId: 'https://remote.test/actor#key' }, activity: {} },
		} as Parameters<InboxProcessorService['process']>[0])).resolves.toBe('Blocked request: remote.test');
		expect(signedPost).not.toHaveBeenCalled();
		expect(performActivity).not.toHaveBeenCalled();
	});

	test('database refresh and cached fetch cannot reenable federation', async () => {
		const { service, manager, db, stored } = createService({ federation: 'all', disableRegistration: false });
		expect(await service.fetch(true)).toMatchObject(LOCAL_ONLY_META);
		expect(stored()).toMatchObject(LOCAL_ONLY_META);
		expect(manager.update).toHaveBeenCalledWith(expect.anything(), 'x', LOCAL_ONLY_META);
		db.transaction.mockClear();
		expect(await service.fetch()).toMatchObject(LOCAL_ONLY_META);
		expect(db.transaction).not.toHaveBeenCalled();
		service.dispose();
	});

	test('initial meta creation persists the fixed policy', async () => {
		const { service, stored } = createService();
		expect(await service.fetch()).toMatchObject(LOCAL_ONLY_META);
		expect(stored()).toMatchObject(LOCAL_ONLY_META);
		service.dispose();
	});

	test('admin updates are normalized before persistence, caching and publication', async () => {
		const { service, stored, events } = createService({ federation: 'none' });
		const data: Partial<MiMeta> = { federation: 'all', disableRegistration: false, emailRequiredForSignup: true, name: 'Updated' };
		const after = await service.update(data);
		expect(data.federation).toBe('all');
		expect(after).toMatchObject({ ...LOCAL_ONLY_META, name: 'Updated' });
		expect(stored()).toMatchObject(LOCAL_ONLY_META);
		expect(await service.fetch()).toBe(after);
		expect(events.publishInternalEvent).toHaveBeenCalledWith('metaUpdated', {
			before: expect.anything(),
			after: expect.objectContaining(LOCAL_ONLY_META),
		});
		service.dispose();
	});

	test('updates also normalize the no-meta creation path', async () => {
		const { service, stored } = createService();
		expect(await service.update({ federation: 'all' })).toMatchObject(LOCAL_ONLY_META);
		expect(stored()).toMatchObject(LOCAL_ONLY_META);
		service.dispose();
	});

	test('redis refresh cannot reenable federation or registration', async () => {
		const { service, redis, db } = createService();
		redis.emit('message', 'server', JSON.stringify({
			channel: 'internal',
			message: {
				type: 'metaUpdated',
				body: { after: { id: 'x', federation: 'all', disableRegistration: false, emailRequiredForSignup: true } },
			},
		}));
		expect(await service.fetch()).toMatchObject(LOCAL_ONLY_META);
		expect(db.transaction).not.toHaveBeenCalled();
		service.dispose();
	});
});
