var moment = require("moment-timezone");
var Transit = require("../lib/transit");
var turf = require("../lib/utils/turf");
var cheapRuler = require("cheap-ruler");
var polyline = require("@mapbox/polyline");
var csv = require("csv-express");
var lithuania = require("../fetchers/lithuania");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

var ruler = cheapRuler(54.6);

module.exports = async function(app, db) {
  var transit = new Transit();

  var vilniusRealtime = [];
  var vilniusStatic = [];
  var matched = [];
  var tracks = [];

  transit.importGTFS(
    //TODO CREATE A WAY FOR AUTO FETCHING NEWEST GTFS
    //"/Users/kgudzius/raiditRealtime/app/data/vilnius",
    "/home/ubuntu/raiditRealtime/app/data/vilnius",
    function(err) {
      console.log("ready");
    }
  );
  setTimeout(() => {
    console.log('Static length: ' + vilniusStatic.length)
    console.log('Realtime length: ' + vilniusRealtime.length)
    console.log('Matched length: ' + matched.length)
  }, 60000);
  setTimeout(() => {
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
          routeId: static.routeId,
          stoptimes: static.stoptimes,
          vehicleId: max.ReisoID,
          label: max.MasinosNumeris,
          lastRealtime: [max.Ilguma / 1000000, max.Platuma / 1000000],
          lastMeasured: static.yesterday //could fuck up gtfs rt feeds
            ? max.MatavimoLaikas - 86400
            : max.MatavimoLaikas,
          lastSpeed: parseInt(max.Greitis),
          shortName: static.routeShortName,
          color: static.routeColor,
          textColor: static.routeTextColor,
          type: static.routeType,
          offset: parseInt(max.NuokrypisSekundemis),
          predictedDistanceOffset: max.distance
        });
      });
      //console.log('matched length ' + matched.length)
      matched = matchedTrips;
    }, 20000);

    setInterval(() => {
      var creationTime = moment().tz("Europe/Vilnius").valueOf();
      var theTime = moment().tz("Europe/Vilnius");
      var seconds =
        theTime.get("hour") * 3600 +
        theTime.get("minutes") * 60 +
        theTime.get("seconds");
      tracks = [];
      matched.forEach((trip, index) => {
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
        var speed = staticSpeed;
        // if (trip.lastSpeed === 0) {
        //   speed = staticSpeed / 2;
        // }
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
    }, 15000);

    setInterval(async () => {
      vilniusRealtime = await lithuania.getVilnius();
      //console.log('realtime length: ' + vilniusRealtime.length)
    }, 10000);

    setInterval(() => {
      var theTime = moment().tz("Europe/Vilnius");
      var now = theTime.valueOf();
      var seconds =
        theTime.get("hour") * 3600 +
        theTime.get("minutes") * 60 +
        theTime.get("seconds");

      var today = moment().tz("Europe/Vilnius").format("YYYY-MM-DD");
      var yesterday = moment().tz("Europe/Vilnius").subtract(1,'day').format("YYYY-MM-DD")
      var staticVilnius = [];
      //console.time("foreach");
      transit.trips.forEach((trip, index) => {
        var depTime = trip.stops["1"].departure;
        var depArray = depTime.split(":");
        var yesterdaysTrip = false;

        if (trip.service.operating(yesterday)) {
          if (depArray[0] >= 24) {
            yesterdaysTrip = true;
            depTime =
              "0" + parseInt(depArray[0] - 24) + ":" + depArray[1] + ":00";
          }
        }
        //check if trip is opearating on the day
        if (!trip.service.operating(today) && !yesterdaysTrip) {
          return;
        }

        var lastId = parseInt(trip.stops._lastId);
        var arrTime = trip.stops[lastId + ""].departure;
        var arrArray = arrTime.split(":");
        if (yesterdaysTrip) {
          arrTime =
            "0" + parseInt(arrArray[0] - 24) + ":" + arrArray[1] + ":00";
        }
        //converting to unix timestamps
        var departureTime = moment().tz("Europe/Vilnius")
          .startOf("day")
          .add(depArray[0], "hours")
          .add(depArray[1], "minutes")
          .valueOf();
        var hMin = moment(departureTime).tz("Europe/Vilnius").get("hours") * 60;
        var min = moment(departureTime).tz("Europe/Vilnius").get("minutes");
        var sinceMidnight = parseInt(hMin) + parseInt(min);
        if (yesterdaysTrip) {
          sinceMidnight = sinceMidnight + 1440;
        }
        var arrivalTime = moment().tz("Europe/Vilnius")
          .startOf("day")
          .add(arrArray[0], "hours")
          .add(arrArray[1], "minutes")
          .valueOf();
        if (arrivalTime > now && departureTime < now) {
          var stops = [];
          for (i = 1; i < lastId; i++) {
            var deps = trip.stops[i + ""].departure.split(":");
            stops.push({
              id: trip.stops[i + ""]._stopId,
              departure: moment().tz("Europe/Vilnius")
                .startOf("day")
                .add(parseInt(deps[0]), "hours")
                .add(parseInt(deps[1]), "minutes")
                .valueOf()
            });
          }

          var coords = trip.shape.map(item => [item.lon, item.lat]);
          var time = arrivalTime / 1000 - departureTime / 1000;
          var distance = ruler.lineDistance(coords);
          var speed = distance / time;
          var progress = (now / 1000 - departureTime / 1000) * speed;
          var position = ruler.along(coords, progress);
          var line = {
            yesterday: yesterdaysTrip,
            coords: coords,
            stoptimes: stops,
            tripId: trip.id,
            routeId: trip.route.id,
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
      //console.timeEnd("foreach");
      //console.log('vilnius static length: ' + staticVilnius.length)
      vilniusStatic = staticVilnius;
    }, 15000);
  }, 25000);

  app.get("/api/vilnius/trip-updates", (req, res) => {
    try {
      let message = new GtfsRealtimeBindings.FeedMessage();
      let header = new GtfsRealtimeBindings.FeedHeader();
      header.gtfs_realtime_version = "1.0";
      header.incrementality = 0;
      header.timestamp = moment().tz("Europe/Vilnius").valueOf() / 1000;

      let entities = [];
      matched.forEach(transport => {
        const updatedAt =
          moment().tz("Europe/Vilnius")
            .startOf("day")
            .add(transport.lastMeasured, "seconds")
            .valueOf() / 1000;

        let vehicleDescriptor = new GtfsRealtimeBindings.VehicleDescriptor();
        vehicleDescriptor.id = transport.vehicleId;
        vehicleDescriptor.label = transport.label;

        let tripDescriptor = new GtfsRealtimeBindings.TripDescriptor();
        tripDescriptor.trip_id = transport.tripId;
        tripDescriptor.route_id = transport.routeId;

        const now = moment().tz("Europe/Vilnius").valueOf();
        let nextStopId = transport.stoptimes[0].id;
        for (i = 0; i < transport.stoptimes.length; i++) {
          if (now - transport.stoptimes[i].departure < 0) {
            nextStopId = transport.stoptimes[i].id;
            break;
          }
        }

        let stopTimeEvent = new GtfsRealtimeBindings.TripUpdate.StopTimeEvent();
        stopTimeEvent.delay = transport.offset;

        let stopTimeUpdate = new GtfsRealtimeBindings.TripUpdate.StopTimeUpdate();
        stopTimeUpdate.stop_id = nextStopId;
        stopTimeUpdate.departure = stopTimeEvent;

        let tripUpdate = new GtfsRealtimeBindings.TripUpdate();
        tripUpdate.trip = tripDescriptor;
        tripUpdate.vehicle = vehicleDescriptor;
        tripUpdate.delay = transport.offset;
        tripUpdate.timestamp = updatedAt;
        tripUpdate.stop_time_update = stopTimeUpdate;

        let entity = new GtfsRealtimeBindings.FeedEntity();
        entity.id = transport.vehicleId;
        entity.trip_update = tripUpdate;
        entity.is_deleted = null;
        entities.push(entity);
        //entity.vehicle = vehiclePosition;
      });
      message.header = header;
      message.entity = entities;
      res
        .status(200)
        .header("Content-Type", "application/x-protobuf")
        .send(message.encode().toBuffer());
    } catch (error) {
      console.log(error);
    }
  });

  app.get("/realtime", (req, res) => {
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
    res.csv(response);
  });
};