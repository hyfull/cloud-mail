import BizError from '../error/biz-error';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import userService from './user-service';
import emailService from './email-service';
import orm from '../entity/orm';
import account from '../entity/account';
import { and, asc, eq, gt, inArray, count, sql, ne, or, lt, desc } from 'drizzle-orm';
import {accountConst, isDel, settingConst} from '../const/entity-const';
import settingService from './setting-service';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import { t } from '../i18n/i18n';
import verifyRecordService from './verify-record-service';
import {
	ensureEmailRoute,
	ensureEmailRoutes,
	removeEmailRoute,
	removeEmailRoutes,
	rollbackEmailRouteChanges,
} from './email-routing-service';

async function rollbackRouting(c, changes, operation) {
	try {
		await rollbackEmailRouteChanges(c, changes);
	} catch (error) {
		console.error('Cloudflare email routing rollback failed', { operation, error: error.message });
	}
}

const accountService = {

	async add(c, params, userId) {

		const { addEmailVerify , addEmail, manyEmail, addVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c);

		let { email, token } = params;


		if (!(addEmail === settingConst.addEmail.OPEN && manyEmail === settingConst.manyEmail.OPEN)) {
			throw new BizError(t('addAccountDisabled'));
		}


		if (!email) {
			throw new BizError(t('emptyEmail'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notExistDomain'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content))) {
			throw new BizError(t('banEmailPrefix'));
		}

		let accountRow = await this.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelAccount'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		if (email.includes('+')) {
			const baseEmail = emailUtils.getBaseEmail(email);
			const baseAccount = await this.selectByEmailIncludeDel(c, baseEmail);
			if (!baseAccount || baseAccount.userId !== userId) {
				throw new BizError(t('notOwner'));
			}
		}

		const userRow = await userService.selectById(c, userId);
		const roleRow = await roleService.selectById(c, userRow.type);

		if (userRow.email !== c.env.admin) {

			if (roleRow.accountCount > 0) {
				const userAccountCount = await accountService.countUserAccount(c, userId)
				if(userAccountCount >= roleRow.accountCount) throw new BizError(t('accountLimit'), 403);
			}

			if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {
				throw new BizError(t('noDomainPermAdd'),403)
			}

		}

		let addVerifyOpen = false

		if (addEmailVerify === settingConst.addEmailVerify.OPEN) {
			addVerifyOpen = true
			await turnstileService.verify(c, token);
		}

		if (addEmailVerify === settingConst.addEmailVerify.COUNT) {
			addVerifyOpen = await verifyRecordService.isOpenAddVerify(c, addVerifyCount);
			if (addVerifyOpen) {
				await turnstileService.verify(c,token)
			}
		}


		accountRow = await this.insert(c, { email: email, userId: userId, name: emailUtils.getName(email) });

		if (addEmailVerify === settingConst.addEmailVerify.COUNT && !addVerifyOpen) {
			const row = await verifyRecordService.increaseAddCount(c);
			addVerifyOpen = row.count >= addVerifyCount
		}

		accountRow.addVerifyOpen = addVerifyOpen
		return accountRow;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(account).where(sql`${account.email} COLLATE NOCASE = ${email}`).get();
	},

	list(c, params, userId) {

		let { accountId, size, lastSort, keyword = '' } = params;

		accountId = Number(accountId);
		size = Math.min(30, Math.max(1, Math.floor(Number(size) || 30)));
		lastSort = lastSort == null || lastSort === '' ? NaN : Number(lastSort);

		if (!accountId) {
			accountId = 0;
		}

		if(!Number.isFinite(lastSort)) {
			lastSort = 9999999999;
		}

		keyword = keyword.trim();
		// Escape LIKE wildcards so mailbox addresses and names are searched literally.
		const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
		const matchesKeyword = keyword ? or(
			sql`${account.email} COLLATE NOCASE LIKE ${pattern} ESCAPE '\\'`,
			sql`${account.name} COLLATE NOCASE LIKE ${pattern} ESCAPE '\\'`
		) : undefined;

		return orm(c).select().from(account).where(
			and(
				eq(account.userId, userId),
				eq(account.isDel, isDel.NORMAL),
				matchesKeyword,
				or(
					lt(account.sort, lastSort),
					and(
						eq(account.sort, lastSort),
						gt(account.accountId, accountId)
					)
				)
			))
			.orderBy(desc(account.sort), asc(account.accountId))
			.limit(size)
			.all();
	},

	async delete(c, params, userId) {

		let { accountId } = params;

		const user = await userService.selectById(c, userId);
		const accountRow = await this.selectById(c, accountId);

		if (accountRow.email === user.email) {
			throw new BizError(t('delMyAccount'));
		}

		if (accountRow.userId !== user.userId) {
			throw new BizError(t('noUserAccount'));
		}

		const { syncDelete } = await settingService.query(c);
		if (syncDelete === settingConst.syncDelete.OPEN) {
			await this.physicsDelete(c, { accountId });
			return;
		}

		await orm(c).update(account).set({ isDel: isDel.DELETE }).where(
			and(eq(account.userId, userId),
				eq(account.accountId, accountId)))
			.run();
	},

	selectById(c, accountId) {
		return orm(c).select().from(account).where(
			and(eq(account.accountId, accountId),
				eq(account.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		const accountRow = await orm(c).insert(account).values({ ...params }).returning().get();
		try {
			await ensureEmailRoute(c, accountRow.email);
		} catch (error) {
			try {
				await orm(c).delete(account).where(eq(account.accountId, accountRow.accountId)).run();
			} catch (cleanupError) {
				console.error('Mailbox rollback failed', { accountId: accountRow.accountId, error: cleanupError.message });
			}
			throw error;
		}
		return accountRow;
	},

	async insertList(c, list) {
		const accountRows = await orm(c).insert(account).values(list).returning().all();
		const changes = [];
		try {
			await ensureEmailRoutes(c, accountRows.map(row => row.email), changes);
		} catch (error) {
			try {
				await orm(c).delete(account).where(inArray(account.accountId, accountRows.map(row => row.accountId))).run();
			} catch (cleanupError) {
				console.error('Mailbox list rollback failed', { count: accountRows.length, error: cleanupError.message });
			}
			await rollbackRouting(c, changes, 'insert-list');
			throw error;
		}
		return accountRows;
	},

	async physicsDeleteByUserIds(c, userIds) {
		const accountRows = await orm(c).select({ email: account.email }).from(account)
			.where(inArray(account.userId, userIds)).all();
		const changes = [];
		try {
			await removeEmailRoutes(c, accountRows.map(row => row.email), changes);
			await emailService.physicsDeleteUserIds(c, userIds);
			await orm(c).delete(account).where(inArray(account.userId,userIds)).run();
		} catch (error) {
			await rollbackRouting(c, changes, 'delete-users');
			throw error;
		}
	},

	async selectUserAccountCountList(c, userIds, del = isDel.NORMAL) {
		const result = await orm(c)
			.select({
				userId: account.userId,
				count: count(account.accountId)
			})
			.from(account)
			.where(and(
				inArray(account.userId, userIds),
				eq(account.isDel, del)
			))
			.groupBy(account.userId)
		return result;
	},

	async countUserAccount(c, userId) {
		const { num } = await orm(c).select({num: count()}).from(account).where(and(eq(account.userId, userId),eq(account.isDel, isDel.NORMAL))).get();
		return num;
	},

	async restoreByEmail(c, email) {
		const changes = [];
		try {
			await ensureEmailRoute(c, email, changes);
			await orm(c).update(account).set({isDel: isDel.NORMAL}).where(eq(account.email, email)).run();
		} catch (error) {
			await rollbackRouting(c, changes, 'restore-email');
			throw error;
		}
	},

	async restoreByUserId(c, userId) {
		const accountRows = await orm(c).select({ email: account.email }).from(account)
			.where(eq(account.userId, userId)).all();
		const changes = [];
		try {
			await ensureEmailRoutes(c, accountRows.map(row => row.email), changes);
			await orm(c).update(account).set({isDel: isDel.NORMAL}).where(eq(account.userId, userId)).run();
		} catch (error) {
			await rollbackRouting(c, changes, 'restore-user');
			throw error;
		}
	},

	async setName(c, params, userId) {
		const { name, accountId } = params
		if (name.length > 30) {
			throw new BizError(t('usernameLengthLimit'));
		}
		await orm(c).update(account).set({name}).where(and(eq(account.userId, userId),eq(account.accountId, accountId))).run();
	},

	async allAccount(c, params) {

		let { userId, num, size } = params

		userId = Number(userId)

		num = Number(num)
		size = Number(size)

		if (size > 30) {
			size = 30;
		}

		num = (num - 1) * size;

		const userRow = await userService.selectByIdIncludeDel(c, userId);

		const list = await orm(c).select().from(account).where(and(eq(account.userId, userId),ne(account.email,userRow.email))).limit(size).offset(num);
		const { total } = await orm(c).select({ total: count() }).from(account).where(eq(account.userId, userId)).get();

		return { list, total }
	},

	async physicsDelete(c, params) {
		const { accountId } = params
		const accountRow = await orm(c).select({ email: account.email }).from(account)
			.where(eq(account.accountId, accountId)).get();
		const changes = [];
		try {
			if (accountRow) await removeEmailRoute(c, accountRow.email, changes);
			await emailService.physicsDeleteByAccountId(c, accountId)
			await orm(c).delete(account).where(eq(account.accountId, accountId)).run();
		} catch (error) {
			await rollbackRouting(c, changes, 'delete-account');
			throw error;
		}
	},

	async setAllReceive(c, params, userId) {
		let a = null
		const { accountId } = params;
		const accountRow = await this.selectById(c, accountId);
		if (accountRow.userId !== userId) {
			return;
		}
		await orm(c).update(account).set({ allReceive: accountConst.allReceive.CLOSE }).where(eq(account.userId, userId)).run();
		await orm(c).update(account).set({ allReceive: accountRow.allReceive ? 0 : 1 }).where(eq(account.accountId, accountId)).run();
	},

	async setAsTop(c, params, userId) {
		const { accountId } = params;
		const userRow = await userService.selectById(c, userId);
		const mainAccountRow = await accountService.selectByEmailIncludeDel(c, userRow.email);
		let mainSort = mainAccountRow.sort === 0 ? 2 : mainAccountRow.sort + 1;
		await orm(c).update(account).set({ sort: mainSort }).where(eq(account.email, userRow.email )).run();
		await orm(c).update(account).set({ sort: mainSort - 1 }).where(and(eq(account.accountId, accountId),eq(account.userId,userId))).run();
	}
};

export default accountService;
