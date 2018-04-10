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

  this._readies = []
  this._ready = false
  var self = this
  this._loadFeeds(function () {
    self._ready = true
    self._readies.forEach(process.nextTick)
    self._readies = []
  })
}

Multicore.prototype.ready = function (cb) {
  if (this._ready) return process.nextTick(cb)
  else this._readies.push(cb)
}

Multicore.prototype._loadFeeds = function (cb) {
  var self = this
  ;(function next (n) {
    console.log('loading feed', n)
    var st = self._storage(''+n)('key')
    st.read(0, 4, function (err) {
      if (err) console.log('no feed @', n)
      if (err) return cb()
      var feed = self._hypercore(self._storage(''+n), self._opts)
      self._feeds.push(feed)
      console.log('loaded feed', n)
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
}

Multicore.prototype.feed = function (key) {
}

Multicore.prototype.replicate = function (opts) {
}
