var moment = require("moment-timezone");
var Transit = require("../lib/transit");
var turf = require("../lib/utils/turf");
var cheapRuler = require("cheap-ruler");
var polyline = require("@mapbox/polyline");
var csv = require("csv-express");
var lithuania = require("../fetchers/lithuania");

var ruler = cheapRuler(54.6);

module.exports = async function(app, db) {
  var transit = new Transit();

  var vilniusRealtime = [];
  var vilniusStatic = [];
  var matched = [];
  var tracks = [];

  transit.importGTFS(
    "/Users/kgudzius/raiditRealtime/app/data/vilnius",
    function(err) {
      console.log(err)
      console.log("ready");
    }
  );
  setTimeout(() => {
    console.log("ready");
    setInterval(() => {
      var matchedTrips = [];
      vilniusStatic.forEach(static => {
        var matchingRealtimes = [];
        vilniusRealtime.forEach(realtime => {
          var type = realtime.Transportas === "Troleibusai" ? "800" : "3";
          if (
            static.routeType === type &&
            static.routeShortName == realtime.Marsrutas &&
            (static.departureSinceMidnigth ===
              parseInt(realtime.ReisoPradziaMinutemis) ||
              static.departureSinceMidnigth - 1 ===
                parseInt(realtime.ReisoPradziaMinutemis))
          ) {
            matchingRealtimes.push(realtime);
          }
        });

        if (matchingRealtimes.length === 0) {
          return;
        }

        var newRealtimes = matchingRealtimes.map(realtime => ({
          ...realtime,
          distance: ruler.distance(static.predictedPos, [
            realtime.Ilguma / 1000000,
            realtime.Platuma / 1000000
          ])
        }));

        var max = newRealtimes[0];

        newRealtimes.forEach(element => {
          if (max.distance > element.distance) {
            max = element;
          }
        });

        matchedTrips.push({
          departureTime: static.departureTime,
          arrivalTime: static.arrivalTime,
          distance: static.distance,
          coordinates: static.coords,
          tripId: static.tripId,
          lastRealtime: [max.Ilguma / 1000000, max.Platuma / 1000000],
          lastMeasured: max.MatavimoLaikas,
          lastSpeed: parseInt(max.Greitis),
          shortName: static.routeShortName,
          color: static.routeColor,
          textColor: static.routeTextColor,
          type: static.routeType,
          offset: parseInt(max.NuokrypisSekundemis),
          predictedDistanceOffset: max.distance
        });
      });
      matched = matchedTrips;
    }, 5000);

    setInterval(() => {
      var creationTime = moment().valueOf();
      var theTime = moment().tz('Europe/Vilnius');
      var seconds =
        theTime.get("hour") * 3600 +
        theTime.get("minutes") * 60 +
        theTime.get("seconds");
      tracks = [];
      matched.forEach((trip,index) => {
        //construct current tracks
        //find where the realtimepoint lies on the track
        var point = ruler.pointOnLine(trip.coordinates, trip.lastRealtime)
          .point;
        //slice the start of the line to find disance
        var discardedTrack = ruler.lineSlice(
          trip.coordinates[0],
          point,
          trip.coordinates
        );
        var discardedDistance = ruler.lineDistance(discardedTrack);
        //find another predicted point based on how much time passed since last measurement
        //find the end point where to split the line at the end
        var time =
          trip.arrivalTime / 1000 + trip.offset - trip.departureTime / 1000;
        var staticSpeed = trip.distance / time;
        var speed = staticSpeed / 1.1
        if(trip.lastSpeed === 0) {
          speed = staticSpeed / 2
        }
        var secondsSinceMeasured = seconds - trip.lastMeasured;
        var delta = speed * secondsSinceMeasured;
        var realtimePredictionDistance = discardedDistance + delta;
        var endDelta = delta + speed * 15;
        var realtimeFuturePredictionDistance = discardedDistance + endDelta;
        var realtimePrediction = ruler.along(
          trip.coordinates,
          realtimePredictionDistance
        );
        var realtimePredictionEnd = ruler.along(
          trip.coordinates,
          realtimeFuturePredictionDistance
        );
        var finalTrack = ruler.lineSlice(
          realtimePrediction,
          realtimePredictionEnd,
          trip.coordinates
        );
        tracks.push({
          line: finalTrack,
          id: trip.tripId,
          shortName: trip.shortName,
          color: trip.color,
          textColor: trip.textColor,
          type: trip.type,
          startDistance: parseFloat(realtimePredictionDistance).toFixed(4),
          endDistance: parseFloat(realtimeFuturePredictionDistance).toFixed(4),
          created: creationTime
        });
      });
    }, 5000);

    setInterval(async () => {
      vilniusRealtime = await lithuania.getVilnius();
    }, 1000);

    setInterval(() => {
      var theTime = moment().tz('Europe/Vilnius');
      var now = theTime.valueOf();
      var seconds =
        theTime.get("hour") * 3600 +
        theTime.get("minutes") * 60 +
        theTime.get("seconds");

      var date = new Date().toISOString().slice(0, 10);
      var staticVilnius = [];

      transit.trips.forEach(trip => {
        //check if trip is opearating on the day
        if (!trip.service.operating(date)) {
          return;
        }
        //getting arrival time and departure time
        var depTime = trip.stops["1"].departure;
        var lastId = parseInt(trip.stops._lastId);
        var arrTime = trip.stops[lastId + ""].departure;
        //converting to unix timestamps
        var date = moment(date).format("YYYY-MM-DD") + " " + depTime;
        var departureTime = moment(date).valueOf();
        var hMin = moment(date).get("hours") * 60;
        var min = moment(date).get("minutes");
        var sinceMidnight = parseInt(hMin) + parseInt(min);
        var date2 = moment(date).format("YYYY-MM-DD") + " " + arrTime;
        var arrivalTime = moment(date2).valueOf();

        if (arrivalTime > now && departureTime < now) {
          console.log('entered now timeframe')
          var coords = trip.shape.map(item => [item.lon, item.lat]);
          var time = arrivalTime / 1000 - departureTime / 1000;
          var distance = ruler.lineDistance(coords);
          var speed = distance / time;
          var progress = (now / 1000 - departureTime / 1000) * speed;
          var position = ruler.along(coords, progress);
          var line = {
            coords: coords,
            tripId: trip.id,
            routeShortName: trip.route.shortName,
            routeColor: "#" + trip.route.color,
            routeTextColor: "#" + trip.route.textColor,
            routeType: trip.route.type,
            departureSinceMidnigth: sinceMidnight,
            departureTime: departureTime,
            arrivalTime: arrivalTime,
            distance: distance,
            predictedPos: position
          };
          
          staticVilnius.push(line);

          return;
        }
      });
      vilniusStatic = staticVilnius;
    }, 5000);
  }, 20000);

  app.get("/realtime", (req, res) => {
    console.log(vilniusStatic)
    console.log(matched)
    console.log(tracks)
    console.time("realtime");
    res.contentType("json");

    var nwlon = req.query.nwlon;
    var nwlat = req.query.nwlat;
    var selon = req.query.selon;
    var selat = req.query.selat;

    var response = [];

    tracks.forEach(track => {
      if (
        !ruler.insideBBox(track.line[0], [nwlon, nwlat, selon, selat]) &&
        !ruler.insideBBox(track.line[track.line.length - 1], [
          nwlon,
          nwlat,
          selon,
          selat
        ])
      ) {
        return;
      }
      var encoded = polyline.encode(track.line);
      response.push({
        line: encoded,
        id: track.id,
        shortName: track.shortName,
        color: track.color,
        textColor: track.textColor,
        type: track.type,
        startDistance: track.startDistance,
        endDistance: track.endDistance,
        created: track.created
      });
    });
    console.timeEnd("realtime");
    res.csv(response);
  });
};
