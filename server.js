var redis_url = require("url").parse(process.env.REDIS_URL);
var redis_client = require("redis").createClient(redis_url.port, redis_url.hostname);
if (redis_url.auth) {
  redis_client.auth(redis_url.auth);
}
if (redis_url.pathname !== "/") {
  redis_client.select(redis_url.pathname.substring(1));
}

var async = require("async");

var http = require("http");
var querystring = require('querystring');
var server = http.createServer();
server.on("request", function(req, res) {

  var query = require('url').parse(req.url).query;
  var queryDate = querystring.parse(query).date;

  if (queryDate) {
    queryDate = new Date(queryDate);
    if ( Object.prototype.toString.call(queryDate) === "[object Date]" ) {
      if ( isNaN( queryDate.getTime() ) ) {
        queryDate = null;// date is not valid
      }
    }
  }

  if (!queryDate) {
    res.end('Invalid parameter: "date". Please format as YYYY-MM-DD.');
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8"
  });

  var scan_index = 0;
  var user_ids = [];
  async.doUntil(function fn(cb) {
    redis_client.scan([scan_index, "count", 1000], function(err, data) {
      if (err) {
        return cb(err);
      }

      scan_index = parseInt(data.shift(), 10);
      user_ids = user_ids.concat(data[0]);
      cb();
    });
  }, function test() {
    return scan_index === 0;
  }, function done(err) {
    if (err) {
      return res.end(JSON.stringify({error: err.toString()}));
    }

    user_ids = user_ids.filter(function(key) {
      return /^\d+(?!contribution)$/.test(key);
    });

    var one_year_ago = queryDate.valueOf() - (365 * 24 * 60 * 60 * 1000);
    var total_active_contributors = 0;
    var seven_days_ago = queryDate.valueOf() - (7 * 24 * 60 * 60 * 1000);
    var new_contributors_7_days = 0;

    async.doUntil(function fn(cb) {
      var keys = user_ids.splice(0, 1000);

      keys.map(function(key) {
        return ["hmget", key, "firstContribution"];
      });

      var multi = redis_client.multi(keys).exec(function(err, replies) {
        if (err) {
          return cb(err);
        }

        async.eachSeries(replies, function(data, done) {
          redis_client.smembers(data[0] + ":contributions", function(err, setData) {
            var latestContribution;

            setData.forEach(function(date) {
              date = (new Date(date)).valueOf();
              if ( !latestContribution ) {
                return latestContribution = date;
              }
              if ( date < queryDate && date > latestContribution ) {
                latestContribution = date;
              }
            });

            var firstContribution = new Date(data[1]).valueOf();

            // This will introduce errors over time. As latest contribution date will move ahead of query dates for historic data.
            if (!isNaN(latestContribution) && (latestContribution > one_year_ago) && (latestContribution < queryDate)) {
              total_active_contributors++;
            }
            if (!isNaN(firstContribution) && (firstContribution > seven_days_ago) && (latestContribution < queryDate)) {
              new_contributors_7_days++;
            }

            done();
          });
        }, cb);
      });
    }, function test() {
      return user_ids.length === 0;
    }, function done(err) {
      if (err) {
        return res.end(JSON.stringify({error: err.toString()}));
      }

      res.end(JSON.stringify({
        total_active_contributors: total_active_contributors,
        new_contributors_7_days: new_contributors_7_days
      }));
    });
  });
});

server.listen(process.env.PORT, function() {
  console.log("park-warden listening on http://localhost:%s", process.env.PORT);
});
