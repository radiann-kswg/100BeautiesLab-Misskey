/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { bindThis } from '@/decorators.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';

@Injectable({ scope: Scope.TRANSIENT })
export class HybridTimelineChannel extends Channel {
	public readonly chName = 'hybridTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,
	) {
		super(request);
	}

	@bindThis
	public async init(_params: JsonObject): Promise<boolean> {
		// Hybrid streaming is permanently unavailable in this local-only fork.
		return false;
	}

	@bindThis
	public dispose(): void {
		return;
	}
}
