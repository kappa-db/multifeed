var protocol = require('hypercore-protocol')
var readify = require('./ready')
var inherits = require('inherits')
var events = require('events')
var debug = require('debug')('multifeed')

// constants
var MULTIFEED = 'MULTIFEED'
var PROTOCOL_VERSION = '2.0.0'
// extensions
var MANIFEST = 'MANIFEST'
var REQUEST_FEEDS = 'REQUEST_FEEDS'

var SupportedExtensions = [
  MANIFEST,
  REQUEST_FEEDS
]

// `key` - protocol encryption key
// `opts`- hypercore-protocol opts
function Multiplexer (key, opts) {
  if (!(this instanceof Multiplexer)) return new Multiplexer(key, opts)
  this._id = opts._id || Math.floor(Math.random() * 1000).toString(16)
  debug(this._id + ' [REPLICATION] New mux initialized', key.toString('hex'), opts)
  var self = this
  self._opts = opts = opts || {}
  self.extensions = opts.extensions = SupportedExtensions || opts.extensions

  // initialize
  self._localHave = null
  self._localWant = null
  self._remoteHas = null
  self._remoteWants = null

  var stream = this.stream = protocol(Object.assign(opts,{
    userData: Buffer.from(JSON.stringify({
      client: MULTIFEED,
      version: PROTOCOL_VERSION
    }))
  }))

  var feed = this._feed = stream.feed(key)

  stream.on('handshake', function () {
    var header = null
    try {
      header = JSON.parse(this.userData.toString('utf8'))
    } catch (err) {
      debug(self._id + ' [REPLICATION] Failed parsing JSON handshake', err)
      self._finalize(err)
      return
    }
    debug(self._id + ' [REPLICATION] recv\'d handshake: ', JSON.stringify(header))
    if (!compatibleVersions(header.version, PROTOCOL_VERSION)) {
      debug(self._id + ' [REPLICATION] aborting; version mismatch (us='+PROTOCOL_VERSION+')')
      self._finalize(new Error('protocol version mismatch! us='+PROTOCOL_VERSION + ' them=' + header.version))
      return
    }

    if (header.client != MULTIFEED) {
      debug(self._id + ' [REPLICATION] aborting; Client mismatch! expected ', MULTIFEED, 'but got', header.client)
      self._finalize(new Error('Client mismatch! expected ' + MULTIFEED + ' but got ' + header.client))
      return
    }
    self.emit('ready', header)
  })

  feed.on('extension', function (type, message) {
    debug(self._id + ' Recv\'d extension:', type, message.toString('utf8'))
    switch(type) {
      case MANIFEST:
        var rm = JSON.parse(message.toString('utf8'))
        self._remoteHas = rm.keys
        self.emit('manifest', rm)
        break
      case REQUEST_FEEDS:
        self._remoteWants = JSON.parse(message.toString('utf8'))
        self._initRepl()
        break
    }
  })

  if (!self._opts.live ) {
    self.stream.on('prefinalize', function(cb){
      debug(self._id + ' [REPLICATION] feed finish/prefinalize', self.stream.expectedFeeds)
      cb()
    })
  }

  this._ready = readify(function (done) {
    self.on('ready', function(remote){
      debug(self._id + ' [REPLICATION] remote connected and ready')
      done(remote)
    })
  })
}

inherits(Multiplexer, events.EventEmitter)

Multiplexer.prototype.ready = function(cb) {
  this._ready(cb)
}

Multiplexer.prototype._finalize = function(err) {
  if (err) {
    debug(this._id + ' [REPLICATION] destroyed due to', err)
    this.emit('error', err)
    this.stream.destroy(err)
  } else {
    debug(this._id + ' [REPLICATION] finalized', err)
    this.stream.finalize()
  }
}

// Calls to this method results in the creation of a 'manifest'
// that gets transmitted to the other end.
// application is allowed to provide optional custom data in the opts for higher-level
// 'want' selections.
// The manifest-prop `keys` is required, and must equal an array of strings.
Multiplexer.prototype.haveFeeds = function (keys, opts) {
  var manifest = Object.assign(opts || {}, {
    keys: extractKeys(keys)
  })
  debug(this._id + ' [REPLICATON] sending manifest:', manifest)
  this._localHave = manifest.keys
  this._feed.extension(MANIFEST, Buffer.from(JSON.stringify(manifest)))
}

// Sends your wishlist to the remote
// for classical multifeed `ACCEPT_ALL` behaviour both parts must call `want(remoteHas)`
Multiplexer.prototype.wantFeeds = function (keys) {
  keys = extractKeys(keys)
  debug(this._id + ' [REPLICATION] Sending feeds request', keys)
  this._feed.extension(REQUEST_FEEDS, Buffer.from(JSON.stringify(keys)))
  this._localWant = keys
  this._initRepl()
}


// this method is expected to be called twice, and will trigger the 'replicate'
// event when both local and remote 'wants' are available. calculating a sorted
// common denominator between both wants and availablility which should result
// in two identical arrays being built on both ends using algorithm:
//
// formula:  feedsToReplicate = (lWant - (lWant - rHave)) + (rWant - (rWant - lHave ))
//
// The result honors that each node only shares what it offers and does not
// receive feeds that it didn't ask for.
Multiplexer.prototype._initRepl = function() {
  var self = this
  if(!this._localWant || !this._remoteWants) return

  // the 'have' arrays might be null, It means that a client might not want
  // to share anything, and we can silently respect that.

  var sending = self._remoteWants.filter(function(k) {
    return (self._localHave || []).indexOf(k) !== -1
  })

  var receiving = self._localWant.filter(function(k){
    return (self._remoteHas || []).indexOf(k) !== -1
  })

  // Concat sending and receiveing; produce sorted array with no duplicates
  var keys = sending.concat(receiving)
    .reduce(function(arr, key){ // remove duplicates
      if (arr.indexOf(key) === -1) arr.push(key)
      return arr
    }, [])
    .sort() // sort

  debug(this._id + ' [REPLICATION] _initRepl', keys.length, keys)

  // End immedietly if there's nothing to replicate.
  if (!this._opts.live && keys.length === 0) return this._finalize()

  this.emit('replicate', keys, startFeedReplication)

  return keys

  function startFeedReplication(feeds){
    if (!Array.isArray(feeds)) feeds = [feeds]
    self.stream.expectedFeeds = feeds.length

    // only the feeds passed to `feeds` option will be replicated (sent or received)
    // hypercore-protocol has built in protection against receiving unexpected/not asked for data.
    feeds.forEach(function(feed) {
      feed.ready(function() { // wait for each to be ready before replicating.
        debug(self._id + ' [REPLICATION] replicating feed:', feed.key.toString('hex'))
        feed.replicate(Object.assign({}, {
          live: self._opts.live,
          download: self._opts.download,
          upload: self._opts.upload,
          encrypt: self._opts.encrypt,
          stream: self.stream
        }))
      })
    })
  }
}

module.exports = Multiplexer
module.exports.SupportedExtensions = SupportedExtensions

// String, String -> Boolean
function compatibleVersions (v1, v2) {
  var major1 = v1.split('.')[0]
  var major2 = v2.split('.')[0]
  return parseInt(major1) === parseInt(major2)
}

function extractKeys (keys) {
  if (!Array.isArray(keys)) keys = [keys]
  return keys = keys.map(function(o) {
    if (typeof o === 'string') return o
    if (typeof o === 'object' && o.key) return o.key.toString('hex')
    if (o instanceof Buffer) return o.toString('utf8')
  })
    .filter(function(o) { return !!o }) // remove invalid entries
}
