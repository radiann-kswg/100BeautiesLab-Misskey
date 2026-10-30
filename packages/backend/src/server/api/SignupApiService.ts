/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { FastifyReplyError } from '@/misc/fastify-reply-error.js';
import { bindThis } from '@/decorators.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

@Injectable()
export class SignupApiService {
	@bindThis
	public async signup(_request: FastifyRequest, _reply: FastifyReply): Promise<never> {
		throw new FastifyReplyError(403, 'REGISTRATION_CLOSED');
	}

	@bindThis
	public async signupPending(_request: FastifyRequest, _reply: FastifyReply): Promise<never> {
		throw new FastifyReplyError(403, 'REGISTRATION_CLOSED');
	}
}
