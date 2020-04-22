'use strict';

const db = require('../database');
const plugins = require('../plugins');
const Meta = require('./index');
const pubsub = require('../pubsub');

const Settings = module.exports;

Settings.get = async function (hash) {
	const data = await db.getObject('settings:' + hash) || {};
	const sortedLists = await db.getSetMembers('settings:' + hash + ':sorted-lists');

	await Promise.all(sortedLists.map(async function (list) {
		const members = await db.getSortedSetRange('settings:' + hash + ':sorted-list:' + list, 0, -1) || [];
		const keys = [];

		data[list] = [];
		for (const order of members) {
			keys.push('settings:' + hash + ':sorted-list:' + list + ':' + order);
		}

		const objects = await db.getObjects(keys);
		objects.forEach(function (obj) {
			data[list].push(obj);
		});
	}));

	return data;
};

Settings.getOne = async function (hash, field) {
	const data = await Settings.get(hash);
	return data[field] !== undefined ? data[field] : null;
};

Settings.set = async function (hash, values, quiet) {
	quiet = quiet || false;

	const sortedLists = [];

	for (const key in values) {
		if (values.hasOwnProperty(key)) {
			if (Array.isArray(values[key]) && typeof values[key][0] !== 'string') {
				sortedLists.push(key);
			}
		}
	}

	if (sortedLists.length) {
		await db.delete('settings:' + hash + ':sorted-lists');
		await db.setAdd('settings:' + hash + ':sorted-lists', sortedLists);

		await Promise.all(sortedLists.map(async function (list) {
			await db.delete('settings:' + hash + ':sorted-list:' + list);
			await Promise.all(values[list].map(async function (data, order) {
				await db.delete('settings:' + hash + ':sorted-list:' + list + ':' + order);
			}));
		}));

		const ops = [];
		sortedLists.forEach(function (list) {
			const arr = values[list];
			delete values[list];

			arr.forEach(function (data, order) {
				ops.push(db.sortedSetAdd('settings:' + hash + ':sorted-list:' + list, order, order));
				ops.push(db.setObject('settings:' + hash + ':sorted-list:' + list + ':' + order, data));
			});
		});

		await Promise.all(ops);
	}

	if (Object.keys(values).length) {
		await db.setObject('settings:' + hash, values);
	}

	plugins.fireHook('action:settings.set', {
		plugin: hash,
		settings: values,
	});

	pubsub.publish('action:settings.set.' + hash, values);
	Meta.reloadRequired = !quiet;
};

Settings.setOne = async function (hash, field, value) {
	const data = {};
	data[field] = value;
	await Settings.set(hash, data);
};

Settings.setOnEmpty = async function (hash, values) {
	const settings = await Settings.get(hash) || {};
	const empty = {};

	Object.keys(values).forEach(function (key) {
		if (!settings.hasOwnProperty(key)) {
			empty[key] = values[key];
		}
	});


	if (Object.keys(empty).length) {
		await Settings.set(hash, empty);
	}
};
