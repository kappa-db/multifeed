var test = require('tape')
var hypercore = require('hypercore')
var ram = require('random-access-memory')
var multiplexer = require('../mux.js')
var pump = require('pump')
var through = require('through2')
var debug = require('debug')('multifeed/protodump')

test('Key exchange API', function(t){
  t.plan(19)
  var encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef') // used to encrypt the connection

  var mux1 = multiplexer(encryptionKey, {live: true})
  var mux2 = multiplexer(encryptionKey, {live: true})

  mux1.ready(function(client){
    mux1.haveFeeds(['foo', 'oof', '03', '01'])
  })

  mux2.ready(function(client){
    mux2.haveFeeds(['bar', '02', '01'], {
      signatures: ['sig'],
      custom: 'option'
    })
  })

  var expectedKeys = ['01', '02', '03', 'foo', 'oof']

  mux1.on('manifest', function(m) {
    t.ok(m.keys instanceof Array, 'Manifest contains an array of feed keys')
    t.equal(m.keys[0], 'bar')
    t.ok(m.signatures instanceof Array, 'Manifest contains a hash of signatures')
    t.equal(m.signatures[0], 'sig')
    t.equal(m.custom, 'option')


    mux1.on('replicate', function(keys, repl) {
      // Keys should be alphabetically sorted
      // and identical on both ends.
      for (var i = 0; i < Math.max(keys.length, expectedKeys.length); i++)
        t.equal(keys[i], expectedKeys[i], 'Mux1 Repl key order ' + keys[i])
      t.equal(typeof repl, 'function')
    })

    mux1.wantFeeds('02', 'oof') // pick some of the remote's keys excluding 'bar'
  })

  mux2.on('manifest', function(m) {
    t.equal(m.keys[0], 'foo')
    t.equal(m.keys[1], 'oof')
    mux2.on('replicate', function(keys, repl) {
      for (var i = 0; i < Math.max(keys.length, expectedKeys.length); i++)
        t.equal(keys[i], expectedKeys[i], 'Mux2 Repl key order ' + keys[i])
      t.equal(typeof repl, 'function')
    })

    mux2.wantFeeds(m.keys) // mark all remote keys as 'want' for classical multicore behaviour
  })


  pump(
    mux1.stream(),
    through(function(chunk, _, next) {
      debug("MUX1->MUX2", chunk.toString('utf8'))
      this.push(chunk)
      next()
    }),
    mux2.stream(),
    through(function(chunk, _, next) {
      debug("MUX2->MUX1", chunk.toString('utf8'))
      this.push(chunk)
      next()
    }),
    mux1.stream()
  )

})

test('Actual replication', function(t) {
  t.plan(9)
  var encryptionKey = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeef') 
  var h1 = hypercore(ram)
  var h2 = hypercore(ram)
  var h3 = hypercore(ram)

  // Initial cores
  function setup(cb) {
    h1.ready(function() {
      h1.append('hyper',function(err){
        t.error(err)
        h2.ready(function(){
          h2.append('sea', function(err){
            t.error(err)
            h3.ready(function(){
              h3.append('late to the party', function(err){
                t.error(err)
                cb()
              })
            })
          })
        })
      })
    })
  }

  var mux1 = multiplexer(encryptionKey, {live: true})
  var mux2 = multiplexer(encryptionKey, {live: true})

  mux1.on('manifest', function(m){
    var r = hypercore(ram, h2.key.toString('hex'))
    r.on('download',function(index, data){
      t.equal(data.toString('utf8'), 'sea', 'h2 repl')
      t.equal(index, 0)
    })

    var r2 = hypercore(ram, h3.key.toString('hex'))
    r2.on('download',function(index, data){
      t.equal(data.toString('utf8'), 'late to the party', 'h3 repl')
      t.equal(index, 0)
    })
    mux1.on('replicate', function(keys, repl) {
      repl([r, h1, r2])
    })
    mux1.wantFeeds(m.keys)
  })

  mux2.on('manifest', function(m) {
    var r = hypercore(ram, m.keys[0])
    r.on('download',function(index, data){
      t.equal(data.toString('utf8'), 'hyper', 'h1 repl')
      t.equal(index, 0)
    })
    mux2.on('replicate', function(keys, repl) {
      repl([r, h2, h3])
    })
    mux2.wantFeeds(m.keys)
  })


  setup(function(){
    mux1.ready(function(client){
      mux1.haveFeeds([h1])
    })
    mux2.ready(function(client){
      mux2.haveFeeds([h2,h3])
    })
  })

  pump(
    mux1.stream(),
    through(function(chunk, _, next) {
      debug("MUX1->MUX2", chunk.toString('utf8'))
      this.push(chunk)
      next()
    }),
    mux2.stream(),
    through(function(chunk, _, next) {
      debug("MUX2->MUX1", chunk.toString('utf8'))
      this.push(chunk)
      next()
    }),
    mux1.stream()
  )
})
