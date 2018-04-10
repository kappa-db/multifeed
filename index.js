var raf = require('random-access-file')
var path = require('path')
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
}
