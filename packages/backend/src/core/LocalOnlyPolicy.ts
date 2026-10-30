/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiMeta } from '@/models/Meta.js';

/**
 * This fork has no federation or registration mode to enable, including via
 * persisted settings or another process's metaUpdated event.
 */
export const LOCAL_ONLY_META = Object.freeze({
	federation: 'none',
	disableRegistration: true,
	emailRequiredForSignup: false,
} satisfies Partial<MiMeta>);

export function applyLocalOnlyPolicy<T extends Partial<MiMeta>>(meta: T): T {
	return Object.assign(meta, LOCAL_ONLY_META);
}
