var raf = require('random-access-file')
var path = require('path')
var protocol = require('hypercore-protocol')
var through = require('through2')
var pumpify = require('pumpify')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')
var debug = require('debug')('multifeed')

var PROTOCOL_VERSION = '1.0.0'

module.exports = Multifeed

function Multifeed (hypercore, storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(hypercore, storage, opts)

  this._feeds = {}
  this._feedKeyToFeed = {}

  this._hypercore = hypercore
  this._opts = opts

  this.writerLock = mutexify()

  this.closed = false

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
    var feed = hypercore(self._storage('fake'), publicKey)
    feed.ready(function () {
      self._fake = feed
      self._loadFeeds(function () {
        debug('[INIT] finished loading feeds')
        done()
      })
    })
  })
}

inherits(Multifeed, events.EventEmitter)

Multifeed.prototype._addFeed = function (feed, name) {
  this._feeds[name] = feed
  this._feedKeyToFeed[feed.key.toString('hex')] = feed
  feed.setMaxListeners(256)
  this.emit('feed', feed, name)
}

Multifeed.prototype.ready = function (cb) {
  this._ready(cb)
}

Multifeed.prototype.close = function (cb) {
  var self = this

  this.writerLock(function (release) {
    function done (err) {
      release(function () {
        if (!err) self.closed = true
        cb(err)
      })
    }

    var feeds = values(self._feeds)

    function next (n) {
      if (n >= feeds.length) {
        self._feeds = []
        return done()
      }
      feeds[n].close(function (err) {
        if (err) return done(err)
        next(++n)
      })
    }

    next(0)
  })
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
        feed.ready(function () {
          self._addFeed(feed, String(idx))
          release(function () {
            cb(null, feed, idx)
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

Multifeed.prototype.replicate = function (opts) {
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

  var firstWrite = true
  var writeStream = through(function (buf, _, next) {
    if (firstWrite) {
      firstWrite = false
      debug('[REPLICATION] able to share ' + values(self._feeds).length + ' keys')
      var keys = values(self._feeds).map(function (feed) { return feed.key.toString('hex') })
      var headerBuf = serializeHeader(PROTOCOL_VERSION, keys)
      this.push(headerBuf)
    }
    this.push(buf)
    next()
  })

  var readingHeader = true
  var headerAccum = Buffer.alloc(0)
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
          addMissingKeys(header.keys, function () {
            // push remainder of buffer
            var leftover = headerAccum.slice(expectedLen + 4)
            self.unshift(leftover)
            debug('[REPLICATION] starting hypercore replication')
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
      feed.replicate(opts)
    })
  }

  function onready (err) {
    if (err) return stream.destroy(err)
    if (stream.destroyed) return

    self._fake.replicate(opts)
  }
}

function serializeHeader (version, keys) {
  var header = {
    version: version,
    keys: keys
  }
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

// String, String -> Boolean
function compatibleVersions (v1, v2) {
  var major1 = v1.split('.')[0]
  var major2 = v2.split('.')[0]
  return parseInt(major1) === parseInt(major2)
}

function values (obj) {
  return Object.keys(obj).map(function (k) { return obj[k] })
}
