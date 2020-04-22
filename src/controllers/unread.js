
'use strict';

const nconf = require('nconf');
const querystring = require('querystring');

const meta = require('../meta');
const pagination = require('../pagination');
const user = require('../user');
const categories = require('../categories');
const topics = require('../topics');
const plugins = require('../plugins');
const helpers = require('./helpers');

const unreadController = module.exports;

unreadController.get = async function (req, res, next) {
	const cid = req.query.cid;
	const filter = req.query.filter || '';

	const filterData = await plugins.fireHook('filter:unread.getValidFilters', { filters: { ...helpers.validFilters } });
	if (!filterData.filters[filter]) {
		return next();
	}
	const [watchedCategories, userSettings] = await Promise.all([
		getWatchedCategories(req.uid, cid, filter),
		user.getSettings(req.uid),
	]);

	const page = parseInt(req.query.page, 10) || 1;
	const start = Math.max(0, (page - 1) * userSettings.topicsPerPage);
	const stop = start + userSettings.topicsPerPage - 1;
	const data = await topics.getUnreadTopics({
		cid: cid,
		uid: req.uid,
		start: start,
		stop: stop,
		filter: filter,
		query: req.query,
	});

	data.title = meta.config.homePageTitle || '[[pages:home]]';
	data.pageCount = Math.max(1, Math.ceil(data.topicCount / userSettings.topicsPerPage));
	data.pagination = pagination.create(page, data.pageCount, req.query);

	if (userSettings.usePagination && (page < 1 || page > data.pageCount)) {
		req.query.page = Math.max(1, Math.min(data.pageCount, page));
		return helpers.redirect(res, '/unread?' + querystring.stringify(req.query));
	}

	data.categories = watchedCategories.categories;
	data.allCategoriesUrl = 'unread' + helpers.buildQueryString('', filter, '');
	data.selectedCategory = watchedCategories.selectedCategory;
	data.selectedCids = watchedCategories.selectedCids;
	if (req.originalUrl.startsWith(nconf.get('relative_path') + '/api/unread') || req.originalUrl.startsWith(nconf.get('relative_path') + '/unread')) {
		data.title = '[[pages:unread]]';
		data.breadcrumbs = helpers.buildBreadcrumbs([{ text: '[[unread:title]]' }]);
	}

	data.filters = helpers.buildFilters('unread', filter, req.query);

	data.selectedFilter = data.filters.find(filter => filter && filter.selected);

	res.render('unread', data);
};

async function getWatchedCategories(uid, cid, filter) {
	if (plugins.hasListeners('filter:unread.categories')) {
		return await plugins.fireHook('filter:unread.categories', { uid: uid, cid: cid });
	}
	const states = [categories.watchStates.watching];
	if (filter === 'watched') {
		states.push(categories.watchStates.notwatching, categories.watchStates.ignoring);
	}
	return await helpers.getCategoriesByStates(uid, cid, states);
}

unreadController.unreadTotal = async function (req, res, next) {
	const filter = req.query.filter || '';
	try {
		const data = await plugins.fireHook('filter:unread.getValidFilters', { filters: { ...helpers.validFilters } });
		if (!data.filters[filter]) {
			return next();
		}
		const unreadCount = await topics.getTotalUnread(req.uid, filter);
		res.json(unreadCount);
	} catch (err) {
		next(err);
	}
};
