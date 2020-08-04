var test = require('tape')
var multifeed = require('..')
var ram = require('random-access-memory')
var parallel = require('run-parallel')

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

  var total = 500
  var tasks = []

  for (var i = 0; i < total; i++) {
    tasks.push((done) => {
      createMultifeed((err, m) => {
        if (err) return done(err)
        done(null, m)
      })
    })
  }

  parallel(tasks, (err, feeds) => {
    if (err) throw err
    console.log(feeds.length, 'feeds')
    console.log('ready!')
    var replications = []

    feeds.sort((a, b) => {
      if (a && b) {
        replications.push((done) => replicate(a, b, done))
      }
      return -1
    })

    parallel(replications, (err) => {
      if (err) throw err
      console.log('replicated! everything!')
      t.end()
    })
  })

  function replicate (m1, m2, cb) {
    var r = m1.replicate(true)
    r.pipe(m2.replicate(false)).pipe(r)
      .once('end', cb)
      .once('remote-feeds', (feeds) => {
        console.log('got remote feeds')
      })
  }
})
