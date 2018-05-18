var test = require('tape')
var hypercore = require('hypercore')
var multifeed = require('..')
var ram = require('random-access-memory')
var tmp = require('tmp').tmpNameSync

test('no feeds', function (t) {
  var multi = multifeed(hypercore, ram, { valueEncoding: 'json' })

  t.deepEquals(multi.feeds(), [])
  t.end()
})

test('create writer', function (t) {
  t.plan(5)

  var multi = multifeed(hypercore, ram, { valueEncoding: 'json' })

  multi.writer(function (err, w) {
    t.error(err)
    w.append('foo', function (err) {
      t.error(err)
      w.get(0, function (err, data) {
        t.error(err)
        t.equals(data.toString(), 'foo')
        t.deepEquals(multi.feeds(), [w])
      })
    })
  })
})

test('get feed by key', function (t) {
  t.plan(3)

  var multi = multifeed(hypercore, ram, { valueEncoding: 'json' })

  multi.writer(function (err, w) {
    t.error(err, 'valid writer created')
    var feed = multi.feed(w.key)
    t.deepEquals(feed, w, 'writer is the same as retrieved feed (buffer key)')
    feed = multi.feed(w.key.toString('hex'))
    t.deepEquals(feed, w, 'writer is the same as retrieved feed (hex key)')
  })
})

test('get localfeed by name', function (t) {
  t.plan(3)

  var multi = multifeed(hypercore, ram, { valueEncoding: 'json' })

  multi.writer('bob', function (err, w) {
    t.error(err, 'valid writer created')
    multi.writer('bob', function (err, w2) {
      t.error(err, 'valid writer retrieved')
      t.deepEquals(w2, w, 'writer is the same as retrieved feed')
    })
  })
})

test('replicate two multifeeds', function (t) {
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

test('get localfeed by name across disk loads', function (t) {
  t.plan(5)

  var storage = tmp()
  var key

  var multi = multifeed(hypercore, storage, { valueEncoding: 'json' })

  multi.writer('minuette', function (err, w) {
    t.error(err)
    t.ok(w.key)
    key = w.key

    // HACK: close its storage
    w._storage.close(function () {
      var multi2 = multifeed(hypercore, storage, { valueEncoding: 'json' })
      multi.writer('minuette', function (err, w2) {
        t.error(err)
        t.ok(w.key)
        t.deepEquals(w2.key, w.key, 'keys match')
      })
    })
  })
})

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
