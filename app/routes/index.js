const realtimeRoutes = require('./realtime_routes');
module.exports = function(app, db) {
  realtimeRoutes(app, db);
  // Other route groups could go here, in the future
};