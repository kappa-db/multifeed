var test = require('tape')
var crypto = require('hypercore-crypto')
var multifeed = require('..')
var ram = require('random-access-memory')
var ral = require('random-access-latency')
var tmp = require('tmp').tmpNameSync
var rimraf = require('rimraf')

test('no feeds', function (t) {
  var multi = multifeed(ram, { valueEncoding: 'json' })

  t.deepEquals(multi.feeds(), [])
  t.end()
})

test('create writer', function (t) {
  t.plan(5)

  var multi = multifeed(ram, { valueEncoding: 'json' })

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

  var multi = multifeed(ram, { valueEncoding: 'json' })

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

  var multi = multifeed(ram, { valueEncoding: 'json' })

  multi.writer('bob', function (err, w) {
    t.error(err, 'valid writer created')
    multi.writer('bob', function (err, w2) {
      t.error(err, 'valid writer retrieved')
      t.deepEquals(w2, w, 'writer is the same as retrieved feed')
    })
  })
})

test('replicate two empty multifeeds', function (t) {
  t.plan(3)

  var m1 = multifeed(ram, { valueEncoding: 'json' })
  var m2 = multifeed(ram, { valueEncoding: 'json' })

  m1.ready(function () {
    m2.ready(function () {
      var r = m1.replicate(true)
      r.pipe(m2.replicate(false)).pipe(r)
        .once('end', check)
        .once('remote-feeds', function () {
          t.ok(true, 'got "remote-feeds" event')
        })
    })
  })

  function check () {
    t.equals(m1.feeds().length, 0)
    t.equals(m2.feeds().length, 0)
  }
})

test('replicate two multifeeds', function (t) {
  t.plan(26)

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
      var r1 = m1.replicate(true)
      var r2 = m2.replicate(false)
      r1.pipe(r2).pipe(r1)
        .once('end', check)
      r1.once('remote-feeds', function () {
        t.ok(true, 'got r1 "remote-feeds" event')
        t.equals(m1.feeds().length, 2, 'm1 feeds length is 2')
      })
      r2.once('remote-feeds', function () {
        t.ok(true, 'got r2 "remote-feeds" event')
        t.equals(m2.feeds().length, 2, 'm2 feeds length is 2')
      })
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

test('live replicate two multifeeds', function (t) {
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
      var r = m1.replicate(true, {live:true})
      r.pipe(m2.replicate(false, {live:true})).pipe(r)
      setTimeout(check, 1000)
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
  var multi = multifeed(storage, { valueEncoding: 'json' })

  multi.writer('minuette', function (err, w) {
    t.error(err)
    t.ok(w.key)

    multi.close(function () {
      var multi2 = multifeed(storage, { valueEncoding: 'json' })
      multi2.writer('minuette', function (err, w2) {
        t.error(err)
        t.ok(w.key)
        t.deepEquals(w2.key, w.key, 'keys match')
      })
    })
  })
})

test('close', function (t) {
  var storage = tmp()
  var multi = multifeed(storage, { valueEncoding: 'json' })

  multi.writer('minuette', function (err, w) {
    t.error(err)

    multi.close(function () {
      t.deepEquals(multi.feeds(), [], 'no feeds present')
      t.equals(multi.closed, true)
      rimraf(storage, function (err) {
        t.error(err, 'Deleted folder without error')
        t.end()
      })
    })
  })
})

test('close after double-open', function (t) {
  var storage = tmp()

  openWriteClose(function (err) {
    t.error(err)
    openWriteClose(function (err) {
      t.error(err)
      rimraf(storage, function (err) {
        t.error(err, 'Deleted folder without error')
        t.end()
      })
    })
  })

  function openWriteClose (cb) {
    var multi = multifeed(storage, { valueEncoding: 'json' })
    multi.writer('minuette', function (err, w) {
      t.error(err)
      w.append({type: 'node'}, function (err) {
        t.error(err)
        multi.close(cb)
      })
    })
  }
})

test('can provide custom encryption key', function (t) {
  t.plan(2)

  var key = crypto.keyPair().publicKey
  var multi = multifeed(ram, { valueEncoding: 'json', encryptionKey: key })
  multi.ready(function () {
    t.same(multi._opts.encryptionKey, key, 'encryption key set')
    t.same(multi._root.key, key, 'fake key set')
  })
})

test('replicate slow-to-open multifeeds', function (t) {
  t.plan(22)

  function slow (delay) {
    return function (name) {
      return ral([delay,delay], ram())
    }
  }

  var m1 = multifeed(slow(100), { valueEncoding: 'json' })
  var m2 = multifeed(slow(100), { valueEncoding: 'json' })

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

test('can create writer with custom keypair', function (t) {
  t.plan(7)

  const keypair = {
    publicKey: Buffer.from('ce1f0639f6559736d5c98f9df9af111ff20f0980674297e4eb40cc8f00f1157e', 'hex'),
    secretKey: Buffer.from('559f807745b2dd136ec96ebdffa81f0631bfc4bc6ee4bc86f5666b24db91665ace1f0639f6559736d5c98f9df9af111ff20f0980674297e4eb40cc8f00f1157e', 'hex')
  }

  var multi = multifeed(ram, { valueEncoding: 'json' })
  multi.ready(function () {
    multi.writer('moose', { keypair }, function (err, w) {
      t.error(err, 'valid writer created')
      t.same(w.key.toString('hex'), keypair.publicKey.toString('hex'), 'public keys match')
      t.same(w.secretKey.toString('hex'), keypair.secretKey.toString('hex'), 'secret keys match')
      w.append('foo', function (err) {
        t.error(err, 'no error when appending to feed')
        w.get(0, function (err, data) {
          t.error(err)
          t.equals(data.toString(), 'foo')
          t.deepEquals(multi.feeds(), [w])
        })
      })
    })
  })
})

test('can replicate with custom keypairs', function (t) {
  t.plan(16)

  const keypair1 = {
    publicKey: Buffer.from('731e8277432cad15c39f275de593a50cf2e689b0139f2d1ad2a130b84a8b1407', 'hex'),
    secretKey: Buffer.from('bf54c2aa004c76e7575839ff1fd7c242f9ba14b019afeed0e0536a6c3483e78c731e8277432cad15c39f275de593a50cf2e689b0139f2d1ad2a130b84a8b1407', 'hex')
  }

  const keypair2 = {
    publicKey: Buffer.from('ce1f0639f6559736d5c98f9df9af111ff20f0980674297e4eb40cc8f00f1157e', 'hex'),
    secretKey: Buffer.from('559f807745b2dd136ec96ebdffa81f0631bfc4bc6ee4bc86f5666b24db91665ace1f0639f6559736d5c98f9df9af111ff20f0980674297e4eb40cc8f00f1157e', 'hex')
  }

  var m1 = multifeed(ram, { valueEncoding: 'json' })
  var m2 = multifeed(ram, { valueEncoding: 'json' })

  setup(m1, keypair1, 'foo', () => {
    setup(m2, keypair2, 'bar', (r) => {
      var r = m1.replicate(true)
      r.pipe(m2.replicate(false)).pipe(r)
        .once('end', check)
    })
  })

  function setup (m, keypair, buf, cb) {
    m.writer('local', { keypair }, function (err, w) {
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

  function check () {
    t.equals(m1.feeds().length, 2)
    t.equals(m2.feeds().length, 2)
    m1.feeds()[1].get(0, function (err, data) {
      t.error(err)
      t.equals(data, 'foo')
    })
    m2.feeds()[1].get(0, function (err, data) {
      t.error(err)
      t.equals(data, 'bar')
    })
  }
})
