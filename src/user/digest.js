'use strict';

const async = require('async');
const winston = require('winston');
const nconf = require('nconf');

const db = require('../database');
const batch = require('../batch');
const meta = require('../meta');
const user = require('./index');
const topics = require('../topics');
const plugins = require('../plugins');
const emailer = require('../emailer');
const utils = require('../utils');

const Digest = module.exports;

Digest.execute = async function (payload) {
	const digestsDisabled = meta.config.disableEmailSubscriptions === 1;
	if (digestsDisabled) {
		winston.info('[user/jobs] Did not send digests (' + payload.interval + ') because subscription system is disabled.');
		return;
	}
	let subscribers = payload.subscribers;
	if (!subscribers) {
		subscribers = await Digest.getSubscribers(payload.interval);
	}
	if (!subscribers.length) {
		return;
	}
	try {
		await Digest.send({
			interval: payload.interval,
			subscribers: subscribers,
		});
		winston.info('[user/jobs] Digest (' + payload.interval + ') scheduling completed. Sending emails; this may take some time...');
	} catch (err) {
		winston.error('[user/jobs] Could not send digests (' + payload.interval + ')', err);
		throw err;
	}
};

Digest.getUsersInterval = async (uids) => {
	// Checks whether user specifies digest setting, or null/false for system default setting
	let single = false;
	if (!Array.isArray(uids) && !isNaN(parseInt(uids, 10))) {
		uids = [uids];
		single = true;
	}

	const settings = await Promise.all([
		db.isSortedSetMembers('digest:day:uids', uids),
		db.isSortedSetMembers('digest:week:uids', uids),
		db.isSortedSetMembers('digest:month:uids', uids),
	]);

	const interval = uids.map((uid, index) => {
		if (settings[0][index]) {
			return 'day';
		} else if (settings[1][index]) {
			return 'week';
		} else if (settings[2][index]) {
			return 'month';
		}
		return false;
	});

	return single ? interval[0] : interval;
};

Digest.getSubscribers = async function (interval) {
	var subscribers = [];

	await batch.processSortedSet('users:joindate', async function (uids) {
		const settings = await user.getMultipleUserSettings(uids);
		let subUids = [];
		settings.forEach(function (hash) {
			if (hash.dailyDigestFreq === interval) {
				subUids.push(hash.uid);
			}
		});
		subUids = await user.bans.filterBanned(subUids);
		subscribers = subscribers.concat(subUids);
	}, { interval: 1000 });

	const results = await plugins.fireHook('filter:digest.subscribers', {
		interval: interval,
		subscribers: subscribers,
	});
	return results.subscribers;
};

Digest.send = async function (data) {
	var emailsSent = 0;
	if (!data || !data.subscribers || !data.subscribers.length) {
		return emailsSent;
	}
	const now = new Date();

	const users = await user.getUsersFields(data.subscribers, ['uid', 'username', 'userslug', 'lastonline']);

	async.eachLimit(users, 100, async function (userObj) {
		let [notifications, topicsData] = await Promise.all([
			user.notifications.getUnreadInterval(userObj.uid, data.interval),
			getTermTopics(data.interval, userObj.uid, 0, 9),
		]);
		notifications = notifications.filter(Boolean);
		// If there are no notifications and no new topics, don't bother sending a digest
		if (!notifications.length && !topicsData.length) {
			return;
		}

		notifications.forEach(function (n) {
			if (n.image && !n.image.startsWith('http')) {
				n.image = nconf.get('base_url') + n.image;
			}
			if (n.path) {
				n.notification_url = n.path.startsWith('http') ? n.path : nconf.get('base_url') + n.path;
			}
		});

		// Fix relative paths in topic data
		topicsData = topicsData.map(function (topicObj) {
			const user = topicObj.hasOwnProperty('teaser') && topicObj.teaser !== undefined ? topicObj.teaser.user : topicObj.user;
			if (user && user.picture && utils.isRelativeUrl(user.picture)) {
				user.picture = nconf.get('base_url') + user.picture;
			}
			return topicObj;
		});
		emailsSent += 1;
		try {
			await emailer.send('digest', userObj.uid, {
				subject: '[[email:digest.subject, ' + (now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate()) + ']]',
				username: userObj.username,
				userslug: userObj.userslug,
				notifications: notifications,
				recent: topicsData,
				interval: data.interval,
				showUnsubscribe: true,
			});
		} catch (err) {
			winston.error('[user/jobs] Could not send digest email', err);
		}

		if (data.interval !== 'alltime') {
			await db.sortedSetAdd('digest:delivery', now.getTime(), userObj.uid);
		}
	}, function () {
		winston.info('[user/jobs] Digest (' + data.interval + ') sending completed. ' + emailsSent + ' emails sent.');
	});
};

Digest.getDeliveryTimes = async (start, stop) => {
	const count = await db.sortedSetCard('users:joindate');
	const uids = await user.getUidsFromSet('users:joindate', start, stop);
	if (!uids) {
		return [];
	}

	// Grab the last time a digest was successfully delivered to these uids
	const scores = await db.sortedSetScores('digest:delivery', uids);

	// Get users' digest settings
	const settings = await Digest.getUsersInterval(uids);

	// Populate user data
	let userData = await user.getUsersFields(uids, ['username', 'picture']);
	userData = userData.map((user, idx) => {
		user.lastDelivery = scores[idx] ? new Date(scores[idx]).toISOString() : '[[admin/manage/digest:null]]';
		user.setting = settings[idx];
		return user;
	});

	return {
		users: userData,
		count: count,
	};
};

async function getTermTopics(term, uid, start, stop) {
	const options = {
		uid: uid,
		start: start,
		stop: stop,
		term: term,
		sort: 'posts',
		teaserPost: 'last-post',
	};
	let data = await topics.getSortedTopics(options);
	if (!data.topics.length) {
		data = await topics.getLatestTopics(options);
	}
	data.topics.forEach(function (topicObj) {
		if (topicObj && topicObj.teaser && topicObj.teaser.content && topicObj.teaser.content.length > 255) {
			topicObj.teaser.content = topicObj.teaser.content.slice(0, 255) + '...';
		}
	});
	return data.topics.filter(topic => topic && !topic.deleted);
}
