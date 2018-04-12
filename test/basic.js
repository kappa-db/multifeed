var test = require('tape')
var hypercore = require('hypercore')
var multicore = require('..')
var ram = require('random-access-memory')

test('no feeds', function (t) {
  var multi = multicore(hypercore, ram, { valueEncoding: 'json' })

  t.deepEquals(multi.feeds(), [])
  t.end()
})

test('create writer', function (t) {
  t.plan(5)

  var multi = multicore(hypercore, ram, { valueEncoding: 'json' })

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

test('replicate two multicores', function (t) {
  t.plan(16)

  var m1 = multicore(hypercore, ram, { valueEncoding: 'json' })
  var m2 = multicore(hypercore, ram, { valueEncoding: 'json' })

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
  }
})
