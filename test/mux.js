var test = require('tape')
var hypercore = require('hypercore')
var ram = require('random-access-memory')
var multiplexer = require('../mux.js')
var pump = require('pump')
var through = require('through2')
var debug = require('debug')('multifeed/protodump')

test('key exchange API', function(t){
  t.plan(6)
  var encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef') // used to encrypt the connection

  var mux1 = multiplexer(true, encryptionKey)
  var mux2 = multiplexer(false, encryptionKey)

  mux1.ready(function(client){
    mux2.on('manifest', function(m, req) {
      t.ok(m.keys instanceof Array, 'Manifest contains an array of feed keys')
      t.deepEqual(m.keys, ['A', 'B', 'C'])
      req(['A','C','X'])
    })
    var countEv = 0

    // replicate event init missing:
    mux1.on('replicate', function(keys, repl) {
      t.deepEqual(keys, ['A','C'], 'List of filtered keys to initialize')
      t.equal(typeof repl, 'function')
      if (++countEv == 2) t.end()
    })
    mux2.on('replicate', function(keys, repl) {
      t.deepEqual(keys, ['A','C'], 'List of filtered keys to initialize')
      t.equal(typeof repl, 'function')
      if (++countEv == 2) t.end()
    })
    mux1.offerFeeds(['A', 'B', 'C'])
  })
  mux1.on('finalize', t.error)
  pump(mux1.stream,mux2.stream,mux1.stream)
})

test('regression: ensure we\'re receiving remote handshake', function(t){
  t.plan(2)
  var encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef') // used to encrypt the connection

  var id1 = Math.random()
  var id2 = Math.random()
  var mux1 = multiplexer(true, encryptionKey, { userData: id1 })
  var mux2 = multiplexer(false, encryptionKey, { userData: id2 })

  mux1.once('ready', function (header) {
    t.equal(header.userData, id2)
  })
  mux2.once('ready', function (header) {
    t.equal(header.userData, id1)
  })

  pump(mux1.stream, mux2.stream, mux1.stream)
})
