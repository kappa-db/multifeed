var raf = require('random-access-file')
var path = require('path')

module.exports = Multicore

function Multicore (hypercore, storage, opts) {
  if (!(this instanceof Multicore)) return new Multicore(hypercore, storage, opts)

  this._hypercore = hypercore
  this._opts = opts
  this._storage = function (dir) {
    return function (name) {
      var s = storage
      if (typeof storage === 'string') return raf(path.join(storage, dir))
      else return s(dir + '/' + name)
    }
  }
  this._countStorage = createCountStorage(storage)

  // var self = this
  // this._countStorage.open(function (err) {
  //   console.log('opened', err)

  //   // Read how many hypercores exist in the multicore
  //   // TODO: can I query storage somehow with random-access-storage, and avoid this?
  //   self._countStorage.read(0, 4, function (err, buf) {
  //     if (err) throw err
  //     console.log(buf)
  //   })
  // })
}

Multicore.prototype.writer = function () {
  // Q: what to call other writers?
  // Q: possible to get the key BEFORE doing storage writing?
  // Q: can I just check if 'source(N-1)' exists before writing?
  // could I just check 0, 1, 2, 3, ... and load them until I hit a no-exist?
  //   how do you detect non-existance of a random-access-storage?
  return this._hypercore(this._storage('source'), this._opts)
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
