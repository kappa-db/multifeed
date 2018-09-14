var raf = require('random-access-file')
var path = require('path')
var protocol = require('hypercore-protocol')
var through = require('through2')
var pumpify = require('pumpify')
var events = require('events')
var inherits = require('inherits')
var readyify = require('./ready')
var mutexify = require('mutexify')

module.exports = Multifeed

function Multifeed (hypercore, storage, opts) {
  if (!(this instanceof Multifeed)) return new Multifeed(hypercore, storage, opts)

  this._feeds = {}
  this._feedKeyToFeed = {}

  this._hypercore = hypercore
  this._opts = opts

  this.writerLock = mutexify()

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
    self._fake = feed
    self._loadFeeds(done)
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
  ;(function next (n) {
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
  })(0)
}

Multifeed.prototype.writer = function (name, cb) {
  if (typeof name === 'function' && !cb) {
    cb = name
    name = undefined
  }
  var self = this

  // Short-circuit if already loaded
  if (this._feeds[name]) {
    process.nextTick(cb, null, this._feeds[name])
    return
  }

  this.ready(function () {
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
  return Object.values(this._feeds)
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
    var pending = 0
    var filtered = keys.filter(function (key) {
      return Buffer.isBuffer(key) && key.length === 32
    })
    filtered.forEach(function (key) {
      var feeds = Object.values(self._feeds).filter(function (feed) {
        return feed.key.equals(key)
      })
      if (!feeds.length) {
        pending++
        var numFeeds = Object.keys(self._feeds).length
        var storage = self._storage(''+numFeeds)
        var feed
        try {
        feed = self._hypercore(storage, key, self._opts)
        } catch (e) {
          if (!--pending) cb()
          return
        }
        self._addFeed(feed, String(numFeeds))
        feed.ready(function () {
          if (!--pending) cb()
        })
      }
    })
    if (!pending) cb()
  }

  var feedWriteBuf = serializeFeedBuf(Object.values(this._feeds))

  var firstWrite = true
  var writeStream = through(function (buf, _, next) {
    if (firstWrite) {
      firstWrite = false
      this.push(feedWriteBuf)
    }
    this.push(buf)
    next()
  })

  var firstRead = true
  var readStream = through(function (buf, _, next) {
    var self = this
    if (firstRead) {
      firstRead = false
      var res = deserializeFeedBuf(buf)
      if (!res) {
        // probably replicating with a non-multifeed peer: abort
        return next(new Error('replicating with non-multifeed peer'))
      }
      var keys = res[0]
      var size = res[1]
      if (!Array.isArray(keys)) {
        // probably replicating with a non-multifeed peer: abort
        return next(new Error('replicating with non-multifeed peer'))
      }

      addMissingKeys(keys, function () {
        // push remainder of buffer
        var leftover = buf.slice(size)
        self.push(leftover)

        process.nextTick(function () {
          startSync()
        })
        next()
      })
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
    var sortedFeeds = Object.values(self._feeds).sort(cmp)
    function cmp (a, b) {
      return a.key.toString('hex') > b.key.toString('hex')
    }
    sortedFeeds.forEach(function (feed) {
      feed.replicate(opts)
    })
  }

  function onready (err) {
    if (err) return stream.destroy(err)
    if (stream.destroyed) return

    self._fake.replicate(opts)
  }
}

function serializeFeedBuf (feeds) {
  var myFeedKeys = feeds.map(function (feed) {
    return feed.key
  })

  var numFeedsBuf = Buffer.alloc(2)
  numFeedsBuf.writeUInt16LE(myFeedKeys.length, 0)

  return Buffer.concat([numFeedsBuf].concat(myFeedKeys))
}

function deserializeFeedBuf (buf) {
  var numFeeds = buf.readUInt16LE(0)
  var res = []

  for (var i=0; i < numFeeds; i++) {
    var offset = 2 + i * 32
    var key = buf.slice(offset, offset + 32)
    res.push(key)
  }

  return [res, 2 + numFeeds * 32]
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
