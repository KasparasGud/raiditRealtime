var Papa = require("papaparse");
var fetch = require("node-fetch");
var _ = require("underscore");
var moment = require("moment");

var realtimeURL = "https://www.stops.lt";
var lastRealtimes = [];
var realtimes = [];
var lastModified = 0;

async function parseRealtime(realtime) {
  var text = await realtime.text();
  var parsedarray = Papa.parse(text, { header: true });
  return parsedarray.data;
}

function fixShitData(realtime) {
  fixedRealtimes = [];
  realtime.forEach(item => {
    if (
      item.ReisoID &&
      item.ReisoID !== "" &&
      item.NuokrypisSekundemis &&
      item.NuokrypisSekundemis !== "" &&
      item.ReisoPradziaMinutemis &&
      item.ReisoPradziaMinutemis !== "" &&
      parseInt(item.NuokrypisSekundemis) < 1800
    ) {
      fixedRealtimes.push(item);
    }
  });
  return fixedRealtimes;
}

function isVehicleDead(lastRealtime, newRealtime) {
  return (
    lastRealtime.ReisoID === newRealtime.ReisoID &&
    lastRealtime.NuokrypisSekundemis == 0 &&
    newRealtime.NuokrypisSekundemis == 0 &&
    lastRealtime.Greitis == 0 &&
    newRealtime.Greitis == 0
  );
}

function fixDeadVehicles(newRealtime) {
  lastRealtimes.forEach(lastRealtime => {
    newRealtime.forEach(newRealtime => {
      if (isVehicleDead(lastRealtime, newRealtime)) {
        newRealtime.dead = true;
      }
    });
  });
  var alive = [];
  newRealtime.forEach(element => {
    if (!element.dead) {
      alive.push(element);
    }
  });
  return alive;
}

async function getVilnius() {
  var realtime = await fetch(`${realtimeURL}/vilnius/gps_full.txt`);
  var modified = moment(realtime.headers.get("last-modified")).valueOf();
  if (modified > lastModified) {
    var parsedarray = await parseRealtime(realtime);
    var fixedData = fixShitData(parsedarray);
    var finalArray = fixedData;
    if (lastRealtimes.length > 0) {
      finalArray = fixDeadVehicles(fixedData);
    }
    lastRealtimes = fixedData;
    realtimes = finalArray;
    lastModified = modified;
    return realtimes;
  }
  return realtimes;
}

async function getKaunas() {
  return "works";
}

async function getKlaipeda() {
  return "works";
}

module.exports.getVilnius = getVilnius;
module.exports.getKaunas = getKaunas;
module.exports.getKlaipeda = getKlaipeda;
