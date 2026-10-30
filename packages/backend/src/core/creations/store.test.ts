/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { CreationsStore, dayKey } from './store.js';

describe('persistent runtime accounting', () => {
	test('reserves before a request, rejects unknown prices and stops at 3000 yen', () => {
		const store = new CreationsStore(':memory:');
		try {
			expect(() => store.reserve('conversation', 0, 3000)).toThrow('COST_UNKNOWN');
			store.reserve('conversation', 2999, 3000);
			const reservation = store.reserve('conversation', 1, 3000);
			expect(() => store.reserve('conversation', 0.01, 3000)).toThrow('MONTHLY_BUDGET_REACHED');
			store.settle(reservation, 0.5);
			expect(store.spent('conversation')).toBe(2999.5);
			store.reserve('tarot', 10, 100);
			expect(store.spent('conversation')).toBe(2999.5);
			expect(store.spent('tarot')).toBe(10);
		} finally {
			store.close();
		}
	});

	test('claims an input only once and keeps shared spontaneous quotas across functions', () => {
		const store = new CreationsStore(':memory:');
		try {
			expect(store.claim('mention:one')).toBe(true);
			expect(store.claim('mention:one')).toBe(false);
			for (let i = 0; i < 12; i++) store.recordPost(`unfollowed:${i}`, `character:${i}`, false);
			expect(store.countPosts('another-character', false)).toBe(12);
			for (let i = 0; i < 6; i++) store.recordPost(`followed:${i}`, 'same-character', true);
			expect(store.countPosts('same-character', true)).toBe(6);
			expect(store.countPosts('another-character', false)).toBe(12);
			expect(store.countPosts('same-character', true, '1999-01-01')).toBe(0);
		} finally {
			store.close();
		}
	});

	test('uses a stable Japanese calendar day for daily limits', () => {
		expect(dayKey(new Date('2026-10-30T14:59:59Z'))).toBe('2026-10-30');
		expect(dayKey(new Date('2026-10-30T15:00:00Z'))).toBe('2026-10-31');
	});

	test('daily slots and scheduling updates preserve independent character settings', () => {
		const store = new CreationsStore(':memory:');
		try {
			store.saveSelection({ key: 'one', userId: 'bot', username: 'char_one', enabled: false, spontaneous: true, functions: ['tarot'], nextPostAt: 0 });
			store.schedule('one', 12345);
			expect(store.selections()[0]).toMatchObject({ enabled: false, functions: ['tarot'], nextPostAt: 12345 });
			for (let i = 0; i < 6; i++) expect(store.reservePost(`followed-slot:${i}`, 'one', true, 6)).toBe(true);
			expect(store.reservePost('over-limit', 'one', true, 6)).toBe(false);
			expect(store.countPosts('one', true)).toBe(6);
		} finally {
			store.close();
		}
	});
});
