var raf = require('random-access-file')
var path = require('path')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')
var through = require('through2')
var debug = require('debug')('multifeed')
var replic8 = require('replic8')

// Key-less constant hypercore to bootstrap hypercore-protocol replication.
var defaultEncryptionKey = new Buffer('bee80ff3a4ee5e727dc44197cb9d25bf8f19d50b0f3ad2984cfe5b7d14e75de7', 'hex')

module.exports = Multifeed

function Multifeed (hypercore, storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(hypercore, storage, opts)
  this._id = (opts||{})._id || Math.floor(Math.random() * 1000).toString(16)  // for debugging
  this._feeds = {}
  this._feedKeyToFeed = {}
  this._streams = []
  this._replicationManager = null

  opts = opts || {}
  this.headerOrigin = opts.headerOrigin || 'multifeed'

  // Support legacy opts.key
  if (opts.key) opts.encryptionKey = opts.key

  this._hypercore = hypercore
  this._opts = opts

  this.writerLock = mutexify()

  this._close = readyify(_close.bind(this), true)
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
    var encryptionKey = defaultEncryptionKey
    if (self._opts.encryptionKey) {
      if (typeof self._opts.encryptionKey === 'string') encryptionKey = Buffer.from(self._opts.encryptionKey, 'hex')
      else encryptionKey = self._opts.encryptionKey
    } else {
      debug(self._id + ' Warning, running multifeed with unsecure default key')
    }

    debug(self._id, 'Using encryption key:', encryptionKey.toString('hex'))

    var storageName = encryptionKey.toString('hex')
    var feed = hypercore(self._storage(storageName), encryptionKey)

    feed.on('error', function (err) {
      self.emit('error', err)
    })

    feed.ready(function () {
      self._root = feed
      self._loadFeeds(function (err) {
        if (err) {
          debug(self._id + ' [INIT] failed to load feeds: ' + err.message)
          self.emit('error', err)
          return
        }
        debug(self._id + ' [INIT] finished loading feeds')
        done()
      })
    })
  })

  this.setMaxListeners(Infinity)
}

inherits(Multifeed, events.EventEmitter)

Multifeed.prototype._addFeed = function (feed, name) {
  this._feeds[name] = feed
  this._feedKeyToFeed[feed.key.toString('hex')] = feed
  feed.setMaxListeners(Infinity)
  this.emit('feed', feed, name)
}

Multifeed.prototype.ready = function (cb) {
  this._ready(cb)
}

Multifeed.prototype.close = function (cb) {
  if (typeof cb !== 'function') cb = function noop () {}
  return this._close(cb)
}

function _close (cb) {
  var self = this
  this.writerLock(function (release) {
    function done (err) {
      release(function () {
        if (!err) self.closed = true
        cb(err)
      })
    }

    var feeds = values(self._feeds).concat(self._root)

    function next (n) {
      if (n >= feeds.length) {
        self._feeds = []
        self._root = undefined
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
  var pending = 1
  function next (n) {
    var storage = self._storage(''+n)
    var st = storage('key')
    st.read(0, 4, function (err) {
      if (err) return done()  // means there are no more feeds to read
      debug(self._id + ' [INIT] loading feed #' + n)
      pending++
      var feed = self._hypercore(storage, self._opts)
      process.nextTick(next, n + 1)

      feed.ready(function () {
        readStringFromStorage(storage('localname'), function (err, name) {
          if (!err && name) {
            self._addFeed(feed, name)
          } else {
            self._addFeed(feed, String(n))
          }
          st.close(function (err) {
            if (err) return done(err)
            debug(self._id + ' [INIT] loaded feed #' + n)
            done()
          })
        })
      })
    })
  }

  function done (err) {
    if (err) {
      pending = Infinity
      return cb(err)
    }
    if (!--pending) cb()
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

    debug(self._id + ' [WRITER] creating new writer: ' + name)

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
            if (err) cb(err)
            else cb(null, feed, idx)
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

/**
 * Multifeed implements middleware interface
 */

// Share all feeds
Multifeed.prototype.share = function (next) {
  if (this.closed) return next()

  var self = this
  this.ready(function () {
    var feeds = self.feeds()
    next(null, feeds)
  })
}

// Tag all our own feeds with 'origin' header
Multifeed.prototype.describe = function (ctx, next) {
  if (this.closed) return next()

  var self = this
  this.ready(function () {
    if (self.feed(ctx.key)) next(null, { origin: self.headerOrigin })
    else next() // don't care about unknown keys.
  })
}

// Accept all feeds with correct 'origin' header
// initializes new feeds if missing
Multifeed.prototype.accept = function (ctx, next) {
  if (this.closed) return next()

  var self = this
  var key = ctx.key
  var meta = ctx.meta
  // Ignore non-multifeed feeds
  if (meta.origin !== self.headerOrigin) return next()

  this.ready(function () {
    var feed = self.feed(key)
    // accept the feed if it already exist
    if (feed) return next(null, true)

    // If not, then create the feed and mark it as accepted afterwards.
    self.writerLock(function (release) {
      var keyId = Object.keys(self._feeds).length
      var myKey = String(keyId)
      var storage = self._storage(myKey)
      try {
        debug(self._id + ' [REPLICATION] trying to create new local hypercore, key=' + key.toString('hex'))
        var feed = self._hypercore(storage, Buffer.from(key, 'hex'), self._opts)
        feed.ready(function () {
          self._addFeed(feed, myKey)
          debug(self._id + ' [REPLICATION] succeeded in creating new local hypercore, key=' + key.toString('hex'))
          release(next, null, feed)
        })
      } catch (e) {
        debug(self._id + ' [REPLICATION] failed to create new local hypercore, key=' + key.toString('hex'))
        debug(self._id + e.toString())
        release(next, e) // something went wrong, manager will disconnect the peer.
      }
    })
  })
}

// Provide key to feed lookup for replication and other middleware
Multifeed.prototype.resolve = function (key, next) {
  if (this.closed) return next()

  var self = this
  this.ready(function () {
    next(null, self.feed(key))
  })
}

// Multifeed used to include replication manager capabilities.
// Now it might be included in an external replication stack
// and by storing a reference to the external manager on inclusion
// we can continue to support `replicate()` calls on
// an multifeed instance for the sake of backwards compatibility
Multifeed.prototype.mounted = function (mgr, namespace) {
  if (this._replicationManager && this._replicationManager !== mgr) {
    console.warn('WARNING! Calling multifeed.replicate() is unsafe when used in more than one manager. use mgr.replicate() instead!')
  }
  this._replicationManager = mgr
}
/*
 * End of middleware interface
 */

// Forward .use() call to replicationManger
Multifeed.prototype.use = function (namespace, middleware, prepend) {
  this._lazyInitReplicationManager()
  this._replicationManager.use(namespace, middleware, prepend)
}

Multifeed.prototype._lazyInitReplicationManager = function (opts) {
  if (this._replicationManager) return

  var mgr = replic8(this._root.key, opts)
  // Automatic error logger for backwards compatibility.
  var errLogger = function (err) {
    // Ignore errors if the manager has other error handlers registered.
    if (mgr.listeners('error').find(function (l) { return l !== errLogger })) {
      return
    }

    // If manager dosent have another handler, and neither does this multifeed
    // instance, then log a warning on the console for now.
    // Applications should handle their own errors even if they simply log them.
    if (!this.listeners('error').length) {
      console.warn('WARNING! multifeed will not log errors in the future,' +
        'please add an "error" event listener to either multifeed or your replication manager')
      console.error(err)
    } else {
      // There's an errorhandler registered on this instance.
      // forward the error event
      this.emit('error', err)
    }
  }.bind(this)

  mgr.on('error', errLogger)

  // register multifeed in the replication stack.
  // the mounted() hook above will save the
  // `mgr` instance as this._replicationManager
  mgr.use(this)
}

Multifeed.prototype.replicate = function (opts) {
  if (!this._root) {
    var tmp = through()
    process.nextTick(function () {
      tmp.emit('error', new Error('tried to use "replicate" before multifeed is ready'))
    })
    return tmp
  }

  // Lazy manager initialization / Legacy support
  this._lazyInitReplicationManager(opts)

  // Let replication manager take care of replication
  // requests
  return this._replicationManager.replicate(opts)
}

// TODO: what if the new data is shorter than the old data? things will break!
function writeStringToStorage (string, storage, cb) {
  var buf = Buffer.from(string, 'utf8')
  storage.write(0, buf, function (err) {
    storage.close(function (err2) {
      cb(err || err2)
    })
  })
}

function readStringFromStorage (storage, cb) {
  storage.stat(function (err, stat) {
    if (err) return cb(err)
    var len = stat.size
    storage.read(0, len, function (err, buf) {
      if (err) return cb(err)
      var str = buf.toString()
      storage.close(function (err) {
        cb(err, err ? null : str)
      })
    })
  })
}


function values (obj) {
  return Object.keys(obj).map(function (k) { return obj[k] })
}
