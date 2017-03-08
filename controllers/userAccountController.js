const services = require("../utils/services.js"),
config = services.config,
logger = services.inventoryLogger,
smartlock = services.smartlock,
mongoose = require('mongoose'),
User = mongoose.model('UserModel'),
authController = require('./authController.js'),
moment = require('moment'),
CodedError = require('../utils/CodedError.js'),
slug = require('slug'),
winston = require('winston');

const systemLogger = winston.loggers.get('system');

const storagePath = config.uploadedBase + '/users';
const baseFilesURL = config.fileServer + '/files/users/';

function mapBasicUser(user) {
	return {
		_id: user._id,
		alias: user.alias,
		roles: user.roles,
		name: user.name,
		email: user.email,
		money: user.money,
		ieee: user.ieee,
		profilePic: baseFilesURL + user.slug + '/' + (user.profilePic || 'default.png'),
	}
}

exports.mapBasicUser = mapBasicUser;

exports.addMoney = function (req, res, next) {
	let money = req.body.money;
	let user = req.body.user;
	if(isNaN(money)) return next(new CodedError("Not a number", 403));

	User.update({ _id: user }, { $inc: { money: money } }, function(err) {
		if (err) return next(new CodedError("User not exist", 403));
		logger.logAddMoney(user, money);
		return res.status(200).send(true);
	});
};
exports.regUser = function (req, res, next) {

	var alias = req.body.alias ? req.body.alias : null;
	if (!alias || alias == "") return next(new CodedError("Invalid alias", 400));

	var name = req.body.name ? req.body.name : null;
	if (!name || name == "") return next(new CodedError("Invalid name", 400));

	var email = req.body.email ? req.body.email.trim() : null;
	if (!email || email == "" || email.indexOf(" ") != -1 || email.indexOf("@") == -1) return next(new CodedError("Invalid email", 400));

	var user;
	var image = req.files && req.files.image ? req.files.image[0] : null;
	var ieee = req.body.ieee && req.body.ieee != "" ? req.body.ieee : "";
	authController.generateSaltedPassword(req.body.password.toLowerCase(), config.pwdIterations).then((saltedPassword) => {
		user = {
			alias: req.body.alias.toLowerCase(),
			slug: slug(req.body.alias.toLowerCase()),
			profilePic: image ? image.filename : undefined,
			email: email,
			name: name,
			pwd: saltedPassword,
			hasPassword: true,
			roles: ['user']
		};

		if(ieee !== ""){
			user.ieee = ieee;
			user.code = ieee;
		}
		console.log(user);
		var tasks = [];
		if (image) {
			tasks.push(services.fileUtils.ensureExists(storagePath + '/' + user.slug).then(() => {
				return services.fileUtils.moveFile(config.uploadedBase + '/' + image.filename, storagePath + '/' + user.slug + '/' + image.filename);
			}));
		}
		tasks.push(User.create(user));
		return Promise.all(tasks);
	}).then(() => {
		var userToSend = mapBasicUser(user);
		req.session.user = userToSend;
		logger.logRegister(user._id);
		return res.status(200).send(userToSend);
	}).catch((err) => {
		return next(err);
	});
};

exports.login = function (req, res, next) {
	let user;
	let search = {};
	if(req.body.code){
		User.findOne({ code: req.body.code }).then((storedUser) => {
			user = storedUser;
			if (!user) return res.status(404).send("Code not found");
			var userToSend = mapBasicUser(user);
			req.session.user = userToSend;
			return res.status(200).jsonp(userToSend);
		}).catch((err) => {
			return next(err);
		});
	} else {
		User.findOne({ alias: req.body.alias.toLowerCase() }).then((storedUser) => {
			user = storedUser;
			if (!user) return res.status(404).send("Alias not found");
			return authController.validateSaltedPassword(req.body.password, user.pwd.salt, user.pwd.hash, user.pwd.iterations);
		}).then((result) => {
			if (!result) return next(new CodedError("Incorrect password", 403));
			var userToSend = mapBasicUser(user);
			req.session.user = userToSend;
			return res.status(200).jsonp(userToSend);
		}).catch((err) => {
			return next(err);
		});
	}

};

exports.logout = function (req, res, next) {

	req.session.destroy(err => {
		if(err) return next(err);
		return res.status(200).send(true);
	});

};

exports.toIEEE = function (req, res, next) {
	User.update({_id: req.params.id}, {$push: {roles: 'ieee'}}, (err) => {
		if (err) return next(new CodedError("User not exist", 403));

		smartlock.registerUser(req.params.id).then(function () {
		}).catch(function (err) {
			res.status(200).send(true);
			return next(err);
		});

	});

};
exports.updateProfile = function (req, res, next) {
	User.findOne({ alias: req.body.alias.toLowerCase() }).then((storedUser) => {
		user = storedUser;
		if (!user) return res.status(404).send("Alias not found");
		user.name = req.body.name;
		user.email = req.body.email;
		if (!user.name || user.name == "") user.name = user.alias;
		return user.save();
	}).then(() => {
		return res.status(200).send("Profile updated");
	}).catch((err) => {
		return next(err);
	});
};

exports.changePassword = function (req, res, next) {
	var user;
	User.find({ alias: req.body.alias }).exec().then((result) => {
		user = result;
		if (user.hasPassword && !req.body.oldPassword) throw new CodedError("No old password", 403);
		return authController.validateSaltedPassword(req.body.oldPassword, user.pwd.salt, user.pwd.hash, user.pwd.iterations);
	}).then((result) => {
		if (!result) throw new CodedError("Bad old password", 403);
		if (!req.body.password || req.body.password == "") throw new CodedError("Bad new password", 400);
		return authController.generateSaltedPassword(req.body.password, config.pwdIterations);
	}).then((saltedPassword) => {
		user.pwd = saltedPassword;
		user.hasPassword = true;
		return user.save();
	}).then(() => {
		return res.status(200).send("Password updated");
	}).catch((err) => {
		return next(err);
	});
};

exports.restoreUserPassword = function (req, res, next) {
	var user;
	User.findOne({ alias: req.body.alias.toLowerCase() }).exec().then((storedUser) => {
		user = storedUser;
		if (!user) throw new CodedError("Not found", 404);
		if (user.email != req.body.email) throw new CodedError("Not valid email", 400);
		var newPassword = authController.generatePassword();
		return authController.SHA256(newPassword);
	}).then((hash) => {
		return authController.generateSaltedPassword(hash, config.pwdIterations);
	}).then((saltedPassword) => {
		user.pwd = saltedPassword;
		return user.save();
	}).then(() => {
		return services.email.sendRecoverPasswordEmail(mailOptions);
	}).then((info) => {
		systemLogger.info("Message sent: " + info.response);
		return res.status(200).send("Success");
	}).catch((err) => {
		return next(err);
	});
};