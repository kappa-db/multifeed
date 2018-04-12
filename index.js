var raf = require('random-access-file')
var path = require('path')
var protocol = require('hypercore-protocol')
var through = require('through2')
var pumpify = require('pumpify')
var readyify = require('./ready')

module.exports = Multicore

function Multicore (hypercore, storage, opts) {
  if (!(this instanceof Multicore)) return new Multicore(hypercore, storage, opts)

  this._feeds = []

  this._hypercore = hypercore
  this._opts = opts
  this._storage = function (dir) {
    return function (name) {
      var s = storage
      if (typeof storage === 'string') return raf(path.join(storage, dir, name))
      else return s(dir + '/' + name)
    }
  }

  var self = this
  this._ready = readyify(function (done) {
    var feed = hypercore(self._storage('fake'), new Buffer('bee80ff3a4ee5e727dc44197cb9d25bf8f19d50b0f3ad2984cfe5b7d14e75de7', 'hex'))
    self._fake = feed
    self._loadFeeds(done)
  })
}

Multicore.prototype.ready = function (cb) {
  this._ready(cb)
}

Multicore.prototype._loadFeeds = function (cb) {
  var self = this
  ;(function next (n) {
    var st = self._storage(''+n)('key')
    st.read(0, 4, function (err) {
      if (err) return cb()
      var feed = self._hypercore(self._storage(''+n), self._opts)
      self._feeds.push(feed)
      next(n+1)
    })
  })(0)
}

Multicore.prototype.writer = function (cb) {
  var self = this
  this.ready(function () {
    var feed = self._hypercore(self._storage(''+self._feeds.length), self._opts)
    self._feeds.push(feed)
    feed.ready(cb.bind(null, null, feed))
  })
}

Multicore.prototype.feeds = function () {
  return this._feeds.slice()
}

Multicore.prototype.replicate = function (opts) {
  if (!opts) opts = {}

  var self = this
  opts.expectedFeeds = this._feeds.length
  var expectedFeeds = opts.expectedFeeds

  // opts.live = true
  opts.encrypt = false
  opts.download = true
  opts.stream = protocol(opts)

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

    return res
  }

  function addMissingKeys (keys) {
    keys.forEach(function (key) {
      var feeds = self._feeds.filter(function (feed) {
        return feed.key.equals(key)
      })
      if (!feeds.length) {
        var feed = self._hypercore(self._storage(''+self._feeds.length), key, self._opts)
        self._feeds.push(feed)
        replicate()
      }
    })
  }

  var feedWriteBuf = serializeFeedBuf(this._feeds)

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
    if (firstRead) {
      firstRead = false
      var keys = deserializeFeedBuf(buf)
      addMissingKeys(keys)
    } else {
      this.push(buf)
    }
    next()
  })

  var stream = pumpify(readStream, opts.stream, writeStream)

  if (!opts.live) {
    opts.stream.on('prefinalize', function (cb) {
      opts.stream.expectedFeeds += (self._feeds.length - expectedFeeds)
      expectedFeeds = self._feeds.length
      cb()
    })
  }

  this.ready(onready)

  return stream

  function replicate () {
    self._feeds.forEach(function (feed) {
      feed.replicate(opts)
    })
  }

  function onready (err) {
    if (err) return stream.destroy(err)
    if (stream.destroyed) return

    self._fake.replicate(opts)

    replicate()
  }
}
