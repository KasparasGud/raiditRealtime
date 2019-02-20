var moment = require("moment");
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

  transit.importGTFS(
    "/Users/kgudzius/raiditRealtime/app/data/vilnius",
    function(err) {
      console.log("ready");
    }
  );
  setTimeout(() => {
    console.log("ready");

    setInterval(() => {
      var matchedTrips = [];
      console.log("entered");
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
          shortName: static.routeShortName,
          color: static.routeColor,
          textColor: static.routeTextColor,
          type: static.routeType,
          offset: parseInt(max.NuokrypisSekundemis),
          predictedDistanceOffset: max.distance
        });
      });

      matched = matchedTrips;
    }, 10000);

    setInterval(async () => {
      vilniusRealtime = await lithuania.getVilnius();
    }, 3000);

    setInterval(() => {
      var theTime = moment();
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
    }, 10000);
  }, 30000);

  app.get("/realtime", (req, res) => {
    res.contentType("json");

    var nwlon = req.query.nwlon;
    var nwlat = req.query.nwlat;
    var selon = req.query.selon;
    var selat = req.query.selat;

    console.log(nwlon);
    console.log(nwlat);
    console.log(selon);
    console.log(selat);

    var time = moment();
    var seconds =
      time.get("hour") * 3600 + time.get("minutes") * 60 + time.get("seconds");
    var tracks = [];

    matched.forEach(trip => {
      //construct current tracks
      //find where the realtimepoint lies on the track
      var point = ruler.pointOnLine(trip.coordinates, trip.lastRealtime).point;
      //split the track from that point to the end
      var tempTrack = ruler.lineSlice(
        point,
        trip.coordinates[trip.coordinates.length - 1],
        trip.coordinates
      );
      //find another predicted point based on how much time passed since last measurement
      //find the end point where to split the line at the end
      var time = trip.arrivalTime/1000 + trip.offset - trip.departureTime/1000;
      var speed = trip.distance / time;
      var secondsSinceMeasured = seconds - trip.lastMeasured;
      var delta = speed * secondsSinceMeasured;
      var endDelta = delta + speed * 15;
      var realtimePrediction = ruler.along(tempTrack, delta);
      var realtimePredictionEnd = ruler.along(tempTrack, endDelta);
      if (
        !ruler.insideBBox(realtimePrediction, [nwlon, nwlat, selon, selat]) &&
        !ruler.insideBBox(realtimePredictionEnd, [nwlon, nwlat, selon, selat])
      ) {
        return;
      }
      var finalTrack = ruler.lineSlice(
        realtimePrediction,
        realtimePredictionEnd,
        trip.coordinates
      );
      console.log(finalTrack)
      var encoded = polyline.encode(finalTrack);
      tracks.push({
        line: encoded,
        id: trip.id,
        shortName: trip.shortName,
        color: trip.color,
        textColor: trip.textColor,
        type: trip.type
      })

    });

    res.csv(tracks);
  });
};
