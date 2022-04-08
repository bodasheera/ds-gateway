"use strict";

const request = require("request");
const express = require("express");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const avUtils = require("@appveen/utils");
const fileUpload = require("express-fileupload");
const fileSizeParser = require("filesize-parser");


const port = process.env.PORT || 9080;

const log4js = avUtils.logger.getLogger;
let version = require("./package.json").version;
const loggerName = (process.env.KUBERNETES_SERVICE_HOST && process.env.KUBERNETES_SERVICE_PORT) ? `[${process.env.DATA_STACK_NAMESPACE}] [${process.env.HOSTNAME}] [GW ${version}]` : `[GW ${version}]`;

const logger = log4js.getLogger(loggerName);
let timeOut = process.env.API_REQUEST_TIMEOUT || 120;
global.logger = logger;

const config = require("./config/config.js");
const utilMiddleware = require("./util/utilMiddleware");
const authUtil = require("./util/authUtil");
const fileMapper = require("./util/fileMapperMiddleware");
const router = require("./util/router.js");
// const gwUtil = require("./util/gwUtil");
const cacheUtil = require("./util/cacheUtil");
const diagRouter = require("./routes/diag.route");
const userHBRouter = require("./routes/userHB.route");
const authenticationMiddleware = require("./auth/authenticationMiddleware");
// const authorizationMiddleware = require("./auth/authorizationMiddleware");
// const requestDetailsMiddelware = require("./auth/requestDetailsMiddelware");
const bulkImportUser = require("./util/bulkImportUserMiddleware");


config.init();

global.mongoAppCenterConnected = false;
global.mongoAuthorConnected = false;
require("./util/mongoUtils").init();

const app = express();
cacheUtil.init();

const userCacheUtil = avUtils.cache;
userCacheUtil.init();

let maxJSONSize = process.env.MAX_JSON_SIZE || "100kb";
logger.info(`Data service max JSON size :: ${maxJSONSize}`);

let maxFileSize = process.env.MAX_FILE_SIZE || "5MB";
logger.info(`Data service max file upload size :: ${maxFileSize}`);

app.use(utilMiddleware.requestLogger);

app.use(express.json({
	inflate: true,
	limit: maxJSONSize,
	strict: true
}));

// FILE UPLOAD CONFIGURATIONS

let allowedFileTypes = process.env.ALLOWED_FILE_TYPES || config.defaultAllowedFileTypes;
allowedFileTypes = allowedFileTypes.split(",");
logger.info(`Allowed file types : ${allowedFileTypes}`);

const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		cb(null, "./uploads");
	},
	filename: function (_req, _file, _cb) {
		logger.debug(`[${_req.headers.TxnId}] File details :: ${JSON.stringify(_file)}`);
		let extn = _file.originalname.split(".").pop();
		logger.debug(`[${_req.headers.TxnId}] File extn of file "${_file.originalname}"" :: ${extn}`);
		let fileValidExtension = allowedFileTypes;
		if (_req.path.indexOf("fileMapper") > -1 || _req.path.indexOf("bulkCreate") > -1) {
			fileValidExtension = ["csv", "xlsx", "xls", "ods", "json"];
		}
		if (fileValidExtension.indexOf(extn) == -1) return _cb({ "message": "Invalid file extension!" });
		_cb(null, `tmp-${Date.now()}`);
	}
});
let upload = multer({ storage: storage });

app.use((req, res, next) => {
	let urlSplit = req.path.split("/");
	if ((urlSplit[6] && urlSplit[6] === "fileMapper") || (urlSplit[4] && urlSplit[4] === "usr" && urlSplit[5] && urlSplit[5] === "bulkCreate")) {
		upload.single("file")(req, res, next);
	} else {
		fileUpload({ useTempFiles: true })(req, res, next);
	}
});

app.use((req, res, next) => {
	let urlSplit = req.path.split("/");
	if ((urlSplit[5] && urlSplit[5] === "fileMapper") || (urlSplit[4] && urlSplit[4] === "usr" && urlSplit[5] && urlSplit[5] === "bulkCreate")) {
		next();
	} else {
		const sizeInBytes = fileSizeParser(maxFileSize);
		if (req.files && req.files.file && req.files.file.size > sizeInBytes) {
			res.status(413).json({ message: "File Too Large, max file size should be " + maxFileSize });
		} else {
			next();
		}
	}
});

app.use(cookieParser());

app.use(utilMiddleware.notPermittedUrlCheck);
app.use(utilMiddleware.checkTokenMiddleware);
app.use(utilMiddleware.storeUserPermissions);
app.use(utilMiddleware.corsMiddleware);

// START OF SOME REAL SHIT


diagRouter.e.dependencyCheck().catch(_e => logger.error(_e));

app.use("/gw", diagRouter.router);
app.put("/api/a/rbac/usr/hb", userHBRouter);
app.get("/api/a/workflow/:app/serviceList", authUtil.workflowServiceList);


app.use(authenticationMiddleware.diagnosticAPIHandler);
app.use(fileMapper.fileMapperHandler);
app.use(bulkImportUser);

app.use(router.getRouterMiddleware({
	target: config.get("gw"),
	router: function (req) {
		let fixRoutes = {
			"/api/a/common": config.get("common"),
			"/api/a/rbac": config.get("user"),
			"/api/a/sm": config.get("sm"),
			"/api/a/bm": config.get("bm"),
			"/api/a/mon": config.get("mon"),
			// "/api/a/workflow": config.get("wf"),
			"/api/a/route": config.get("b2b"),
			// "/api/a/sec": config.get("sec"),
			"/api/a/b2bgw": config.get("b2bgw"),
			"/api/a/de": config.get("de")
		};
		let selectedKey = Object.keys(fixRoutes).find(key => req.path.startsWith(key));
		if (selectedKey) return Promise.resolve(fixRoutes[selectedKey]);
		let api = req.path.split("/")[3] + "/" + req.path.split("/")[4];
		let faasApi = req.path.split("/")[3] + "/" + req.path.split("/")[4] + "/" + req.path.split("/")[5];
		logger.info(`[${req.headers.TxnId}] Master service router API :: ${api}`);

		if (req.path.startsWith("/api/a/faas")) {
			return getFaasApi(req, faasApi);
		} else {
			return getDSApi(req, api);
		}

		// if (req.method === "GET") {
		// 	return getDSApi(req, api);
		// } else {
		// 	return skipWorkflow(req.path, req)
		// 		.then(_flag => {
		// 			if (_flag) {
		// 				return getDSApi(req, api);
		// 			} else {
		// 				return "next";
		// 			}
		// 		});
		// }
	},
	pathRewrite: {
		"/api/a/faas": "/api",
		"/api/a/": "/",
		"/api/c/": "/"
	},
	onRes: function (req, res, body) {
		if ((req.path === "/api/a/rbac/auth/login" || req.path === "/api/a/rbac/auth/refresh" || req.path === "/api/a/rbac/auth/check") && res.statusCode === 200) {
			let domain = process.env.FQDN ? process.env.FQDN.split(":").shift() : "localhost";
			let cookieJson = {};
			if (domain != "localhost") {
				cookieJson = {
					expires: new Date(body.expiresIn),
					httpOnly: true,
					sameSite: true,
					secure: true,
					domain: domain,
					path: "/api/"
				};
			}
			res.cookie("Authorization", "JWT " + body.token, cookieJson);
		}
		return res.json(body);
	}
	// onRes: authUtil.getProxyResHandler(["/api/a/rbac", "/api/a/workflow"])
}));


function getDSApi(req, api) {
	return new Promise((resolve, reject) => {
		if (global.masterServiceRouter[api]) {
			logger.debug(`[${req.headers.TxnId}] Routing to :: ${global.masterServiceRouter[api]}`);
			resolve(global.masterServiceRouter[api]);
		} else {
			let apiSplit = api.split("/");
			let filter = { app: apiSplit[0], api: "/" + apiSplit[1] };
			logger.debug(`${req.headers.TxnId} Calling getDSApi`);
			request(config.get("sm") + "/sm/service", {
				headers: {
					"content-type": "application/json",
					"Authorization": req.get("Authorization"),
					"User": req.user ? req.user._id : null
				},
				qs: {
					filter: JSON.stringify(filter),
					select: "_id,app,api,port"
				}
			}, (err, res, body) => {
				if (err) {
					logger.error(`[${req.headers.TxnId}] Error in getDSApi: ${err}`);
					reject(err);
				} else if (res.statusCode != 200) {
					logger.debug(`[${req.headers.TxnId}] res.status code in getDSApi :: ${res.statusCode}`);
					logger.debug(`[${req.headers.TxnId}] Error in getDSApi: ${body}`);
					reject(body);
				} else {
					let parsed = JSON.parse(body);
					if (!parsed.length) {
						logger.error(`[${req.headers.TxnId}] Response length in getDSApi : ${parsed.length}`);
						return reject(new Error(`Data Service with ${api} api doesn't exist.`));
					}
					let dsDetails = parsed[0];
					let URL = "http://localhost:" + dsDetails.port;
					if (process.env.GW_ENV == "K8s") {
						URL = "http://" + dsDetails.api.split("/")[1] + "." + config.odpNS + "-" + dsDetails.app.toLowerCase().replace(/ /g, "");
					}
					global.masterServiceRouter[escape(dsDetails.app) + dsDetails.api] = URL;
					resolve(global.masterServiceRouter[api]);
				}
			});
		}

	});
}


function getFaasApi(req, api) {
	return new Promise((resolve, reject) => {
		let apiPath = `/api/a/${api}`;
		if (global.masterFaasRouter[apiPath]) {
			logger.debug(`[${req.headers.TxnId}] Routing to :: ${global.masterFaasRouter[apiPath]}`);
			resolve(global.masterFaasRouter[apiPath]);
		} else {
			let apiSplit = api.split("/");
			let filter = { app: apiSplit[4], url: apiPath };
			logger.debug(`${req.headers.TxnId} Calling getFaasApi`);
			request(config.get("bm") + "/bm/faas", {
				headers: {
					"content-type": "application/json",
					"Authorization": req.get("Authorization"),
					"User": req.user ? req.user._id : null
				},
				qs: {
					filter: JSON.stringify(filter),
					select: "_id,app,url,port,deploymentName,namespace"
				}
			}, (err, res, body) => {
				if (err) {
					logger.error(`[${req.headers.TxnId}] Error in getFaasApi: ${err}`);
					reject(err);
				} else if (res.statusCode != 200) {
					logger.debug(`[${req.headers.TxnId}] res.status code in getFaasApi :: ${res.statusCode}`);
					logger.debug(`[${req.headers.TxnId}] Error in getFaasApi: ${body}`);
					reject(body);
				} else {
					let parsed = JSON.parse(body);
					if (!parsed.length) {
						logger.error(`[${req.headers.TxnId}] Response length in getFaasApi : ${parsed.length}`);
						return reject(new Error(`Faas with ${api} api doesn't exist.`));
					}
					let faasDetails = parsed[0];
					let URL = "http://localhost:" + faasDetails.port;
					if (process.env.GW_ENV == "K8s") {
						URL = "http://" + faasDetails.deploymentName + "." + faasDetails.namespace; // + faasDetails.port
					}
					global.masterFaasRouter[apiPath] = URL;
					resolve(global.masterFaasRouter[apiPath]);
				}
			});
		}

	});
}


app.use(function (error, req, res, next) {
	if (error) {
		logger.error(error);
		if (!res.headersSent) {
			let statusCode = error.statusCode ? error.statusCode : 500;
			res.status(statusCode).json({
				message: error.message
			});
		}
	} else {
		next();
	}
});


var server = app.listen(port, (err) => {
	if (!err) {
		logger.info("Server started on port " + port);
		require("./sockets/gw.socketServer")(server);
	} else logger.error(err);
});

server.setTimeout(parseInt(timeOut) * 1000);
