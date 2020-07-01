var test = require('tape')
var crypto = require('hypercore-crypto')
var Protocol = require('hypercore-protocol')
var multifeed = require('..')
var ram = require('random-access-memory')
var ral = require('random-access-latency')
var tmp = require('tmp').tmpNameSync
var rimraf = require('rimraf')

test('replicate from existing protocols', function (t) {
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
      var p1 = new Protocol(true)
      var p2 = new Protocol(false)
      var r1 = m1.replicate(p1)
      var r2 = m2.replicate(p2)
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

test('live replicate from existing protocols', function (t) {
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
      var p1 = new Protocol(true)
      var p2 = new Protocol(false)
      var r = m1.replicate(p1, {live:true})
      r.pipe(m2.replicate(p2, {live:true})).pipe(r)
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
