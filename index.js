var hypercore = require('hypercore')
var raf = require('random-access-file')
var ram = require('random-access-memory')
var path = require('path')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')
var through = require('through2')
var debug = require('debug')('multifeed')
var multiplexer = require('./mux')
var version = require('./package.json').version

// Key-less constant hypercore to bootstrap hypercore-protocol replication.
var defaultEncryptionKey = Buffer.from('bee80ff3a4ee5e727dc44197cb9d25bf8f19d50b0f3ad2984cfe5b7d14e75de7', 'hex')

module.exports = Multifeed

function Multifeed (storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(storage, opts)
  this._id = (opts || {})._id || Math.floor(Math.random() * 1000).toString(16) // for debugging
  debug(this._id, 'multifeed @ ' + version)
  this._feeds = {}
  this._feedKeyToFeed = {}
  this._streams = []

  opts = opts || {}

  // Support legacy opts.key
  if (opts.key) opts.encryptionKey = opts.key

  this._hypercore = opts.hypercore || hypercore
  this._opts = opts

  this.writerLock = mutexify()

  this._close = readyify(_close.bind(this), true)
  this.closed = false

  // random-access-storage wrapper that wraps all hypercores in a directory
  // structures. (dir/0, dir/1, ...)
  this._dirs = {}
  this._max_dir = -1
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

    debug(self._id, 'Using encryption key:', encryptionKey.toString('hex').substring(0,5) + '..')

    var feed = hypercore(ram, encryptionKey)

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
  this._forwardLiveFeedAnnouncements(feed, name)
}

Multifeed.prototype.removeFeed = function (nameOrKey, cb) {
  if (typeof cb !== 'function') cb = function noop () {}

  var self = this

  var feed = null
  var name = null
  var key = null

  if (nameOrKey in self._feeds) {
    name = nameOrKey
    feed = self._feeds[name]
    key = feed.key.toString('hex')
  } else {
    key = nameOrKey
    feed = self._feedKeyToFeed[key]
    name = Object.keys(self._feeds).find(key => self._feeds[key] === feed)
  }

  delete self._feeds[name]
  delete self._feedKeyToFeed[key]

  // Remove from dirs index
  Object.keys(self._dirs).forEach((dir) => {
    if (self._dirs[dir] === feed) {
      delete self._dirs[dir]
    }
  })

  // Remove from mux offering
  self._streams.forEach((mux) => {
    var idx = mux._localOffer.indexOf(key)
    if (idx !== -1) {
      mux._localOffer.splice(idx, 1)
    }
  })

  self.writerLock(function (release) {
    feed.destroyStorage(function (err) {
      if (err) return self.emit('error', err)
      self._updateStorageIndex(function () { release(cb) })
    })
  })
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
        self._feedKeyToFeed = {}
        self._root = undefined
        self._streams.forEach((mux) => {
          mux._finalize()
        })
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

Multifeed.prototype._updateStorageIndex = function (cb) {
  if (typeof cb !== 'function') cb = function noop () {}

  var self = this

  var dirs = Object.keys(self._dirs).join(',')
  self._max_dir = Math.max.apply(null, Object.keys(self._dirs).map(Number))

  var st = self._storage('index')('dirs')
  writeStringToStorage(dirs, st, cb)
}

Multifeed.prototype._loadFeeds = function (cb) {
  var self = this

  // Hypercores are stored via an index file in numbers directories. If no index
  // is found, the structure is assumed to be legacy which starts at 0 and
  // increments by 1. A failed read at position 0 implies non-existance of the
  // hypercore and if legacy means the end of loading.
  var doneOnErr = true
  var nextDir = function (dir) { return dir + 1 }

  var pending = 1
  function next (dir) {
    if (!dir && typeof dir !== 'number') return done()

    var storage = self._storage('' + dir)
    var st = storage('key')
    st.read(0, 4, function (err) {
      if (err && doneOnErr) return done() // means there are no more feeds to read
      debug(self._id + ' [INIT] loading feed #' + dir)
      pending++
      var feed = self._hypercore(storage, self._opts)
      process.nextTick(next, nextDir(dir))

      feed.ready(function () {
        readStringFromStorage(storage('localname'), function (err, name) {
          if (!err && name) {
            self._addFeed(feed, name)
          } else {
            self._addFeed(feed, String(dir))
          }
          self._dirs[dir] = feed
          st.close(function (err) {
            if (err) return done(err)
            debug(self._id + ' [INIT] loaded feed #' + dir)
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

  var indexSt = self._storage('index')('dirs')

  readStringFromStorage(indexSt, function (err, dirs) {
    if (err) {
      next(0)
    } else {
      doneOnErr = false
      dirs = dirs ? dirs.split(',') : []

      // Update max dir on load
      self._max_dir = Math.max.apply(null, dirs.map(Number).concat(self._max_dir))

      nextDir = function (dir) {
        var idx = dirs.indexOf(dir)
        if (idx < dirs.length - 1) {
          return dirs[idx + 1]
        } else {
          return ''
        }
      }

      next(dirs[0])
    }
  })
}

Multifeed.prototype.writer = function (name, opts, cb) {
  if (typeof name === 'function' && !cb) {
    cb = name
    name = undefined
    opts = {}
  }
  if (typeof opts === 'function' && !cb) {
    cb = opts
    opts = {}
  }

  var self = this
  const keypair = opts.keypair

  this.ready(function () {
    // Short-circuit if already loaded
    if (self._feeds[name]) {
      process.nextTick(cb, null, self._feeds[name])
      return
    }

    debug(self._id + ' [WRITER] creating new writer: ' + name)

    self.writerLock(function (release) {
      var dir = self._max_dir + 1
      var storage = self._storage('' + dir)

      var idx = name || String(dir)

      var nameStore = storage('localname')
      writeStringToStorage(idx, nameStore, function (err) {
        if (err) {
          release(function () {
            cb(err)
          })
          return
        }

        var feed = keypair
          ? self._hypercore(storage, keypair.publicKey, Object.assign({}, self._opts, { secretKey: keypair.secretKey }))
          : self._hypercore(storage, self._opts)
        feed.on('error', function (err) {
          self.emit('error', err)
        })

        feed.ready(function () {
          self._addFeed(feed, String(idx))
          self._dirs[dir] = feed
          self._updateStorageIndex(function (err) {
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

Multifeed.prototype.replicate = function (isInitiator, opts) {
  if (!this._root) {
    var tmp = through()
    process.nextTick(function () {
      tmp.emit('error', new Error('tried to use "replicate" before multifeed is ready'))
    })
    return tmp
  }

  if (!opts) opts = {}
  var self = this
  var mux = multiplexer(isInitiator, self._root.key, Object.assign({}, opts, {_id: this._id}))

  // Add key exchange listener
  var onManifest = function (m) {
    mux.requestFeeds(m.keys)
  }
  mux.on('manifest', onManifest)

  // Add replication listener
  var onReplicate = function (keys, repl) {
    addMissingKeys(keys, function (err) {
      if (err) return mux.stream.destroy(err)

      // Create a look up table with feed-keys as keys
      // (since not all keys in self._feeds are actual feed-keys)
      var key2feed = values(self._feeds).reduce(function (h, feed) {
        h[feed.key.toString('hex')] = feed
        return h
      }, {})

      // Select feeds by key from LUT
      var feeds = keys.map(function (k) { return key2feed[k] })
      repl(feeds)
    })
  }
  mux.on('replicate', onReplicate)

  // Start streaming
  this.ready(function (err) {
    if (err) return mux.stream.destroy(err)
    if (mux.stream.destroyed) return
    mux.ready(function () {
      var keys = values(self._feeds).map(function (feed) { return feed.key.toString('hex') })
      mux.offerFeeds(keys)
    })

    // Push session to _streams array
    self._streams.push(mux)

    // Register removal
    var cleanup = function (err) {
      mux.removeListener('manifest', onManifest)
      mux.removeListener('replicate', onReplicate)
      mux.stream.removeListener('end', cleanup)
      mux.stream.removeListener('close', cleanup)
      mux.stream.removeListener('error', cleanup)
      mux.stream.finalize()
      self._streams.splice(self._streams.indexOf(mux), 1)
      debug('[REPLICATION] Client connection destroyed', err)
    }
    mux.stream.once('end', cleanup)
    mux.stream.once('close', cleanup)
    mux.stream.once('error', cleanup)
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

    var numFeeds = self._max_dir + 1
    var keyId = numFeeds
    filtered.forEach(function (key) {
      var feeds = values(self._feeds).filter(function (feed) {
        return feed.key.toString('hex') === key
      })
      if (!feeds.length) {
        var myKey = String(keyId)
        var storage = self._storage(myKey)
        keyId++
        pending++
        var feed
        try {
          debug(self._id + ' [REPLICATION] trying to create new local hypercore, key=' + key.toString('hex'))
          feed = self._hypercore(storage, Buffer.from(key, 'hex'), self._opts)
        } catch (e) {
          debug(self._id + ' [REPLICATION] failed to create new local hypercore, key=' + key.toString('hex'))
          debug(self._id + e.toString())
          if (!--pending) cb()
          return
        }
        feed.ready(function () {
          self._addFeed(feed, myKey)
          self._dirs[myKey] = feed
          self._updateStorageIndex()
          keyId++
          debug(self._id + ' [REPLICATION] succeeded in creating new local hypercore, key=' + key.toString('hex'))
          if (!--pending) cb()
        })
      }
    })
    if (!pending) cb()
  }
}

Multifeed.prototype._forwardLiveFeedAnnouncements = function (feed, name) {
  if (!this._streams.length) return // no-op if no live-connections
  var hexKey = feed.key.toString('hex')
  // Tell each remote that we have a new key available unless
  // it's already being replicated
  this._streams.forEach(function (mux) {
    if (mux.knownFeeds().indexOf(hexKey) === -1) {
      debug('Forwarding new feed to existing peer:', hexKey)
      mux.offerFeeds([hexKey])
    }
  })
}

function writeStringToStorage (string, storage, cb) {
  function writeBuffer () {
    var buf = Buffer.from(string, 'utf8')
    storage.write(0, buf, function (err) {
      storage.close(function (err2) {
        cb(err || err2)
      })
    })
  }

  // Check if data already exists
  storage.stat(function (err, stat) {
    if (err) return writeBuffer()

    var len = stat.size
    storage.del(0, len, function (err) {
      if (err) return cb(err)

      writeBuffer()
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
