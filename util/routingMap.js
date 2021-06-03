"use stict";

const request = require("request-promise");
const config = require("../config/config");
const sh = require("shorthash");
const crypto = require("crypto");

let logger = global.logger;

let e = {};

function getDSHashMapValues(_data){
	if (_data.app && _data.port && _data.api) {
		let URL = "http://localhost:" + _data.port;
		if (process.env.GW_ENV == "K8s") {
			URL = "http://" + _data.api.split("/")[1] + "." + config.odpNS + "-" + _data.app.toLowerCase().replace(/ /g, "");
		}
		logger.trace(`Routing map :: ${_data.app}${_data.api} : ${URL}`);
		return [`${_data.app}${_data.api}`, `${URL}`];
	}
	return null;
}

function getFaasHashMapValues(_data){
	if (_data.app && _data.port && _data.api) {
		let URL = "http://localhost:" + _data.port;
		if (process.env.GW_ENV == "K8s") {
			URL = "http://" + _data.api.split("/")[1] + "." + config.odpNS + "-" + _data.app.toLowerCase().replace(/ /g, ""); // + data.port
		}
		logger.trace(`Routing map :: ${_data.app}${_data.api} : ${URL}`);
		return [`${_data.app}${_data.api}`, `${URL}`];
	}
	return null;
}

e.createServiceList = async () => {
	logger.debug("Calling SM and creating the DS routing map");
	let options = {
		url: `${config.get("sm")}/sm/service`,
		qs: {
			select: "_id,port,api,app,name",
			count: -1,
		},
		headers: {
			"TxnId": `GW_${sh.unique(crypto.createHash("md5").update(Date.now().toString()).digest("hex"))}`
		},
		json: true
	};
	try {
		let serviceRoutingMap = {};
		let serviceIdMap = {};
		let services = await request(options);
		services.forEach(_service => {
			let hashMapValues = getDSHashMapValues(_service);
			serviceRoutingMap[hashMapValues[0]] = hashMapValues[1];
			serviceIdMap[hashMapValues[0]] = _service._id;
		});
		global.masterServiceRouter = serviceRoutingMap;
		global.serviceIdMap = serviceIdMap;
	} catch (_e) {
		logger.error("Unable to create DS routing map!");
		logger.error(_e);
	}
};

e.updateServiceList = _data => {
	logger.info("Updating DS routing map");
	let hashMapValues =  getDSHashMapValues(_data);
	if(hashMapValues) {
		global.masterServiceRouter[hashMapValues[0]] = hashMapValues[1];
		global.serviceIdMap[hashMapValues[0]] = _data._id;
	}
};

e.deleteServiceList = _data => {
	logger.debug(`Deleting DS routing map entry :: ${_data.app}${_data.api}`);
	delete global.masterServiceRouter[`${_data.app}${_data.api}`];
	delete global.serviceIdMap[`${_data.app}${_data.api}`];
};

e.createFaasList = async () => {
	logger.debug("Calling PM and creating the faas routing map");
	let options = {
		url: `${config.get("pm")}/pm/faas`,
		qs: {
			select: "_id,port,api,app,name",
			count: -1,
		},
		headers: {
			"TxnId": `GW_${sh.unique(crypto.createHash("md5").update(Date.now().toString()).digest("hex"))}`
		},
		json: true
	};
	try {
		let faasRoutingMap = {};
		let faasIdMap = {};
		let services = await request(options);
		services.forEach(_service => {
			let hashMapValues = getFaasHashMapValues(_service);
			faasRoutingMap[hashMapValues[0]] = hashMapValues[1];
			faasIdMap[hashMapValues[0]] = _service._id;
		});
		global.masterFaasRouter = faasRoutingMap;
		global.serviceIdMap = faasIdMap;
	} catch (_e) {
		logger.error("Unable to create faas routing map!");
		logger.error(_e);
	}
};

e.updateFaasList = _data => {
	logger.info("Updating Faas routing map");
	let hashMapValues =  getFaasHashMapValues(_data);
	if(hashMapValues) {
		global.masterFaasRouter[hashMapValues[0]] = hashMapValues[1];
		global.faasIdMap[hashMapValues[0]] = _data._id;
	}
};

e.deleteFaasList = _data => {
	logger.debug(`Deleting Faas routing map entry :: ${_data.app}${_data.api}`);
	delete global.masterFaasRouter[`${_data.app}${_data.api}`];
	delete global.faasIdMap[`${_data.app}${_data.api}`];
};

module.exports = e;