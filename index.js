var raf = require('random-access-file')
var path = require('path')

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
  this._countStorage = createCountStorage(storage)

  var self = this
  this._numFeeds = null
  this._countStorage.open(function (err) {
    if (err) {
      var buf = Buffer.alloc(4)
      buf.writeUInt32LE(0, 0)
      self._countStorage.write(1, buf)
    } else {
      console.log('opened', err)

      // Read how many hypercores exist in the multicore
      // TODO: can I query storage somehow with random-access-storage, and avoid this?
      self._countStorage.read(0, 4, function (err, buf) {
        if (err) throw err
        self._numFeeds = buf.readUInt32LE(0)
        console.log('got # feeds', self._numFeeds)
      })
    }
  })
}

Multicore.prototype._addFeed = function (feed, cb) {
  var buf = Buffer.alloc(4)
  buf.writeUInt32LE(this.feeds.length + 1, 0)
  console.log('gonna write', this.feeds.length + 1)
  var self = this
  this._countStorage.write(0, buf, function (err) {
    console.log('updated feed #', self.feeds.length + 1)
    feed.ready(function () {
      self._feeds.push(feed)
      cb()
    })
  })
}

Multicore.prototype.writer = function (cb) {
  // Q: what to call other writers?
  // Q: possible to get the key BEFORE doing storage writing?
  // Q: can I just check if 'source(N-1)' exists before writing?
  // could I just check 0, 1, 2, 3, ... and load them until I hit a no-exist?
  //   how do you detect non-existance of a random-access-storage?
  var feed = this._hypercore(this._storage('source'), this._opts)
  this._addFeed(feed, function (err) {
    if (err) return cb(err)
    cb(null, feed)
  })
}

Multicore.prototype.feeds = function () {
}

Multicore.prototype.feed = function (key) {
}

Multicore.prototype.replicate = function (opts) {
}

function createCountStorage (storage) {
  if (typeof storage === 'string') return raf(path.join(storage, 'count'))
  else return storage('count')
}

