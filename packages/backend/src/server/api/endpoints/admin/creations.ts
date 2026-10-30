/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '@/server/api/error.js';
import { CreationsService } from '@/core/CreationsService.js';
import { CreationsError } from '@/core/creations/catalog.js';

const requiredString = { type: 'string', optional: false, nullable: false } as const;
const requiredNumber = { type: 'number', optional: false, nullable: false } as const;
const requiredBoolean = { type: 'boolean', optional: false, nullable: false } as const;
const botFunctions = { type: 'array', optional: false, nullable: false, items: { ...requiredString, enum: ['aphr', 'tarot'] } } as const;
export const meta = {
	tags: ['admin'],
	requireCredential: true,
	requireAdmin: true,
	secure: true,
	limit: { duration: 60000, max: 60 },
	errors: {
		invalidOperation: {
			message: 'Character runtime operation could not be completed. See info.reason.',
			code: 'CREATIONS_OPERATION_FAILED',
			id: 'cbf9f440-e81c-44da-a795-06f3c171ab08',
		},
	},
	res: {
		type: 'object', optional: false, nullable: false,
		properties: {
			running: requiredBoolean,
			catalogPath: requiredString,
			provider: { ...requiredString, enum: ['openai', 'gemini'] },
			model: requiredString,
			inputJpyPerMillion: requiredNumber,
			outputJpyPerMillion: requiredNumber,
			providerKeyConfigured: requiredBoolean,
			termsConfirmed: requiredBoolean,
			lastError: { type: 'string', optional: false, nullable: true },
			month: requiredString,
			spentJpy: requiredNumber,
			monthlyLimitJpy: requiredNumber,
			catalog: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						key: requiredString,
						work: requiredString,
						db: requiredString,
						name: requiredString,
						permission: { ...requiredString, enum: ['allowed', 'denied', 'unknown'] },
						reason: requiredString,
						userId: { type: 'string', optional: false, nullable: true },
						username: { type: 'string', optional: false, nullable: true },
						enabled: requiredBoolean,
						spontaneous: requiredBoolean,
						functions: botFunctions,
					},
				},
			},
			botStatus: {
				type: 'array', optional: false, nullable: false,
				items: {
					type: 'object', optional: false, nullable: false,
					properties: {
						id: { ...requiredString, enum: ['aphr', 'tarot'] },
						enabled: requiredBoolean,
						model: requiredString,
						budgetJpy: requiredNumber,
						estimatePerCallJpy: requiredNumber,
						spentJpy: requiredNumber,
						keyConfigured: requiredBoolean,
						installed: requiredBoolean,
						termsConfirmed: requiredBoolean,
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		action: { type: 'string', enum: ['status', 'configure', 'catalog', 'character', 'bot', 'start', 'stop'] },
		provider: { type: 'string', enum: ['openai', 'gemini'] },
		model: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9._/-]+$' },
		inputJpyPerMillion: { type: 'number', minimum: 0.000001, maximum: 10000000 },
		outputJpyPerMillion: { type: 'number', minimum: 0.000001, maximum: 10000000 },
		catalogPath: { type: 'string', minLength: 1, maxLength: 4096 },
		characterKey: { type: 'string', maxLength: 4096 },
		enabled: { type: 'boolean' },
		spontaneous: { type: 'boolean' },
		functions: { type: 'array', uniqueItems: true, maxItems: 2, items: { type: 'string', enum: ['aphr', 'tarot'] } },
		bot: { type: 'string', enum: ['aphr', 'tarot'] },
		budgetJpy: { type: 'number', minimum: 0.000001, maximum: 1000000 },
		estimatePerCallJpy: { type: 'number', minimum: 0.000001, maximum: 1000000 },
		termsConfirmed: { type: 'boolean' },
		resetModel: { type: 'boolean' },
	},
	required: ['action'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(private creationsService: CreationsService) {
		super(meta, paramDef, async (ps, me) => {
			try {
				return await this.creationsService.manage(ps, me.id);
			} catch (error) {
				if (error instanceof CreationsError) throw new ApiError(meta.errors.invalidOperation, { reason: error.code });
				throw error;
			}
		});
	}
}
