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
var multiplex = require('./multiplex')

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
  var mux = multiplex()
}
Multifeed.prototype.__old_replicate = function (opts) {
  if (!opts) opts = {}

  var self = this
  opts.expectedFeeds = Object.keys(this._feeds).length + 1
  var expectedFeeds = opts.expectedFeeds

  opts.encrypt = false
  opts.stream = protocol(opts)

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
          debugger
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
  
  // ------------------ rewrite

  var firstWrite = true
  var writeStream = through(function (buf, _, next) {
    if (firstWrite) {
      firstWrite = false
      debug('[REPLICATION] able to share ' + values(self._feeds).length + ' keys')
      var keys = values(self._feeds).map(function (feed) { return feed.key.toString('hex') })
      var headerBuf = serializeHeader(PROTOCOL_VERSION, keys, self._signatures)
      this.push(headerBuf)
    }
    // Pass traffic through to next stream
    this.push(buf)
    next()
  })

  var readingHeader = true
  var headerAccum = Buffer.alloc(0)

  var selfMultifeed = this
  var readStream = through(function (buf, _, next) {
    var self = this
    if (readingHeader) {
      headerAccum = Buffer.concat([headerAccum, buf])
      if (headerAccum.length <= 0) return next()
      var expectedLen = headerAccum.readUInt32LE(0)
      if (headerAccum.length >= expectedLen + 4) {
        readingHeader = false
        try {
          var header = deserializeHeader(headerAccum)
          debug('[REPLICATION] recv\'d header: ' + JSON.stringify(header))
          if (!compatibleVersions(header.version, PROTOCOL_VERSION)) {
            debug('[REPLICATION] aborting; version mismatch (us='+PROTOCOL_VERSION+')')
            self.emit('error', new Error('protocol version mismatch! us='+PROTOCOL_VERSION + ' them=' + header.version))
            return
          }

          var keys = header.keys
          if (selfMultifeed._restrictedMode) { // limit replication to verified keys
            keys = selfMultifeed._filterSignedKeys(keys, header.signatures)
          }

          addMissingKeys(keys, function () {
            // push remainder of buffer
            var leftover = headerAccum.slice(expectedLen + 4)
            self.unshift(leftover)
            debug('[REPLICATION] starting hypercore replication')
            debugger
            process.nextTick(startSync)
            next()
          })
        } catch (e) {
          debug('[REPLICATION] aborting (bad header)')
          self.emit('error', e)
          return
        }
      } else {
        next()
      }
    } else {
      this.push(buf)
      next()
    }
  })

  var stream = pumpify(readStream, opts.stream, writeStream)

  if (!opts.live) {
    opts.stream.on('prefinalize', function (cb) {
      var numFeeds = Object.keys(self._feeds).length + 1
      opts.stream.expectedFeeds += (numFeeds - expectedFeeds)
      expectedFeeds = numFeeds
      cb()
    })
  }

  this.ready(onready)

  return stream

  function startSync () {
    var sortedFeeds = values(self._feeds).sort(cmp)
    function cmp (a, b) {
      return a.key.toString('hex') > b.key.toString('hex')
    }
    sortedFeeds.forEach(function (feed) {
      debug('[REPLICATION] replicating ' + feed.key.toString('hex'))
      debugger
      feed.replicate(opts)
    })
  }

  function onready (err) {
    if (err) return stream.destroy(err)
    if (stream.destroyed) return

    self._fake.replicate(opts)
  }
} // End of replicate

function serializeHeader (version, keys, signatures) {
  var header = {
    version: version,
    keys: keys
  }
  if (signatures) header.signatures = signatures

  var json = JSON.stringify(header)
  debug('[SERIALIZE] header outgoing: ' + json)
  var lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32LE(json.length, 0)
  var jsonBuf = Buffer.from(json, 'utf8')
  return Buffer.concat([
    lenBuf,
    jsonBuf
  ])
}

function deserializeHeader (buf) {
  var len = buf.readUInt32LE(0)
  debug('[SERIALIZE] header len to read: ' + len)
  var jsonBuf = buf.slice(4, len + 4)
  debug('[SERIALIZE] json buf to read: ' + jsonBuf.toString())
  return JSON.parse(jsonBuf.toString('utf8'))
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

