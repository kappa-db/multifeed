var test = require('tape')
var multifeed = require('..')
var ram = require('random-access-memory')
var series = require('async-series')

test('so many feeds', function (t) {
  function createMultifeed (cb) {
    var multi = multifeed(ram, { valueEncoding: 'json' })
    multi.writer(function (err, feed) {
      if (err) throw err
      multi.ready(function () {
        if ((Math.random() * 100) < 30) feed.append({'foo': 'bar'}, done)
        else done()
      })
    })

    function done (err) {
      cb(err, multi)
    }
  }

  var total = 20
  var tasks = []
  var feeds = []

  for (var i = 0; i < total; i++) {
    ;(function (n) {
      tasks.push((done) => {
        // console.log('making', n)
        createMultifeed((err, m) => {
          if (err) return done(err)
          // console.log('made', n)
          feeds.push(m)
          m.n = n
          done(null, m)
        })
      })
    })(i)
  }

  series(tasks, (err) => {
    if (err) throw err
    console.log('created', feeds.length, 'feeds')
    console.log('ready!')
    var replications = []

    feeds.sort((a, b) => {
      if (a && b) {
        replications.push((done) => {
          // console.log('syncing', a.n, 'and', b.n)
          replicate(a, b, err => {
            // console.log('SYNCED', a.n, 'and', b.n)
            done(err)
          })
        })
      }
      return -1
    })

    console.log('pre-sync heap', process.memoryUsage().heapUsed / 1000000, 'mb')
    series(replications, (err) => {
      if (err) throw err
      console.log('replicated! everything!')
      console.log('post-sync heap', process.memoryUsage().heapUsed / 1000000, 'mb')
      t.end()
    })
  })

  function replicate (m1, m2, cb) {
    var r = m1.replicate(true)
    r.pipe(m2.replicate(false)).pipe(r)
      .once('end', cb)
  }
})
