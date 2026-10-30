/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import HybridTimelineEndpoint from '@/server/api/endpoints/notes/hybrid-timeline.js';
import GlobalTimelineEndpoint from '@/server/api/endpoints/notes/global-timeline.js';
import { HybridTimelineChannel } from '@/server/api/stream/channels/hybrid-timeline.js';
import { GlobalTimelineChannel } from '@/server/api/stream/channels/global-timeline.js';
import type { MiLocalUser } from '@/models/User.js';
import type { ChannelRequest } from '@/server/api/stream/channel.js';

describe('local-only timeline boundary', () => {
	test('hybrid REST is disabled even for root and regardless of requested options', async () => {
		const endpoint = new HybridTimelineEndpoint();
		for (const params of [{}, { withFiles: true }, { withReplies: true }, { withFiles: true, withReplies: true }]) {
			await expect(endpoint.exec(params, { id: 'root' } as MiLocalUser, null))
				.rejects.toMatchObject({ code: 'STL_DISABLED' });
		}
	});

	test('global REST is disabled for visitors and signed-in users', async () => {
		const endpoint = new GlobalTimelineEndpoint();
		for (const user of [null, { id: 'root' } as MiLocalUser]) {
			await expect(endpoint.exec({}, user, null)).rejects.toMatchObject({ code: 'GTL_DISABLED' });
		}
	});

	test.each([HybridTimelineChannel, GlobalTimelineChannel])('%s never subscribes to notes or emits them', async (ChannelClass) => {
		const subscriber = new EventEmitter();
		const on = vi.spyOn(subscriber, 'on');
		const sendMessageToWs = vi.fn();
		const request = {
			id: 'timeline',
			connection: { user: { id: 'root' }, subscriber, sendMessageToWs },
		} as unknown as ChannelRequest;
		const channel = new ChannelClass(request);
		expect(await channel.init({ withReplies: true, withRenotes: true })).toBe(false);
		subscriber.emit('notesStream', { id: 'note', visibility: 'public' });
		expect(on).not.toHaveBeenCalled();
		expect(subscriber.listenerCount('notesStream')).toBe(0);
		expect(sendMessageToWs).not.toHaveBeenCalled();
		channel.dispose();
	});
});
