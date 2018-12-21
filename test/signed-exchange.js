var test = require('tape')
var hypercore = require('hypercore')
var crypto = require('hypercore-crypto')
var multifeed = require('..')
var ram = require('random-access-memory')
var debug = require('debug')('multifeed/sigex')

test('Signature store serialization', function(t) {
  t.plan(4)
  var pair = crypto.keyPair()
  var m = multifeed(hypercore, ram,{restricted: true, valueEncoding: 'json' })
  m.ready(function(){
    m._setFeedSig('foo', 'bar', function(err) {
      t.error(err)
      t.equal(m._signatures['foo'], 'bar', 'New signature visible after set')
      delete m._signatures // simulate loss of in-memory sighash
      // test recovering signatures hash from storage
      m._loadSignatures(function(err) {
        t.error(err)
        t.equal(m._signatures['foo'], 'bar', 'Signatures loaded correctly')
      })
    })
  })
})

test('replicate signature aware multifeeds', function (t) {
  t.plan(23)
  // Given a preshared keypair that can be derived
  // from a secret phrase or generated and then
  // shared.
  var pair = crypto.keyPair()
  debug('Performing test using publicKey:', pair.publicKey.toString('hex'), ' private:', pair.secretKey.toString('hex'))
  // All three use the same public key, but only two of them know the private key.
  var computer = null
  var laptop = null
  var hashbase = null
  var unsignedFeed = null

  function spawnMultiFeed(opts, cb) {
    var haveSecret = !!opts.secretKey
    var m = multifeed(hypercore, ram, Object.assign({ valueEncoding: 'json'},opts))
    var buf = "dummy"

    m.once('feed', function (feed, name) {
      if (haveSecret) {
        let signature = m._signatures[feed.key.toString('hex')]
        t.ok(signature, 'Should have a signature')
        t.ok(crypto.verify(feed.key, Buffer.from(signature, 'hex'), m._fake.key), 'signature should be verified')
      } else {
        // Should still produce the feed, but it will not be replicated anywhere.
        t.equal(feed.key.length, 32)
        unsignedFeed = feed.key.toString('hex')
      }
    })

    m.writer(function (err, w) {
      t.error(err)
      t.ok(w.secretKey, 'Should be writeable regardless of signed state')
      w.append(buf, function (err) {
        t.error(err)
        w.get(0, function (err, data) {
          t.error(err)
          t.equals(data, buf)
          cb()
        })
      })
    })
    // t.deepEquals(m.feeds(), [w])
    return m
  }

  function replicate(a, b, cb) {
    var r = a.replicate()
    r.pipe(b.replicate()).pipe(r)
      .once('end', cb)
  }

  function fkeys(a) {
    return a.map(function(f) { return f.key.toString('hex') }).sort()
  }

  computer = spawnMultiFeed({restricted: true, key: pair.publicKey, secretKey: pair.secretKey }, function(){
    laptop = spawnMultiFeed({restricted: true, key: pair.publicKey, secretKey: pair.secretKey }, function(){
      hashbase = spawnMultiFeed({restricted: true, key: pair.publicKey },function () {

        var unsignedFeed = fkeys(hashbase.feeds())[0]
        var signedFeeds = fkeys([].concat(computer.feeds()).concat(laptop.feeds()))
        var allFeeds = [unsignedFeed].concat(signedFeeds).sort()

        replicate(computer, laptop, function() {
          replicate(hashbase, laptop, function() {
            debugger
            t.deepEquals(fkeys(computer.feeds()), signedFeeds)
            t.deepEquals(fkeys(laptop.feeds()), signedFeeds)
            t.deepEquals(fkeys(hashbase.feeds()), allFeeds)
          })
        })

      })
    })
  })

})
