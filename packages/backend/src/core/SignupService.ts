/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { generateKeyPair } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { DataSource, IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { MiMeta } from '@/models/Meta.js';
import { MiUser } from '@/models/User.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { IdService } from '@/core/IdService.js';
import { MiUserKeypair } from '@/models/UserKeypair.js';
import { MiUsedUsername } from '@/models/UsedUsername.js';
import { generateNativeUserToken } from '@/misc/token.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import UsersChart from '@/core/chart/charts/users.js';
import { UtilityService } from '@/core/UtilityService.js';
import { UserService } from '@/core/UserService.js';
import { MetaService } from '@/core/MetaService.js';
import { LOCAL_ONLY_META } from '@/core/LocalOnlyPolicy.js';

@Injectable()
export class SignupService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.meta)
		private meta: MiMeta,

		private utilityService: UtilityService,
		private userService: UserService,
		private userEntityService: UserEntityService,
		private idService: IdService,
		private metaService: MetaService,
		private usersChart: UsersChart,
	) {
	}

	@bindThis
	public async signup(opts: {
		username: MiUser['username'];
		password: string;
	}) {
		if (this.meta.rootUserId != null) throw new Error('REGISTRATION_CLOSED');

		if (typeof opts.password !== 'string' || !this.userEntityService.validatePassword(opts.password)) {
			throw new Error('INVALID_PASSWORD');
		}

		const salt = await bcrypt.genSalt(8);
		const passwordHash = await bcrypt.hash(opts.password, salt);

		return this.createAccount({
			username: opts.username,
			name: null,
			passwordHash,
		}, 'root');
	}

	/**
	 * Internal provisioning primitive. The management service must validate the
	 * canonical catalog selection and permission before calling this method.
	 * No public signup options are forwarded to this path.
	 */
	@bindThis
	public async signupManagedCharacter(opts: { username: string; name: string }) {
		if (!this.userEntityService.validateName(opts.name)) throw new Error('INVALID_NAME');

		return this.createAccount({
			username: opts.username,
			name: opts.name,
			passwordHash: null,
		}, 'managed-character');
	}

	private async createAccount(opts: {
		username: string;
		name: string | null;
		passwordHash: string | null;
	}, kind: 'root' | 'managed-character') {
		const { username, name, passwordHash } = opts;
		if (!this.userEntityService.validateLocalUsername(username)) {
			throw new Error('INVALID_USERNAME');
		}

		const secret = generateNativeUserToken();
		const keyPair = await new Promise<string[]>((res, rej) =>
			generateKeyPair('rsa', {
				modulusLength: 2048,
				publicKeyEncoding: {
					type: 'spki',
					format: 'pem',
				},
				privateKeyEncoding: {
					type: 'pkcs8',
					format: 'pem',
					cipher: undefined,
					passphrase: undefined,
				},
			}, (err, publicKey, privateKey) =>
				err ? rej(err) : res([publicKey, privateKey]),
			));

		let account!: MiUser;

		// Start transaction
		await this.db.transaction(async transactionalEntityManager => {
			// Serialize setup across processes, not just requests for the same
			// username. Root assignment and account creation must commit together.
			await transactionalEntityManager.query(
				'SELECT pg_advisory_xact_lock(hashtext($1))',
				['signup:root'],
			);
			let serverSettings = (await transactionalEntityManager.find(MiMeta, {
				order: { id: 'DESC' },
			}))[0];
			if (!serverSettings) {
				await transactionalEntityManager.upsert(MiMeta, { id: 'x', ...LOCAL_ONLY_META }, ['id']);
				serverSettings = await transactionalEntityManager.findOneByOrFail(MiMeta, { id: 'x' });
			}
			if (kind === 'root' && serverSettings.rootUserId != null) throw new Error('REGISTRATION_CLOSED');
			if (kind === 'managed-character' && serverSettings.rootUserId == null) throw new Error('SETUP_REQUIRED');

			// ローカルユーザーのユーザー名は host が NULL のため、(usernameLower, host) の
			// 複合ユニークインデックスでは重複を防げない（NULLは互いにdistinct扱い）。
			// 同一ユーザー名の並行サインアップをトランザクション単位のadvisory lockで直列化し、
			// チェック→挿入のTOCTOU競合を排除する。
			await transactionalEntityManager.query(
				'SELECT pg_advisory_xact_lock(hashtext($1))',
				[`signup:username:${username.toLowerCase()}`],
			);

			const exist = await transactionalEntityManager.findOneBy(MiUser, {
				usernameLower: username.toLowerCase(),
				host: IsNull(),
			});

			if (exist) throw new Error('DUPLICATED_USERNAME');

			if (await transactionalEntityManager.findOneBy(MiUsedUsername, { username: username.toLowerCase() })) {
				throw new Error('USED_USERNAME');
			}

			if (kind === 'managed-character') {
				const isPreserved = serverSettings.preservedUsernames.some(x => x.toLowerCase() === username.toLowerCase());
				const hasProhibitedWords = this.utilityService.isKeyWordIncluded(username.toLowerCase(), serverSettings.prohibitedWordsForNameOfUser);
				if (isPreserved || hasProhibitedWords) throw new Error('USED_USERNAME');
			}

			account = await transactionalEntityManager.save(new MiUser({
				id: this.idService.gen(),
				username: username,
				usernameLower: username.toLowerCase(),
				host: null,
				name,
				isBot: kind === 'managed-character',
				token: secret,
			}));

			await transactionalEntityManager.save(new MiUserKeypair({
				publicKey: keyPair[0],
				privateKey: keyPair[1],
				userId: account.id,
			}));

			await transactionalEntityManager.save(new MiUserProfile({
				userId: account.id,
				autoAcceptFollowed: true,
				password: passwordHash,
			}));

			await transactionalEntityManager.save(new MiUsedUsername({
				createdAt: new Date(),
				username: username.toLowerCase(),
			}));

			if (kind === 'root') {
				await transactionalEntityManager.update(MiMeta, serverSettings.id, { rootUserId: account.id, ...LOCAL_ONLY_META });
			}
		});

		if (kind === 'root') {
			this.meta.rootUserId = account.id;
			await this.metaService.update({});
		}

		this.usersChart.update(account, true);
		this.userService.notifySystemWebhook(account, 'userCreated');

		return { account, secret };
	}
}
