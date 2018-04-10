var raf = require('random-access-file')
var path = require('path')

module.exports = Multicore

function Multicore (hypercore, storage, opts) {
  if (!(this instanceof Multicore)) return new Multicore(hypercore, storage, opts)

  this._hypercore = hypercore
  this._opts = opts
  this._storage = function (dir) {
    return function (name) {
      if (typeof storage === 'string') {
        dir = path.join(storage, dir)
        storage = raf
      }
      return storage(dir + '/' + name)
    }
  }
}

Multicore.prototype.writer = function () {
  // Q: what to call other writers?
  return this._hypercore(this._storage('source'), this._opts)
}

Multicore.prototype.feeds = function () {
}

Multicore.prototype.feed = function (key) {
}

Multicore.prototype.replicate = function (opts) {
}
