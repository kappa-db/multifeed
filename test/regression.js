var test = require('tape')
var hypercore = require('hypercore')
var multifeed = require('..')
var ram = require('random-access-memory')
var tmp = require('tmp').tmpNameSync

test('regression: concurrency of writer creation', function (t) {
  t.plan(3)

  var storage = tmp()
  var key

  var multi = multifeed(hypercore, storage, { valueEncoding: 'json' })

  multi.writer('minuette', function (err, w) {
    t.error(err)
    t.ok(w.key)
    key = w.key
  })

  multi.ready(function () {
    t.equals(multi.feeds().length, 0)
  })
})

test('regression: MF with no writer replicate to MF with 1 writer', function (t) {
  var m1 = multifeed(hypercore, ram, { valueEncoding: 'json' })
  var m2 = multifeed(hypercore, ram, { valueEncoding: 'json' })

  function setup1 (m, buf, cb) {
    m.writer(function (err, w) {
      t.error(err)
      var bufs = []
      for(var i=0; i < 1000; i++) {
        bufs.push(buf)
      }
      w.append(bufs, function (err) {
        t.error(err)
        w.get(13, function (err, data) {
          t.error(err)
          t.equals(data, buf)
          t.deepEquals(m.feeds(), [w], 'read matches write')
          cb()
        })
      })
    })
  }

  function setup2 (m, buf, cb) {
    m.writer(function (err, w) {
      t.error(err)
      var bufs = []
      for(var i=0; i < 10; i++) {
        bufs.push(buf)
      }
      w.append(bufs, function (err) {
        t.error(err)
        w.get(3, function (err, data) {
          t.error(err)
          t.equals(data, buf)
          t.deepEquals(m.feeds(), [w], 'read matches write')
          cb()
        })
      })
    })
    //cb()
    //m.writer(function (err, w) {
    //  t.error(err)
    //  cb()
    //})
  }

  setup1(m1, 'foo', function () {
    setup2(m2, 'bar', function () {
      var r = m1.replicate()
      r.once('end', done)
      var s = m2.replicate()
      s.once('end', done)
      r.pipe(s).pipe(r)

      var pending = 2
      function done () {
        if (!--pending) check()
      }
    })
  })

  function check () {
    t.equals(m1.feeds().length, 2, '2 feeds')
    t.equals(m2.feeds().length, 2, '2 feeds')
    t.equals(m1.feeds()[0].length, 1000, 'writer sees 1000 entries')
    t.equals(m1.feeds()[1].length, 10, 'writer sees 10 entries')
    t.equals(m2.feeds()[0].length, 10, 'receiver sees 10 entries')
    t.equals(m2.feeds()[1].length, 1000, 'receiver sees 1000 entries')
    m1.feeds()[1].get(0, function (err, data) {
      t.error(err)
      t.equals(data, 'bar', 'feed 1 has feed 2 data')
      m2.feeds()[1].get(0, function (err, data) {
        t.error(err)
        t.equals(data, 'foo', 'feed 2 has feed 1 data')
        t.end()
      })
    })
  }
})

test('regression: start replicating before feeds are loaded', function (t) {
  t.plan(22)

  var m1 = multifeed(hypercore, ram, { valueEncoding: 'json' })
  var m2 = multifeed(hypercore, ram, { valueEncoding: 'json' })

  var feedEvents1 = 0
  var feedEvents2 = 0
  m1.on('feed', function (feed, name) {
    t.equals(name, String(feedEvents1))
    feedEvents1++
  })
  m2.on('feed', function (feed, name) {
    t.equals(name, String(feedEvents2))
    feedEvents2++
  })

  function setup (m, buf, cb) {
    m.writer(function (err, w) {
      t.error(err)
      w.append(buf, function (err) {
        t.error(err)
        w.get(0, function (err, data) {
          t.error(err)
          t.equals(data, buf)
          t.deepEquals(m.feeds(), [w])
          cb()
        })
      })
    })
  }

  setup(m1, 'foo', function () {
    setup(m2, 'bar', function () {
      var r = m1.replicate()
      r.pipe(m2.replicate()).pipe(r)
        .once('end', check)
    })
  })

  function check () {
    t.equals(m1.feeds().length, 2)
    t.equals(m2.feeds().length, 2)
    m1.feeds()[1].get(0, function (err, data) {
      t.error(err)
      t.equals(data, 'bar')
    })
    m2.feeds()[1].get(0, function (err, data) {
      t.error(err)
      t.equals(data, 'foo')
    })
    t.equals(feedEvents1, 2)
    t.equals(feedEvents2, 2)
  }
})

test.only('regression: announce new feed on existing connections', function(t) {
  t.plan(19);
  var m1 = multifeed(hypercore, ram, { valueEncoding: 'json' })
  var m2 = multifeed(hypercore, ram, { valueEncoding: 'json' })
  var m3 = multifeed(hypercore, ram, { valueEncoding: 'json' })

  setup(m1, "First", function() {
    setup(m2, "Second", function() {
      setup(m3, "Third", function() {
        var feedsReplicated = 0;
        var r1 = null, r2 = null; // forward declare replication streams.

        m1.on('feed', function(feed, name) {
          feed.get(0, function(err, entry) {
            t.error(err)
            feedsReplicated++
            switch(feedsReplicated) {
              case 1: // First we should see M2's writer
                t.equals(entry, "Second", "m2's writer should have been replicated")
                break;
              case 2:
                t.equals(entry, "Third", "m3's writer should have been forwarded via m2")
                // close active streams and end the test.
                r1.end()
                r2.end()
                t.end()
                break;
              default:
                t.ok(false, "Only expected to see 2 feed events, got: " + feedsReplicated)
            }
          })
        })

        // m1 and m2 are now live connected.
        r1 = m1.replicate({live: true})
        r1.pipe(m2.replicate({live: true})).pipe(r1)

        // When m3 is attached to m2, m2 should forward m3's writer to m1.
        r2 = m3.replicate({live:true})
        r2.pipe(m2.replicate({live:true})).pipe(r2)

      })
    })
  })

  function setup (m, buf, cb) {
    m.writer(function (err, w) {
      t.error(err)
      w.append(buf, function (err) {
        t.error(err)
        w.get(0, function (err, data) {
          t.error(err)
          t.equals(data, buf)
          t.deepEquals(m.feeds(), [w])
          cb()
        })
      })
    })
  }
})
