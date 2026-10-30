/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { localUsernameSchema } from '@/models/User.js';
import { canonicalIdentity, managedUsername, parseCatalog, parseDecision, projectReference } from './catalog.js';

const identity = { work_key: '#Works_Test', db_key: '#DB_Cards', index: { 'Card.Suit': 'cups', No: 1 } };
const reference = { source: 'record_fields', fields: { FormalName_JP: 'Test', Character_JP: 'An original synthetic test persona.' } };
const character = {
	_type: 'character', record_identity: identity, display_name: 'Test',
	text_rp_inference: { status: 'allowed', allowed: true, reason: 'explicit' }, text_rp_reference: reference,
};

describe('text-only character catalog', () => {
	test('preserves every composite identity component and canonicalizes key order', () => {
		expect(canonicalIdentity(identity)).toBe(canonicalIdentity({ ...identity, index: { No: 1, 'Card.Suit': 'cups' } }));
		expect(canonicalIdentity(identity)).not.toBe(canonicalIdentity({ ...identity, index: { No: 1, 'Card.Suit': 'swords' } }));
		expect(() => canonicalIdentity({ ...identity, index: {} })).toThrow('INVALID_RECORD_INDEX');
	});

	test('managed deterministic usernames satisfy the real signup schema', () => {
		const key = canonicalIdentity(identity);
		expect(new RegExp(localUsernameSchema.pattern).test(managedUsername(key))).toBe(true);
		expect(managedUsername(key)).toBe(managedUsername(key));
		expect(managedUsername(key)).not.toBe(managedUsername(canonicalIdentity({ ...identity, index: { No: 2 } })));
	});

	test('reads the real manifest discriminator and ignores training/type/header rows', () => {
		const result = parseCatalog([
			{ _type: 'dataset_header' }, { _type: 'dictionary', text: 'not RP' }, character,
		].map(value => JSON.stringify(value)).join('\n'));
		expect(result).toHaveLength(1);
		expect(result[0].permission).toBe('allowed');
	});

	test.each([
		{ status: 'allowed', allowed: 'true' },
		{ status: 'unknown', allowed: false },
		{ status: 'denied', allowed: false },
		null,
	])('fails closed without inferring permission from training opt-out: %j', permission => {
		const [result] = parseCatalog(JSON.stringify({ characters: [{ ...character, text_rp_inference: permission, AI_Optout: false }] }));
		expect(result.permission).not.toBe('allowed');
		expect(result.reference).toBeNull();
	});

	test('requires body text, not just a name; strips images, design, wrappers and AI hints', () => {
		expect(projectReference({ source: 'record_fields', fields: { FormalName_JP: 'Name' } })).toBeNull();
		const result = projectReference({
			source: 'record_fields',
			fields: {
				Character_JP: ['kind', ' '], Image: 'secret-image', AIHints: 'design',
				Hobby_JP: { hideText: true, value: 'must not expand' },
				ConversationPattern: { TalkingTone_JP: 'gentle', DialogueExamples: { image: 'hidden' } },
			},
		});
		expect(result).toBe('{"Character_JP":"kind","ConversationPattern.TalkingTone_JP":"gentle"}');
	});

	test('never accepts a duplicate identity or an unapproved function', () => {
		expect(() => parseCatalog(JSON.stringify({ characters: [character, character] }))).toThrow('DUPLICATE_RECORD_IDENTITY');
		expect(() => parseDecision('{"route":"tarot","text":""}', ['aphr'])).toThrow('INVALID_ROUTING_RESPONSE');
		expect(() => parseDecision('{"route":"execute","text":"code"}', [])).toThrow('INVALID_ROUTING_RESPONSE');
		expect(parseDecision('{"route":"clarify","text":"Which function?"}', ['tarot']).route).toBe('clarify');
	});
});
