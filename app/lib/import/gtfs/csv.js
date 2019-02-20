module.exports = loadCSV

var csv = require('csv')
var concat = require('concat-stream')
var fs = require('fs')
var bomstrip = require('bomstrip');

function loadCSV (filename, callback) {
  var stream = fs.createReadStream(filename)
  stream.on('error', function (error) {
    callback(error)
  })
  stream.pipe(new bomstrip())
  .pipe(csv.parse({
    columns: true
  }))
    .pipe(concat(callback.bind(null, null)))
}
