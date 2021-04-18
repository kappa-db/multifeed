var test = require('tape')
var multifeed = require('..')
var hypercrypto = require('hypercore-crypto')
var ram = require('random-access-memory')
var ral = require('random-access-latency')
var tmp = require('tmp').tmpNameSync
var pump = require('pump')
var crypto = require('crypto')
var fs = require('fs')

test('regression: concurrency of writer creation', function (t) {
  t.plan(3)

  var storage = tmp()
  var key

  var multi = multifeed(storage, { valueEncoding: 'json' })

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
  var m1 = multifeed(ram, { valueEncoding: 'json' })
  var m2 = multifeed(ram, { valueEncoding: 'json' })

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
  }

  setup1(m1, 'foo', function () {
    setup2(m2, 'bar', function () {
      var r = m1.replicate(true)
      r.once('end', done)
      var s = m2.replicate(false)
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

  var m1 = multifeed(ram, { valueEncoding: 'json' })
  var m2 = multifeed(ram, { valueEncoding: 'json' })

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
      var r = m1.replicate(true)
      r.pipe(m2.replicate(false)).pipe(r)
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

test('regression: announce new feed on existing connections', function(t) {
  t.plan(21);
  var m1 = multifeed(ram, { valueEncoding: 'json' })
  var m2 = multifeed(ram, { valueEncoding: 'json' })
  var m3 = multifeed(ram, { valueEncoding: 'json' })

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
                m2.writer('local', function(err, w) {
                  t.equal(feed.key.toString('hex'), w.key.toString('hex'), "should see m2's writer")
                  t.equals(entry, "Second", "m2's writer should have been replicated")
                })
                break;
              case 2:
                m3.writer('local', function(err, w) {
                  t.equal(feed.key.toString('hex'), w.key.toString('hex'), "should see m3's writer")
                  t.equals(entry, "Third", "m3's writer should have been forwarded via m2")
                  // close active streams and end the test.
                  r1.end()
                  r2.end()
                  t.end()
                })
                break;
              default:
                t.ok(false, "Only expected to see 2 feed events, got: " + feedsReplicated)
            }
          })
        })

        // m1 and m2 are now live connected.
        r1 = m1.replicate(true, {live: true})
        r1.pipe(m2.replicate(false, {live: true})).pipe(r1)

        // When m3 is attached to m2, m2 should forward m3's writer to m1.
        r2 = m3.replicate(true, {live:true})
        r2.pipe(m2.replicate(false, {live:true})).pipe(r2)

      })
    })
  })

  function setup (m, buf, cb) {
    m.writer('local', function (err, w) {
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

test('regression: replicate before multifeed is ready', function (t) {
  t.plan(1)

  var storage = tmp()
  var key

  var multi = multifeed(storage, { valueEncoding: 'json' })
  var res = multi.replicate(true)
  res.on('error', function () {
    t.ok('error hit')
  })
})

test('regression: MFs with different root keys cannot replicate', function (t) {
  var key = hypercrypto.keyPair().publicKey
  var m1, m2

  m1 = multifeed(ram, { valueEncoding: 'json', encryptionKey: key })
  m2 = multifeed(ram, { valueEncoding: 'json' })  // default encryption key

  setup(m1, 'foo', function () {
    setup(m2, 'bar', function () {
      var r = m1.replicate(true)
      var s = m2.replicate(false)
      pump(r, s, r, function (err) {
        t.same(err.toString(), 'Error: Exchange key did not match remote')
        t.end()
      })
    })
  })

  function setup (m, buf, cb) {
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
})

test('regression: calling close while closing should not throw errors', function (t) {
  var multi = multifeed(ram, { valueEncoding: 'json' })
  multi.ready(function () {
    multi.writer('default', function (err, wr) {
      t.error(err)
      wr.append(Buffer.from('some data'), function (err) {
        t.error(err)
        var p = 2
        multi.close(function () {
          t.ok('initial close finished')
          t.equal(multi.closed, true)
          if (!--p) t.end()
        })
        t.equal(multi.closed, false, 'Multi not *yet* closed')
        multi.close(function () {
          t.ok('second close finished')
          t.equal(multi.closed, true)
          if (!--p) t.end()
        })
      })
    })
  })
})

test('regression: sync two single-core multifeeds /w different storage speeds', function (t) {
  t.plan(5)

  function slowram (delay) {
    return function (name) {
      return ral([delay,delay], ram())
    }
  }

  var m1 = multifeed(slowram(1), { valueEncoding: 'json' })
  var m2 = multifeed(slowram(500), { valueEncoding: 'json' })

  function setup (m, cb) {
    m.writer(function (err, w) {
      t.error(err)
      cb()
    })
  }

  setup(m1, function () {
    setup(m2, function () {
      var r = m1.replicate(true)
      var s = m2.replicate(false)
      pump(r, s, r, function (err) {
        t.error(err)
        check()
      })
    })
  })

  function check () {
    t.equals(m1.feeds().length, 2, '2 feeds')
    t.equals(m2.feeds().length, 2, '2 feeds')
  }
})

test('regression: ensure encryption key is not written to disk', function (t) {
  t.plan(6)

  var storage = tmp()
  var key = crypto.randomBytes(32)

  var multi = multifeed(storage, {
    encryptionKey: key,
    valueEncoding: 'json'
  })

  multi.writer(function (err, w) {
    t.error(err)
    w.append('foo', function (err) {
      t.error(err)
      multi.close(function (err) {
        t.error(err)
        fs.readdir(storage, function (err, res) {
          t.error(err)
          t.equals(res.length, 2)
          t.equals(res[0], '0')
        })
      })
    })
  })
})

test('replicate two multifeeds, twice', function (t) {
  t.plan(20)

  var m1 = multifeed(ram, { valueEncoding: 'json' })
  var m2 = multifeed(ram, { valueEncoding: 'json' })

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
      sync(() => {
        t.ok(true, 'first sync ok')
        sync(() => {
          t.ok(true, 'second sync ok')
        })
      })
    })
  })

  function sync (cb) {
    var pending = 2
    var r1 = m1.replicate(true)
    var r2 = m2.replicate(false)
    r1.once('remote-feeds', function () {
      t.ok(true, 'got r1 "remote-feeds" event')
      t.equals(m1.feeds().length, 2, 'm1 feeds length is 2')
      if (!--pending) cb()
    })
    r2.once('remote-feeds', function () {
      t.ok(true, 'got r2 "remote-feeds" event')
      t.equals(m2.feeds().length, 2, 'm2 feeds length is 2')
      if (!--pending) cb()
    })
    r1.pipe(r2).pipe(r1)
  }
})
