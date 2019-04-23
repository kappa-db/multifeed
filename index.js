var raf = require('random-access-file')
var path = require('path')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')
var debug = require('debug')('multifeed')
var multiplexer = require('./mux')

module.exports = Multifeed

function Multifeed (hypercore, storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(hypercore, storage, opts)
  this._feeds = {}
  this._feedKeyToFeed = {}

  this._hypercore = hypercore
  this._opts = opts || {}
  this._middleware = null
  this.writerLock = mutexify()
  this._middleware = []

  this.key = new Buffer('bee80ff3a4ee5e727dc44197cb9d25bf8f19d50b0f3ad2984cfe5b7d14e75de7', 'hex')
  if (this._opts.key) this.key = Buffer.from(this._opts.key)
  else debug('Warning, running multifeed with unsecure default key')

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
    self._loadFeeds(function () {
      debug('[INIT] finished loading feeds')
      done()
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

    var feeds = values(self._feeds).concat(self._fake)

    function next (n) {
      if (n >= feeds.length) {
        self._feeds = []
        self._fake = undefined
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
          st.close(function (err) {
            if (err) return cb(err)
            next(n+1)
          })
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
            if (err) return cb(err)
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

Multifeed.prototype.replicate = function (opts) {
  if (!opts) opts = {}
  var self = this
  var mux = multiplexer(self.key, opts)

  // Add key exchange listener
  mux.once('manifest', function(m) {
    if (self._middleware.length) {
      function callPlug(i, ctx) {
        if (self._middleware.length === i) return mux.wantFeeds(ctx.keys)
        var plug = self._middleware[i]

        // Reliquish control to next if plug does not implement callback
        if (typeof plug.want !== 'function') return callPlug(i + 1, ctx)

        // give each plug a fresh reference to avoid peeking/postmodifications
        plug.want(clone(ctx), function(keys) {
          let n = clone(m)
          n.keys = keys
          callPlug(i + 1, n)
        })
      }
      // Start loop
      callPlug(0, m)
    } else {
      // default behaviour "want all"
      mux.wantFeeds(m.keys)
    }
  })

  // Add replication listener
  mux.once('replicate', function(keys, repl) {
    addMissingKeys(keys, function(err){
      if(err) return mux.destroy(err)

      var key2feed = values(self._feeds).reduce(function(h, feed){
        h[feed.key.toString('hex')] = feed
        return h
      },{})

      var feeds = keys.map(function(k){ return key2feed[k] })
      repl(feeds)
    })
  })

  // Start streaming
  this.ready(function(err){
    if (err) return mux.stream.destroy(err)
    if (mux.stream.destroyed) return
    mux.ready(function(){
      var available = values(self._feeds).map(function (feed) { return feed.key.toString('hex') })
      if (self._middleware.length) {
        // Orderly iterate through all plugs
        function callPlug(i, ctx) {
          if (i === self._middleware.length) return mux.haveFeeds(ctx.keys, ctx)
          let plug = self._middleware[i]

          // Reliquish control to next if plug does not implement callback
          if (typeof plug.have !== 'function') return callPlug(i + 1, ctx)

          // give each plug a fresh reference to avoid peeking/postmodifications
          plug.have(clone(ctx), function(keys, extras){
            extras = extras || {}
            extras.keys = keys
            callPlug(i + 1, extras)
          })
        }
        callPlug(0, {keys: available})
      } else {
        // Default behaviour 'share all'
        mux.haveFeeds(available)
      }
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

    var existingKeys = values(self._feeds).map(function(feed) { return feed.key.toString('hex') })

    var missingFeeds = filtered.filter(function (key) {
      return existingKeys.indexOf(key) === -1
    })

    function initFeed(i) {
      if (i >= missingFeeds.length) return cb()
        var key = missingFeeds[i]
        var numFeeds = Object.keys(self._feeds).length
        var storage = self._storage(''+numFeeds)
        var feed
        try {
          debug('[REPLICATION] trying to create new local hypercore, key=' + key.toString('hex'))
          feed = self._hypercore(storage, Buffer.from(key, 'hex'), self._opts)
        } catch (e) {
          debug('[REPLICATION] failed to create new local hypercore, key=' + key.toString('hex'))
          return initFeed(i + 1)
        }
        feed.ready(function () {
          debug('[REPLICATION] succeeded in creating new local hypercore, key=' + key.toString('hex'))
          self._addFeed(feed, String(numFeeds))
          initFeed(i + 1)
        })
    }
    initFeed(0)
  }
}

Multifeed.prototype.use = function(plug) {
  if(this._middleware === null) this._middleware = []
  this._middleware.push(plug)
  var self = this
  if (typeof plug.init === 'function') this.ready(function(){
    plug.init(self)
  })
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

// Deep clone
function clone(obj) {
  return JSON.parse(JSON.stringify(obj))
}
