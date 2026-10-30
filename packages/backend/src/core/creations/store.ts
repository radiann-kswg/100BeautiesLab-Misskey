/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomInt, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CreationsError, object } from './catalog.js';
import type { BotFunction, Provider } from './catalog.js';

export type Settings = {
	running: boolean;
	catalogPath: string;
	provider: Provider;
	model: string;
	inputJpyPerMillion: number;
	outputJpyPerMillion: number;
	bots: Record<BotFunction, { enabled: boolean; model: string; budgetJpy: number; estimatePerCallJpy: number }>;
};
export const defaultSettings: Settings = {
	running: false,
	catalogPath: '',
	provider: 'openai',
	model: 'gpt-4.1-mini',
	inputJpyPerMillion: 0,
	outputJpyPerMillion: 0,
	bots: {
		aphr: { enabled: false, model: '', budgetJpy: 0, estimatePerCallJpy: 0 },
		tarot: { enabled: false, model: '', budgetJpy: 0, estimatePerCallJpy: 0 },
	},
};
export type Selection = {
	key: string;
	userId: string;
	username: string;
	enabled: boolean;
	spontaneous: boolean;
	functions: BotFunction[];
	nextPostAt: number;
};

export function dayKey(now = new Date()): string {
	return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

export class CreationsStore {
	public readonly db: DatabaseSync;
	private readonly owner = randomUUID();

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA busy_timeout = 5000;
			CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS characters (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, detail TEXT);
			CREATE TABLE IF NOT EXISTS costs (id TEXT PRIMARY KEY, pool TEXT NOT NULL, month TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, day TEXT NOT NULL, character TEXT NOT NULL, followed INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS lease (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
		`);
	}

	public read(key: string): string | null {
		const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
		return row && typeof row.value === 'string' ? row.value : null;
	}

	public write(key: string, value: string): void {
		this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
	}

	public settings(): Settings {
		const raw = this.read('config');
		if (!raw) return structuredClone(defaultSettings);
		const config: unknown = JSON.parse(raw);
		if (!object(config) || typeof config.running !== 'boolean' || typeof config.catalogPath !== 'string' ||
			(config.provider !== 'openai' && config.provider !== 'gemini') || typeof config.model !== 'string' ||
			typeof config.inputJpyPerMillion !== 'number' || typeof config.outputJpyPerMillion !== 'number' || !object(config.bots)) {
			throw new CreationsError('INVALID_PERSISTED_CONFIGURATION');
		}
		const bots = config.bots;
		const parseBot = (key: BotFunction) => {
			const value = bots[key];
			if (!object(value) || typeof value.enabled !== 'boolean' || typeof value.model !== 'string' ||
				typeof value.budgetJpy !== 'number' || typeof value.estimatePerCallJpy !== 'number') {
				throw new CreationsError('INVALID_PERSISTED_BOT_CONFIGURATION');
			}
			return { enabled: value.enabled, model: value.model, budgetJpy: value.budgetJpy, estimatePerCallJpy: value.estimatePerCallJpy };
		};
		return {
			running: config.running, catalogPath: config.catalogPath, provider: config.provider, model: config.model,
			inputJpyPerMillion: config.inputJpyPerMillion, outputJpyPerMillion: config.outputJpyPerMillion,
			bots: { aphr: parseBot('aphr'), tarot: parseBot('tarot') },
		};
	}

	public saveSettings(settings: Settings, expected: string | null): void {
		const result = expected === null ?
			this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run('config', JSON.stringify(settings)) :
			this.db.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?').run(JSON.stringify(settings), 'config', expected);
		if (!result.changes) throw new CreationsError('CONFIGURATION_CHANGED_RETRY');
	}

	public start(settings: Settings, expected: string | null, stopVersion: string | null, cursor: string): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			if (this.read('stopVersion') !== stopVersion) throw new CreationsError('START_CANCELLED_BY_STOP');
			this.saveSettings(settings, expected);
			this.write('cursor', cursor);
			for (const selection of this.selections()) this.schedule(selection.key, Date.now() + randomInt(15, 46) * 60000);
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	public stop(bot?: BotFunction): void {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const settings = this.settings();
			if (bot) {
				settings.bots[bot].enabled = false;
			} else {
				settings.running = false;
				this.write('stopVersion', randomUUID());
			}
			this.write('config', JSON.stringify(settings));
			this.db.exec('COMMIT');
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	public pause(): void {
		this.db.prepare('UPDATE settings SET value = json_set(value, ?, json(?)) WHERE key = ?')
			.run('$.running', 'false', 'config');
	}

	public selections(): Selection[] {
		return this.db.prepare('SELECT value FROM characters').all().map(row => {
			if (typeof row.value !== 'string') throw new CreationsError('INVALID_CHARACTER_STATE');
			const value: unknown = JSON.parse(row.value);
			if (!object(value) || typeof value.key !== 'string' || typeof value.userId !== 'string' ||
				typeof value.username !== 'string' || typeof value.enabled !== 'boolean' || typeof value.spontaneous !== 'boolean' ||
				typeof value.nextPostAt !== 'number' || !Array.isArray(value.functions) ||
				!value.functions.every(v => v === 'aphr' || v === 'tarot')) throw new CreationsError('INVALID_CHARACTER_STATE');
			return {
				key: value.key, userId: value.userId, username: value.username,
				enabled: value.enabled, spontaneous: value.spontaneous, nextPostAt: value.nextPostAt,
				functions: value.functions,
			};
		});
	}

	public saveSelection(selection: Selection): void {
		this.db.prepare('INSERT INTO characters VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
			.run(selection.key, JSON.stringify(selection));
	}

	public schedule(key: string, nextPostAt: number): void {
		this.db.prepare('UPDATE characters SET value = json_set(value, ?, ?) WHERE key = ?').run('$.nextPostAt', nextPostAt, key);
	}

	public lease(now = Date.now()): boolean {
		return this.db.prepare(`INSERT INTO lease VALUES ('runtime', ?, ?)
			ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires=excluded.expires
			WHERE lease.expires < ? OR lease.owner = ?`).run(this.owner, now + 300000, now, this.owner).changes > 0;
	}

	public release(): void {
		this.db.prepare('DELETE FROM lease WHERE owner = ?').run(this.owner);
	}

	public claim(id: string): boolean {
		return this.db.prepare('INSERT INTO jobs(id, status) VALUES (?, ?) ON CONFLICT(id) DO NOTHING').run(id, 'claimed').changes > 0;
	}

	public finish(id: string, status: string, detail: string): void {
		this.db.prepare('UPDATE jobs SET status = ?, detail = ? WHERE id = ?').run(status, detail, id);
	}

	public spent(pool: string, month = dayKey().slice(0, 7)): number {
		const row = this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM costs WHERE pool = ? AND month = ?').get(pool, month);
		return Number(row?.total);
	}

	public reserve(pool: string, amount: number, limit: number): string {
		if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(limit) || limit <= 0) {
			throw new CreationsError('COST_UNKNOWN');
		}
		const id = randomUUID();
		this.db.exec('BEGIN IMMEDIATE');
		try {
			if (this.spent(pool) + amount > limit) throw new CreationsError(pool === 'conversation' ? 'MONTHLY_BUDGET_REACHED' : 'BOT_BUDGET_REACHED');
			this.db.prepare('INSERT INTO costs VALUES (?, ?, ?, ?, ?)').run(id, pool, dayKey().slice(0, 7), amount, 'reserved');
			this.db.exec('COMMIT');
			return id;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	public settle(id: string, amount: number): void {
		if (!Number.isFinite(amount) || amount <= 0) throw new CreationsError('COST_UNKNOWN');
		this.db.prepare('UPDATE costs SET amount = ?, status = ? WHERE id = ?').run(amount, 'settled', id);
	}

	public countPosts(key: string, followed: boolean, day = dayKey()): number {
		const row = followed ?
			this.db.prepare('SELECT COUNT(*) AS count FROM posts WHERE day = ? AND character = ?').get(day, key) :
			this.db.prepare('SELECT COUNT(*) AS count FROM posts WHERE day = ? AND followed = 0').get(day);
		return Number(row?.count);
	}

	public recordPost(id: string, key: string, followed: boolean): void {
		this.db.prepare('INSERT INTO posts VALUES (?, ?, ?, ?)').run(id, dayKey(), key, followed ? 1 : 0);
	}

	public reservePost(id: string, key: string, followed: boolean, limit: number): boolean {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			if (this.countPosts(key, followed) >= limit) {
				this.db.exec('COMMIT');
				return false;
			}
			this.recordPost(id, key, followed);
			this.db.exec('COMMIT');
			return true;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	public close(): void {
		this.release();
		this.db.close();
	}
}
