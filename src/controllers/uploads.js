'use strict';

const path = require('path');
const nconf = require('nconf');
const validator = require('validator');
const winston = require('winston');
const util = require('util');

const db = require('../database');
const meta = require('../meta');
const file = require('../file');
const plugins = require('../plugins');
const image = require('../image');
const privileges = require('../privileges');

const uploadsController = module.exports;

uploadsController.upload = async function (req, res, filesIterator) {
	let files = req.files.files;

	if (!Array.isArray(files)) {
		return res.status(500).json('invalid files');
	}

	if (Array.isArray(files[0])) {
		files = files[0];
	}

	// backwards compatibility
	if (filesIterator.constructor && filesIterator.constructor.name !== 'AsyncFunction') {
		winston.warn('[deprecated] uploadsController.upload, use an async function as iterator');
		filesIterator = util.promisify(filesIterator);
	}

	try {
		const images = await Promise.all(files.map(fileObj => filesIterator(fileObj)));
		res.status(200).json(images);
	} catch (err) {
		res.status(500).json({ path: req.path, error: err.message });
	} finally {
		deleteTempFiles(files);
	}
};

uploadsController.uploadPost = async function (req, res) {
	await uploadsController.upload(req, res, async function (uploadedFile) {
		const isImage = uploadedFile.type.match(/image./);
		if (isImage) {
			return await uploadAsImage(req, uploadedFile);
		}
		return await uploadAsFile(req, uploadedFile);
	});
};

async function uploadAsImage(req, uploadedFile) {
	const canUpload = await privileges.global.can('upload:post:image', req.uid);
	if (!canUpload) {
		throw new Error('[[error:no-privileges]]');
	}
	await image.checkDimensions(uploadedFile.path);
	await image.stripEXIF(uploadedFile.path);

	if (plugins.hasListeners('filter:uploadImage')) {
		return await plugins.fireHook('filter:uploadImage', {
			image: uploadedFile,
			uid: req.uid,
		});
	}
	await image.isFileTypeAllowed(uploadedFile.path);

	let fileObj = await uploadsController.uploadFile(req.uid, uploadedFile);

	if (meta.config.resizeImageWidth === 0 || meta.config.resizeImageWidthThreshold === 0) {
		return fileObj;
	}

	fileObj = await resizeImage(fileObj);
	return { url: fileObj.url };
}

async function uploadAsFile(req, uploadedFile) {
	const canUpload = await privileges.global.can('upload:post:file', req.uid);
	if (!canUpload) {
		throw new Error('[[error:no-privileges]]');
	}

	if (!meta.config.allowFileUploads) {
		throw new Error('[[error:uploads-are-disabled]]');
	}

	const fileObj = await uploadsController.uploadFile(req.uid, uploadedFile);
	return {
		url: fileObj.url,
		name: fileObj.name,
	};
}

async function resizeImage(fileObj) {
	const imageData = await image.size(fileObj.path);
	if (imageData.width < meta.config.resizeImageWidthThreshold || meta.config.resizeImageWidth > meta.config.resizeImageWidthThreshold) {
		return fileObj;
	}

	await image.resizeImage({
		path: fileObj.path,
		target: file.appendToFileName(fileObj.path, '-resized'),
		width: meta.config.resizeImageWidth,
		quality: meta.config.resizeImageQuality,
	});
	// Return the resized version to the composer/postData
	fileObj.url = file.appendToFileName(fileObj.url, '-resized');

	return fileObj;
}

uploadsController.uploadThumb = async function (req, res, next) {
	if (!meta.config.allowTopicsThumbnail) {
		deleteTempFiles(req.files.files);
		return next(new Error('[[error:topic-thumbnails-are-disabled]]'));
	}

	await uploadsController.upload(req, res, async function (uploadedFile) {
		if (!uploadedFile.type.match(/image./)) {
			throw new Error('[[error:invalid-file]]');
		}
		await image.isFileTypeAllowed(uploadedFile.path);
		await image.resizeImage({
			path: uploadedFile.path,
			width: meta.config.topicThumbSize,
			height: meta.config.topicThumbSize,
		});
		if (plugins.hasListeners('filter:uploadImage')) {
			return await plugins.fireHook('filter:uploadImage', {
				image: uploadedFile,
				uid: req.uid,
			});
		}

		return await uploadsController.uploadFile(req.uid, uploadedFile);
	});
};

uploadsController.uploadFile = async function (uid, uploadedFile) {
	if (plugins.hasListeners('filter:uploadFile')) {
		return await plugins.fireHook('filter:uploadFile', {
			file: uploadedFile,
			uid: uid,
		});
	}

	if (!uploadedFile) {
		throw new Error('[[error:invalid-file]]');
	}

	if (uploadedFile.size > meta.config.maximumFileSize * 1024) {
		throw new Error('[[error:file-too-big, ' + meta.config.maximumFileSize + ']]');
	}

	const allowed = file.allowedExtensions();

	const extension = path.extname(uploadedFile.name).toLowerCase();
	if (allowed.length > 0 && (!extension || extension === '.' || !allowed.includes(extension))) {
		throw new Error('[[error:invalid-file-type, ' + allowed.join('&#44; ') + ']]');
	}

	return await saveFileToLocal(uid, uploadedFile);
};

async function saveFileToLocal(uid, uploadedFile) {
	const name = uploadedFile.name || 'upload';
	const extension = path.extname(name) || '';

	const filename = Date.now() + '-' + validator.escape(name.substr(0, name.length - extension.length)).substr(0, 255) + extension;

	const upload = await file.saveFileToLocal(filename, 'files', uploadedFile.path);
	const storedFile = {
		url: nconf.get('relative_path') + upload.url,
		path: upload.path,
		name: uploadedFile.name,
	};
	const fileKey = upload.url.replace(nconf.get('upload_url'), '');
	await db.sortedSetAdd('uid:' + uid + ':uploads', Date.now(), fileKey);
	const data = await plugins.fireHook('filter:uploadStored', { uid: uid, uploadedFile: uploadedFile, storedFile: storedFile });
	return data.storedFile;
}

function deleteTempFiles(files) {
	files.forEach(fileObj => file.delete(fileObj.path));
}

require('../promisify')(uploadsController, ['upload', 'uploadPost', 'uploadThumb']);
