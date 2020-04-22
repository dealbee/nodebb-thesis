'use strict';

const _ = require('lodash');
const winston = require('winston');
const validator = require('validator');

const db = require('./database');
const user = require('./user');
const groups = require('./groups');
const meta = require('./meta');
const notifications = require('./notifications');
const analytics = require('./analytics');
const categories = require('./categories');
const topics = require('./topics');
const posts = require('./posts');
const privileges = require('./privileges');
const plugins = require('./plugins');
const utils = require('../public/src/utils');

const Flags = module.exports;

Flags._constants = {
	states: ['open', 'wip', 'resolved', 'rejected'],
	state_class: {
		open: 'info',
		wip: 'warning',
		resolved: 'success',
		rejected: 'danger',
	},
};

Flags.init = async function () {
	// Query plugins for custom filter strategies and merge into core filter strategies
	function prepareSets(sets, orSets, prefix, value) {
		if (!Array.isArray(value)) {
			sets.push(prefix + value);
		} else if (value.length) {
			value.forEach(x => orSets.push(prefix + x));
		}
	}

	const hookData = {
		filters: {
			type: function (sets, orSets, key) {
				prepareSets(sets, orSets, 'flags:byType:', key);
			},
			state: function (sets, orSets, key) {
				prepareSets(sets, orSets, 'flags:byState:', key);
			},
			reporterId: function (sets, orSets, key) {
				prepareSets(sets, orSets, 'flags:byReporter:', key);
			},
			assignee: function (sets, orSets, key) {
				prepareSets(sets, orSets, 'flags:byAssignee:', key);
			},
			targetUid: function (sets, orSets, key) {
				prepareSets(sets, orSets, 'flags:byTargetUid:', key);
			},
			cid: function (sets, orSets, key) {
				prepareSets(sets, orSets, 'flags:byCid:', key);
			},
			page: function () {	/* noop */ },
			perPage: function () {	/* noop */ },
			quick: function (sets, orSets, key, uid) {
				switch (key) {
				case 'mine':
					sets.push('flags:byAssignee:' + uid);
					break;
				}
			},
		},
		helpers: {
			prepareSets: prepareSets,
		},
	};

	try {
		const data = await plugins.fireHook('filter:flags.getFilters', hookData);
		Flags._filters = data.filters;
	} catch (err) {
		winston.error('[flags/init] Could not retrieve filters', err);
		Flags._filters = {};
	}
};

Flags.get = async function (flagId) {
	const [base, history, notes] = await Promise.all([
		db.getObject('flag:' + flagId),
		Flags.getHistory(flagId),
		Flags.getNotes(flagId),
	]);
	if (!base) {
		return;
	}

	const [userObj, targetObj] = await Promise.all([
		user.getUserFields(base.uid, ['username', 'userslug', 'picture', 'reputation']),
		Flags.getTarget(base.type, base.targetId, 0),
	]);

	const flagObj = {
		state: 'open',
		...base,
		description: validator.escape(base.description),
		datetimeISO: utils.toISOString(base.datetime),
		target_readable: base.type.charAt(0).toUpperCase() + base.type.slice(1) + ' ' + base.targetId,
		target: targetObj,
		history: history,
		notes: notes,
		reporter: userObj,
	};
	const data = await plugins.fireHook('filter:flags.get', {
		flag: flagObj,
	});
	return data.flag;
};

Flags.list = async function (filters, uid) {
	filters = filters || {};

	let sets = [];
	const orSets = [];

	// Default filter
	filters.page = filters.hasOwnProperty('page') ? Math.abs(parseInt(filters.page, 10) || 1) : 1;
	filters.perPage = filters.hasOwnProperty('perPage') ? Math.abs(parseInt(filters.perPage, 10) || 20) : 20;

	for (var type in filters) {
		if (filters.hasOwnProperty(type)) {
			if (Flags._filters.hasOwnProperty(type)) {
				Flags._filters[type](sets, orSets, filters[type], uid);
			} else {
				winston.warn('[flags/list] No flag filter type found: ' + type);
			}
		}
	}
	sets = (sets.length || orSets.length) ? sets : ['flags:datetime'];	// No filter default

	let flagIds = [];
	if (sets.length === 1) {
		flagIds = await db.getSortedSetRevRange(sets[0], 0, -1);
	} else if (sets.length > 1) {
		flagIds = await db.getSortedSetRevIntersect({ sets: sets, start: 0, stop: -1, aggregate: 'MAX' });
	}

	if (orSets.length) {
		const _flagIds = await db.getSortedSetRevUnion({ sets: orSets, start: 0, stop: -1, aggregate: 'MAX' });
		if (sets.length) {
			// If flag ids are already present, return a subset of flags that are in both sets
			flagIds = _.intersection(flagIds, _flagIds);
		} else {
			// Otherwise, return all flags returned via orSets
			flagIds = _.union(flagIds, _flagIds);
		}
	}

	// Create subset for parsing based on page number (n=20)
	const flagsPerPage = Math.abs(parseInt(filters.perPage, 10) || 1);
	const pageCount = Math.ceil(flagIds.length / flagsPerPage);
	flagIds = flagIds.slice((filters.page - 1) * flagsPerPage, filters.page * flagsPerPage);

	const flags = await Promise.all(flagIds.map(async (flagId) => {
		let flagObj = await db.getObject('flag:' + flagId);
		const userObj = await user.getUserFields(flagObj.uid, ['username', 'picture']);
		flagObj = {
			state: 'open',
			...flagObj,
			reporter: {
				username: userObj.username,
				picture: userObj.picture,
				'icon:bgColor': userObj['icon:bgColor'],
				'icon:text': userObj['icon:text'],
			},
		};
		flagObj.labelClass = Flags._constants.state_class[flagObj.state];

		return Object.assign(flagObj, {
			description: validator.escape(String(flagObj.description)),
			target_readable: flagObj.type.charAt(0).toUpperCase() + flagObj.type.slice(1) + ' ' + flagObj.targetId,
			datetimeISO: utils.toISOString(flagObj.datetime),
		});
	}));

	const data = await plugins.fireHook('filter:flags.list', {
		flags: flags,
		page: filters.page,
	});

	return {
		flags: data.flags,
		page: data.page,
		pageCount: pageCount,
	};
};

Flags.validate = async function (payload) {
	const [target, reporter] = await Promise.all([
		Flags.getTarget(payload.type, payload.id, payload.uid),
		user.getUserData(payload.uid),
	]);

	if (!target) {
		throw new Error('[[error:invalid-data]]');
	} else if (target.deleted) {
		throw new Error('[[error:post-deleted]]');
	} else if (!reporter || !reporter.userslug) {
		throw new Error('[[error:no-user]]');
	} else if (reporter.banned) {
		throw new Error('[[error:user-banned]]');
	}

	if (payload.type === 'post') {
		const editable = await privileges.posts.canEdit(payload.id, payload.uid);
		if (!editable.flag && !meta.config['reputation:disabled'] && reporter.reputation < meta.config['min:rep:flag']) {
			throw new Error('[[error:not-enough-reputation-to-flag]]');
		}
	} else if (payload.type === 'user') {
		const editable = await privileges.users.canEdit(payload.uid, payload.id);
		if (!editable && !meta.config['reputation:disabled'] && reporter.reputation < meta.config['min:rep:flag']) {
			throw new Error('[[error:not-enough-reputation-to-flag]]');
		}
	} else {
		throw new Error('[[error:invalid-data]]');
	}
};

Flags.getNotes = async function (flagId) {
	let notes = await db.getSortedSetRevRangeWithScores('flag:' + flagId + ':notes', 0, -1);
	const uids = [];
	notes = notes.map(function (note) {
		const noteObj = JSON.parse(note.value);
		uids.push(noteObj[0]);
		return {
			uid: noteObj[0],
			content: noteObj[1],
			datetime: note.score,
			datetimeISO: utils.toISOString(note.score),
		};
	});
	const userData = await user.getUsersFields(uids, ['username', 'userslug', 'picture']);
	return notes.map(function (note, idx) {
		note.user = userData[idx];
		note.content = validator.escape(note.content);
		return note;
	});
};

Flags.create = async function (type, id, uid, reason, timestamp) {
	let doHistoryAppend = false;
	if (!timestamp) {
		timestamp = Date.now();
		doHistoryAppend = true;
	}
	const [flagExists, targetExists, canFlag, targetUid, targetCid] = await Promise.all([
		// Sanity checks
		Flags.exists(type, id, uid),
		Flags.targetExists(type, id),
		Flags.canFlag(type, id, uid),
		// Extra data for zset insertion
		Flags.getTargetUid(type, id),
		Flags.getTargetCid(type, id),
	]);
	if (flagExists) {
		throw new Error('[[error:already-flagged]]');
	} else if (!targetExists) {
		throw new Error('[[error:invalid-data]]');
	} else if (!canFlag) {
		throw new Error('[[error:no-privileges]]');
	}
	const flagId = await db.incrObjectField('global', 'nextFlagId');

	await db.setObject('flag:' + flagId, {
		flagId: flagId,
		type: type,
		targetId: id,
		description: reason,
		uid: uid,
		datetime: timestamp,
	});
	await db.sortedSetAdd('flags:datetime', timestamp, flagId); // by time, the default
	await db.sortedSetAdd('flags:byReporter:' + uid, timestamp, flagId); // by reporter
	await db.sortedSetAdd('flags:byType:' + type, timestamp, flagId);	// by flag type
	await db.sortedSetAdd('flags:hash', flagId, [type, id, uid].join(':')); // save zset for duplicate checking
	await analytics.increment('flags'); // some fancy analytics

	if (targetUid) {
		await db.sortedSetAdd('flags:byTargetUid:' + targetUid, timestamp, flagId); // by target uid
	}

	if (targetCid) {
		await db.sortedSetAdd('flags:byCid:' + targetCid, timestamp, flagId); // by target cid
	}

	if (type === 'post') {
		await db.sortedSetAdd('flags:byPid:' + id, timestamp, flagId);	// by target pid
		if (targetUid) {
			await db.sortedSetIncrBy('users:flags', 1, targetUid);
			await user.incrementUserFieldBy(targetUid, 'flags', 1);
		}
	}

	if (doHistoryAppend) {
		await Flags.update(flagId, uid, { state: 'open' });
	}

	return await Flags.get(flagId);
};

Flags.exists = async function (type, id, uid) {
	return await db.isSortedSetMember('flags:hash', [type, id, uid].join(':'));
};

Flags.canFlag = async function (type, id, uid) {
	if (type === 'user') {
		return true;
	}
	if (type === 'post') {
		return await privileges.posts.can('topics:read', id, uid);
	}
	throw new Error('[[error:invalid-data]]');
};

Flags.getTarget = async function (type, id, uid) {
	if (type === 'user') {
		const userData = await user.getUserData(id);
		return userData && userData.uid ? userData : {};
	}
	if (type === 'post') {
		let postData = await posts.getPostData(id);
		if (!postData) {
			return {};
		}
		postData = await posts.parsePost(postData);
		postData = await topics.addPostData([postData], uid);
		return postData[0];
	}
	throw new Error('[[error:invalid-data]]');
};

Flags.targetExists = async function (type, id) {
	if (type === 'post') {
		return await posts.exists(id);
	} else if (type === 'user') {
		return await user.exists(id);
	}
	throw new Error('[[error:invalid-data]]');
};

Flags.getTargetUid = async function (type, id) {
	if (type === 'post') {
		return await posts.getPostField(id, 'uid');
	}
	return id;
};

Flags.getTargetCid = async function (type, id) {
	if (type === 'post') {
		return await posts.getCidByPid(id);
	}
	return null;
};

Flags.update = async function (flagId, uid, changeset) {
	const current = await db.getObjectFields('flag:' + flagId, ['state', 'assignee', 'type', 'targetId']);
	const now = changeset.datetime || Date.now();
	const notifyAssignee = async function (assigneeId) {
		if (assigneeId === '' || parseInt(uid, 10) === parseInt(assigneeId, 10)) {
			return;
		}
		const notifObj = await notifications.create({
			type: 'my-flags',
			bodyShort: '[[notifications:flag_assigned_to_you, ' + flagId + ']]',
			bodyLong: '',
			path: '/flags/' + flagId,
			nid: 'flags:assign:' + flagId + ':uid:' + assigneeId,
			from: uid,
		});
		await notifications.push(notifObj, [assigneeId]);
	};
	const isAssignable = async function (assigneeId) {
		let allowed = false;
		allowed = await user.isAdminOrGlobalMod(assigneeId);

		// Mods are also allowed to be assigned, if flag target is post in uid's moderated cid
		if (!allowed && current.type === 'post') {
			const cid = await posts.getCidByPid(current.targetId);
			allowed = await user.isModerator(assigneeId, cid);
		}

		return allowed;
	};

	// Retrieve existing flag data to compare for history-saving/reference purposes
	const tasks = [];
	for (var prop in changeset) {
		if (changeset.hasOwnProperty(prop)) {
			if (current[prop] === changeset[prop]) {
				delete changeset[prop];
			} else if (prop === 'state') {
				if (!Flags._constants.states.includes(changeset[prop])) {
					delete changeset[prop];
				} else {
					tasks.push(db.sortedSetAdd('flags:byState:' + changeset[prop], now, flagId));
					tasks.push(db.sortedSetRemove('flags:byState:' + current[prop], flagId));
				}
			} else if (prop === 'assignee') {
				/* eslint-disable-next-line */
				if (!await isAssignable(parseInt(changeset[prop], 10))) {
					delete changeset[prop];
				} else {
					tasks.push(db.sortedSetAdd('flags:byAssignee:' + changeset[prop], now, flagId));
					tasks.push(notifyAssignee(changeset[prop]));
				}
			}
		}
	}

	if (!Object.keys(changeset).length) {
		return;
	}

	tasks.push(db.setObject('flag:' + flagId, changeset));
	tasks.push(Flags.appendHistory(flagId, uid, changeset));
	tasks.push(plugins.fireHook('action:flags.update', { flagId: flagId, changeset: changeset, uid: uid }));
	await Promise.all(tasks);
};

Flags.getHistory = async function (flagId) {
	const uids = [];
	let history = await db.getSortedSetRevRangeWithScores('flag:' + flagId + ':history', 0, -1);

	history = history.map(function (entry) {
		entry.value = JSON.parse(entry.value);

		uids.push(entry.value[0]);

		// Deserialise changeset
		const changeset = entry.value[1];
		if (changeset.hasOwnProperty('state')) {
			changeset.state = changeset.state === undefined ? '' : '[[flags:state-' + changeset.state + ']]';
		}

		return {
			uid: entry.value[0],
			fields: changeset,
			datetime: entry.score,
			datetimeISO: utils.toISOString(entry.score),
		};
	});
	const userData = await user.getUsersFields(uids, ['username', 'userslug', 'picture']);
	history.forEach((event, idx) => { event.user = userData[idx]; });
	return history;
};

Flags.appendHistory = async function (flagId, uid, changeset) {
	const datetime = changeset.datetime || Date.now();
	delete changeset.datetime;
	const payload = JSON.stringify([uid, changeset, datetime]);
	await db.sortedSetAdd('flag:' + flagId + ':history', datetime, payload);
};

Flags.appendNote = async function (flagId, uid, note, datetime) {
	datetime = datetime || Date.now();
	const payload = JSON.stringify([uid, note]);
	await db.sortedSetAdd('flag:' + flagId + ':notes', datetime, payload);
	await Flags.appendHistory(flagId, uid, {
		notes: null,
		datetime: datetime,
	});
};

Flags.notify = async function (flagObj, uid) {
	const [admins, globalMods] = await Promise.all([
		groups.getMembers('administrators', 0, -1),
		groups.getMembers('Global Moderators', 0, -1),
	]);
	let uids = admins.concat(globalMods);
	let notifObj = null;
	if (flagObj.type === 'post') {
		const [title, cid] = await Promise.all([
			topics.getTitleByPid(flagObj.targetId),
			posts.getCidByPid(flagObj.targetId),
		]);

		const modUids = await categories.getModeratorUids([cid]);
		const titleEscaped = utils.decodeHTMLEntities(title).replace(/%/g, '&#37;').replace(/,/g, '&#44;');

		notifObj = await notifications.create({
			type: 'new-post-flag',
			bodyShort: '[[notifications:user_flagged_post_in, ' + flagObj.reporter.username + ', ' + titleEscaped + ']]',
			bodyLong: flagObj.description,
			pid: flagObj.targetId,
			path: '/flags/' + flagObj.flagId,
			nid: 'flag:post:' + flagObj.targetId + ':uid:' + uid,
			from: uid,
			mergeId: 'notifications:user_flagged_post_in|' + flagObj.targetId,
			topicTitle: title,
		});
		uids = uids.concat(modUids[0]);
	} else if (flagObj.type === 'user') {
		notifObj = await notifications.create({
			type: 'new-user-flag',
			bodyShort: '[[notifications:user_flagged_user, ' + flagObj.reporter.username + ', ' + flagObj.target.username + ']]',
			bodyLong: flagObj.description,
			path: '/flags/' + flagObj.flagId,
			nid: 'flag:user:' + flagObj.targetId + ':uid:' + uid,
			from: uid,
			mergeId: 'notifications:user_flagged_user|' + flagObj.targetId,
		});
	} else {
		throw new Error('[[error:invalid-data]]');
	}

	plugins.fireHook('action:flags.create', {
		flag: flagObj,
	});
	uids = uids.filter(_uid => parseInt(_uid, 10) !== parseInt(uid, 10));
	await notifications.push(notifObj, uids);
};

require('./promisify')(Flags);
