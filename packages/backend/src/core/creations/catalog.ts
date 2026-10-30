/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';

export const botFunctions = ['aphr', 'tarot'] as const;
export type BotFunction = typeof botFunctions[number];
export type Provider = 'openai' | 'gemini';
export type Message = { role: 'user' | 'assistant'; content: string };
export type CatalogCharacter = {
	key: string;
	work: string;
	db: string;
	name: string;
	permission: 'allowed' | 'denied' | 'unknown';
	reason: string;
	reference: string | null;
};

const textFields = [
	'FormalName_JP', 'FormalName_JPReading', 'FormalName_EN',
	'FirstPersonCalling', 'SecondPersonCalling', 'ThirdPersonCalling',
	'Character_JP', 'Character_EN', 'Hobby_JP', 'Hobby_EN',
	'Favor_JP', 'Favor_EN', 'Unlike_JP', 'Unlike_EN',
] as const;
const conversationFields = [
	'TalkingTone_JP', 'TalkingTone_EN', 'TopicPreference_JP', 'TopicPreference_EN',
	'TalkFrequency_JP', 'TalkFrequency_EN', 'PreferredTopics_JP', 'PreferredTopics_EN',
	'AvoidedTopics_JP', 'AvoidedTopics_EN', 'ConversationNotes_JP', 'ConversationNotes_EN',
] as const;

export class CreationsError extends Error {
	constructor(public readonly code: string) {
		super(code);
	}
}

export function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalIdentity(value: unknown): string {
	if (!object(value) || typeof value.work_key !== 'string' || !value.work_key.startsWith('#Works_') ||
		typeof value.db_key !== 'string' || !value.db_key.startsWith('#DB_') || !object(value.index)) {
		throw new CreationsError('INVALID_RECORD_IDENTITY');
	}
	const index = Object.entries(value.index).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	if (index.length === 0 || index.some(([key, v]) =>
		key.length === 0 || !(v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))))) {
		throw new CreationsError('INVALID_RECORD_INDEX');
	}
	return JSON.stringify([value.work_key, value.db_key, index]);
}

export function managedUsername(key: string): string {
	return `c_${createHash('sha256').update(key).digest('hex').slice(0, 18)}`;
}

function text(value: unknown): string | null {
	if (typeof value === 'string') return value.trim() || null;
	if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
		return value.map(v => v.trim()).filter(Boolean).join('\n') || null;
	}
	return null;
}

export function projectReference(value: unknown): string | null {
	if (!object(value) || value.source !== 'record_fields' || !object(value.fields)) return null;
	const fields: Record<string, string> = {};
	for (const key of textFields) {
		const content = text(value.fields[key]);
		if (content) fields[key] = content;
	}
	if (object(value.fields.ConversationPattern)) {
		for (const key of conversationFields) {
			const content = text(value.fields.ConversationPattern[key]);
			if (content) fields[`ConversationPattern.${key}`] = content;
		}
	}
	if (!Object.keys(fields).some(key => !key.startsWith('FormalName_'))) return null;
	const result = JSON.stringify(fields);
	if (result.length > 24000) throw new CreationsError('REFERENCE_TOO_LARGE');
	return result;
}

export function parseCatalog(content: string): CatalogCharacter[] {
	let entries: unknown;
	try {
		const parsed: unknown = JSON.parse(content);
		entries = object(parsed) ? parsed.characters : null;
	} catch {
		try {
			entries = content.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as unknown)
				.filter(entry => object(entry) && entry._type === 'character');
		} catch {
			throw new CreationsError('INVALID_CATALOG_JSON');
		}
	}
	if (!Array.isArray(entries)) throw new CreationsError('EXPECTED_CHARACTER_CATALOG_OR_MANIFEST');
	const characters: CatalogCharacter[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!object(entry) || entry.record_identity == null) continue;
		const key = canonicalIdentity(entry.record_identity);
		if (seen.has(key)) throw new CreationsError('DUPLICATE_RECORD_IDENTITY');
		seen.add(key);
		const identity = entry.record_identity;
		if (!object(identity)) throw new CreationsError('INVALID_RECORD_IDENTITY');
		const permission = object(entry.text_rp_inference) ? entry.text_rp_inference : {};
		const status = permission.status === 'allowed' && permission.allowed === true ? 'allowed' :
			permission.status === 'denied' && permission.allowed === false ? 'denied' : 'unknown';
		const reference = status === 'allowed' ? projectReference(entry.text_rp_reference) : null;
		characters.push({
			key,
			work: String(identity.work_key),
			db: String(identity.db_key),
			name: typeof entry.display_name === 'string' ? entry.display_name : key,
			permission: status === 'allowed' && !reference ? 'unknown' : status,
			reason: status === 'allowed' && !reference ? 'MISSING_TEXT_RP_REFERENCE' :
				typeof permission.reason === 'string' ? permission.reason : 'PERMISSION_NOT_CONFIRMED',
			reference,
		});
	}
	return characters;
}

export function parseDecision(value: string, allowed: readonly BotFunction[]): { route: 'chat' | 'clarify' | BotFunction; text: string } {
	let decision: unknown;
	try {
		decision = JSON.parse(value);
	} catch {
		throw new CreationsError('INVALID_ROUTING_RESPONSE');
	}
	if (!object(decision) || typeof decision.route !== 'string' || typeof decision.text !== 'string' ||
		!(['chat', 'clarify', ...allowed] as string[]).includes(decision.route) ||
		(['chat', 'clarify'].includes(decision.route) && !decision.text.trim())) {
		throw new CreationsError('INVALID_ROUTING_RESPONSE');
	}
	if (decision.route === 'chat' || decision.route === 'clarify') {
		return { route: decision.route, text: decision.text };
	}
	if (decision.route === 'aphr' || decision.route === 'tarot') {
		return { route: decision.route, text: '' };
	}
	throw new CreationsError('FUNCTION_NOT_ALLOWED');
}
