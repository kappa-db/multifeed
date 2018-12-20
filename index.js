var raf = require('random-access-file')
var path = require('path')
var protocol = require('hypercore-protocol')
var through = require('through2')
var pumpify = require('pumpify')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')
var crypto = require('hypercore-crypto')
var debug = require('debug')('multifeed')
var multiplexer = require('./mux')

var PROTOCOL_VERSION = '2.0.0'
var FEED_SIGNATURES_JSON = 'feed_signatures.json'

module.exports = Multifeed

function Multifeed (hypercore, storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(hypercore, storage, opts)
  this._feeds = {}
  this._feedKeyToFeed = {}

  this._hypercore = hypercore
  this._opts = opts

  this.writerLock = mutexify()
  this._restrictedMode = !!this._opts.restricted
  delete this._opts.restricted

  if (this._restrictedMode) {
    this._signatures = {}
    if (typeof storage === 'string') this._sigStore = raf(path.join(storage, FEED_SIGNATURES_JSON))
    else this._sigStore = storage(FEED_SIGNATURES_JSON)
  }

  // random-access-storage wrapper that wraps all hypercores in a directory
  // structures. (dir/0, dir/1, ...)
  this._storage = function (dir) {
    return function (name) {
      var s = storage
      if (typeof storage === 'string') return raf(path.join(storage, dir, name))
      else return s(dir + '/' + name)
    }
  }


  var self = this
  this._ready = readyify(function (done) {
    // Private key-less constant hypercore to bootstrap hypercore-protocol
    // replication.
    var publicKey = new Buffer('bee80ff3a4ee5e727dc44197cb9d25bf8f19d50b0f3ad2984cfe5b7d14e75de7', 'hex')
    var feed = null

    if (!self._restrictedMode) {
      feed = hypercore(self._storage('_fake'), publicKey)

      // TODO: It seem's I wrongly assumed that the fake feed was stored, fix initializing
      // previously created restricted-multifeed.
    } else { // if (self._restrictedMode && opts.key) {
      // Initialize new fake-core in restricted mode holding the signing key(s)
      var secret = self._opts.secretKey ? Buffer.from(self._opts.secretKey) : undefined
      var key = self._opts.key ? Buffer.from(self._opts.key) : publicKey
      feed = hypercore(self._storage('_fake'), key, {secretKey: secret})

      // Remove options which have fullfilled their purpose so they
      // don't accidentally get passed to other writers
      delete self._opts.secretKey
      delete self._opts.key
    } // else wait for self._loadFeeds to load previously provided signing keys


    feed.ready(function () {
      self._fake = feed
      self._loadFeeds(function () {
        debug('[INIT] finished loading feeds')
        if (self._restrictedMode) self._loadSignatures(done)
        else done()
      })
    })
  })
}

inherits(Multifeed, events.EventEmitter)

Multifeed.prototype._addFeed = function (feed, name) {
  this._feeds[name] = feed
  this._feedKeyToFeed[feed.key.toString('hex')] = feed
  this.emit('feed', feed, name)
}

Multifeed.prototype.ready = function (cb) {
  this._ready(cb)
}

Multifeed.prototype._loadFeeds = function (cb) {
  var self = this

  // Hypercores are stored starting at 0 and incrementing by 1. A failed read
  // at position 0 implies non-existance of the hypercore.
  function next (n) {
    debug('[INIT] loading feed #' + n)
    var storage = self._storage(''+n)
    var st = storage('key')
    st.read(0, 4, function (err) {
      if (err) return cb()
      var feed = self._hypercore(storage, self._opts)
      feed.ready(function () {
        readStringFromStorage(storage('localname'), function (err, name) {
          if (!err && name) {
            self._addFeed(feed, name)
          } else {
            self._addFeed(feed, String(n))
          }
          next(n+1)
        })
      })
    })
  }

  next(0)
}

Multifeed.prototype.writer = function (name, cb) {
  if (typeof name === 'function' && !cb) {
    cb = name
    name = undefined
  }
  var self = this

  this.ready(function () {
    // Short-circuit if already loaded
    if (self._feeds[name]) {
      process.nextTick(cb, null, self._feeds[name])
      return
    }

    debug('[WRITER] creating new writer: ' + name)

    self.writerLock(function (release) {
      var len = Object.keys(self._feeds).length
      var storage = self._storage(''+len)

      var idx = name || String(len)

      var nameStore = storage('localname')
      writeStringToStorage(idx, nameStore, function (err) {
        if (err) {
          release(function () {
            cb(err)
          })
          return
        }

        var feed = self._hypercore(storage, self._opts)

        // Create and store signature for the writer
        function signWriter (done) {
          if (!self._restrictedMode) {
            done() // short-circuit when not using restricted mode.
          } else {
            if (!self._fake.secretKey) {
              debug('WARNING: no private key available, creating unsigned writer in restricted mode')
              done()
            } else {
              // Sign the feed using provided private key
              var sig = crypto.sign(feed.key, self._fake.secretKey)
              debug("Signing new writer", feed.key.toString('hex'), sig.toString('hex'))

              // Verify the signature
              if (!crypto.verify(feed.key, sig, self._fake.key)) {
                done(new Error('Invalid signature produced, have you provided a correct key pair?'))
              }

              // Store the signature
              self._setFeedSig(feed.key, sig, done)
            }
          }
        }

        feed.ready(function () {
          signWriter(function(err) {
            self._addFeed(feed, String(idx))
            release(function () {
              if (err) cb(err)
              else cb(null, feed, idx)
            })
          })
        })
      })
    })
  })
}

Multifeed.prototype.feeds = function () {
  return values(this._feeds)
}

Multifeed.prototype.feed = function (key) {
  if (Buffer.isBuffer(key)) key = key.toString('hex')
  if (typeof key === 'string') return this._feedKeyToFeed[key]
  else return null
}

Multifeed.prototype._loadSignatures = function (done) {
  // Short circuit if this is an unrestricted multifeed
  if (!this._restrictedMode) return done()
  var self = this
  self._signatures = {}
  self._sigStore.read(0,4,function(err, chunk) {
    if (err) {
      debug('Loading signatures failed, this is normal for empty multifeeds', err.message)
      return done()
    }
    var size = chunk.readUInt32LE()
    self._sigStore.read(4, size, function(err, chunk) {
      if (err) return done(err)
      self._signatures = JSON.parse(chunk.toString('utf8'))
      done(null, self._signatures)
    })
  })
}

Multifeed.prototype._setFeedSig = function (key, sig, cb) {
  if (Buffer.isBuffer(key)) key = key.toString('hex')
  if (Buffer.isBuffer(sig)) sig = sig.toString('hex')

  var self = this
  self._signatures = self._signatures || {}

  self._signatures[key] = sig
  var sigBuf = Buffer.from(JSON.stringify(self._signatures))
  var sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32LE(sigBuf.length)

  self._sigStore.write(0, sizeBuf, function(err) {
    if (err) return cb(err)
    self._sigStore.write(4, sigBuf, cb)
  })
}

Multifeed.prototype._filterSignedKeys = function(keys, signatures) {
  if(!this._restrictedMode) return keys // Perform no signature filtering
  var self = this
  return keys.filter(function(key) {
    let sig = signatures[key] || self._signatures[key]
    if (!sig || sig.length !== 128) return false // couldn't find a valid signature
    return crypto.verify(Buffer.from(key, 'hex'), Buffer.from(sig, 'hex'), self._fake.key) // verify signature
  })
}

Multifeed.prototype.replicate = function (opts) {
  if (!opts) opts = {}
  var self = this
  var mux = multiplexer(self._fake.key, opts)

  // Add key exchange listener
  mux.once('manifest', function(m) {
    let filtered = self._filterSignedKeys(m.keys, m.signatures)
    mux.wantFeeds(filtered)
  })

  // Add replication listener
  mux.once('replicate', function(keys, repl) {
    addMissingKeys(keys, function(err){
      if(err) return mux.destroy(err)

      var key2feed = values(self._feeds).reduce(function(h,feed){
        h[feed.key.toString('hex')] = feed
        return h
      },{})
      var sortedFeeds = keys.map(function(k){ return key2feed[k] })
      repl(sortedFeeds)
    })
  })

  // Start streaming
  this.ready(function(err){
    if (err) return mux.stream.destroy(err)
    if (mux.stream.destroyed) return
    mux.ready(function(){
      var keys = values(self._feeds).map(function (feed) { return feed.key.toString('hex') })
      var extras = {}
      if (this._signatures) extras.signatures = this._signatures
      mux.haveFeeds(keys, extras)
    })
  })

  return mux.stream

  // Helper functions

  function addMissingKeys (keys, cb) {
    self.ready(function (err) {
      if (err) return cb(err)
      self.writerLock(function (release) {
        addMissingKeysLocked(keys, function (err) {
          release(cb, err)
        })
      })
    })
  }

  function addMissingKeysLocked (keys, cb) {
    var pending = 0
    debug('[REPLICATION] recv\'d ' + keys.length + ' keys')
    var filtered = keys.filter(function (key) {
      return !Number.isNaN(parseInt(key, 16)) && key.length === 64
    })
    filtered.forEach(function (key) {
      var feeds = values(self._feeds).filter(function (feed) {
        return feed.key.toString('hex') === key
      })
      if (!feeds.length) {
        pending++
        var numFeeds = Object.keys(self._feeds).length
        var storage = self._storage(''+numFeeds)
        var feed
        try {
          debug('[REPLICATION] trying to create new local hypercore, key=' + key.toString('hex'))
          feed = self._hypercore(storage, Buffer.from(key, 'hex'), self._opts)
        } catch (e) {
          debug('[REPLICATION] failed to create new local hypercore, key=' + key.toString('hex'))
          if (!--pending) cb()
          return
        }
        debug('[REPLICATION] succeeded in creating new local hypercore, key=' + key.toString('hex'))
        self._addFeed(feed, String(numFeeds))
        feed.ready(function () {
          if (!--pending) cb()
        })
      }
    })
    if (!pending) cb()
  }
}

function writeJsonToStorage (obj, storage, cb) {
  writeStringToStorage(JSON.stringify(obj), storage, cb)
}

function readJsonFromStorage (storage, cb) {
  readStringFromStorage(storage, function (err, text) {
    if (err) return cb(err)
    try {
      var obj = JSON.parse(text)
      cb(null, obj)
    } catch (e) {
      cb(e)
    }
  })
}

// TODO: what if the new data is shorter than the old data? things will break!
function writeStringToStorage (string, storage, cb) {
  var buf = Buffer.from(string, 'utf8')
  storage.write(0, buf, cb)
}

function readStringFromStorage (storage, cb) {
  storage.stat(function (err, stat) {
    if (err) return cb(err)
    var len = stat.size
    storage.read(0, len, function (err, buf) {
      if (err) return cb(err)
      var str = buf.toString()
      cb(null, str)
    })
  })
}


function values (obj) {
  return Object.keys(obj).map(function (k) { return obj[k] })
}

