var raf = require('random-access-file')
var path = require('path')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')
var through = require('through2')
var debug = require('debug')('multifeed')
var multiplexer = require('./mux')

module.exports = Multifeed

function Multifeed (hypercore, storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(hypercore, storage, opts)
  this._id = (opts||{})._id || Math.floor(Math.random() * 1000).toString(16)  // for debugging
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
    var protocolEncryptionKey = new Buffer('bee80ff3a4ee5e727dc44197cb9d25bf8f19d50b0f3ad2984cfe5b7d14e75de7', 'hex')
    if (self._opts.key) protocolEncryptionKey = Buffer.from(self._opts.key)
    else debug(self._id + ' Warning, running multifeed with unsecure default key')

    var feed = hypercore(self._storage('_fake'), protocolEncryptionKey)

    feed.ready(function () {
      self._fake = feed
      self._loadFeeds(function () {
        debug(self._id + ' [INIT] finished loading feeds')
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
  var pending = 0
  function next (n) {
    var storage = self._storage(''+n)
    debug(self._id + ' [INIT] loading feed #' + n)
    var st = storage('key')
    st.read(0, 4, function (err) {
      pending++
      if (err) return done()  // means there are no more feeds to read
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

Multifeed.prototype.replicate = function (opts) {
  if (!this._fake) {
    var tmp = through()
    process.nextTick(function () {
      tmp.emit('error', new Error('tried to use "replicate" before multifeed is ready'))
    })
    return tmp
  }

  if (!opts) opts = {}
  var self = this
  var mux = multiplexer(self._fake.key, opts)

  // Add key exchange listener
  mux.once('manifest', function(m) {
    mux.wantFeeds(m.keys)
  })

  // Add replication listener
  mux.once('replicate', function(keys, repl) {
    addMissingKeys(keys, function(err){
      if(err) return mux.destroy(err)

      // Q(noffle): why do this?
      var key2feed = values(self._feeds).reduce(function(h,feed){
        h[feed.key.toString('hex')] = feed
        return h
      },{})

      // Q(noffle): does order matter to hypercore-protocol?
      var feeds = keys.map(function(k){ return key2feed[k] })
      repl(feeds)
    })
  })

  // Start streaming
  this.ready(function(err){
    if (err) return mux.stream.destroy(err)
    if (mux.stream.destroyed) return
    mux.ready(function(){
      var keys = values(self._feeds).map(function (feed) { return feed.key.toString('hex') })
      mux.haveFeeds(keys)
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
    debug(self._id + ' [REPLICATION] recv\'d ' + keys.length + ' keys')
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
          debug(self._id + ' [REPLICATION] trying to create new local hypercore, key=' + key.toString('hex'))
          feed = self._hypercore(storage, Buffer.from(key, 'hex'), self._opts)
        } catch (e) {
          debug(self._id + ' [REPLICATION] failed to create new local hypercore, key=' + key.toString('hex'))
          if (!--pending) cb()
          return
        }
        debug(self._id + ' [REPLICATION] succeeded in creating new local hypercore, key=' + key.toString('hex'))
        self._addFeed(feed, String(numFeeds))
        feed.ready(function () {
          if (!--pending) cb()
        })
      }
    })
    if (!pending) cb()
  }
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
