var protocol = require('hypercore-protocol')
var readify = require('./ready')
var inherits = require('inherits')
var events = require('events')
var debug = require('debug')('multifeed')
var hypercore = require('hypercore')
var xtend = require('xtend')

// constants
var MULTIFEED = 'MULTIFEED'
var PROTOCOL_VERSION = '2.0.0'
// extensions
var MANIFEST = 'MANIFEST'
var REQUEST_FEEDS = 'REQUEST_FEEDS'
/*
var ANNOUNCE_FEED = 'ANNOUNCE_FEED'
var REQUEST_FEED_SIGNATURE = 'REQUEST_FEED_SIGNATURE'
var FEED_SIGNATURE = 'FEED_SIGNATURE'
*/

var SupportedExtensions = [
  MANIFEST,
  REQUEST_FEEDS
  //ANNOUNCE_FEED
  //REQUEST_MANIFEST,
  //REQUEST_FEED_SIGNATURE,
  //FEED_SIGNATURE,
]

// `key` - protocol encryption key
// `opts`- hypercore-protocol opts
function Multiplexer (key, opts) {
  if (!(this instanceof Multiplexer)) return new Multiplexer(key, opts)
  debug('[REPLICATION] New mux initialized', key.toString('hex'), opts)
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
      version: PROTOCOL_VERSION,
      // Help! exposing available extensions might be good for future version tolerance,
      // but at the same time we're poentiallyleaking our user-agent fingerprint to a third party.
      extensions: self.extensions
    }))
  }))

  var feed = this._feed = stream.feed(key)

  stream.on('handshake', function () {
    var header = JSON.parse(this.userData.toString('utf8'))
    debug('[REPLICATION] recv\'d header: ', JSON.stringify(header))
    if (!compatibleVersions(header.version, PROTOCOL_VERSION)) {
      debug('[REPLICATION] aborting; version mismatch (us='+PROTOCOL_VERSION+')')
      self._finalize(new Error('protocol version mismatch! us='+PROTOCOL_VERSION + ' them=' + header.version))
      return
    }

    if (header.client != MULTIFEED) {
      debug('[REPLICATION] aborting; Client mismatch! expected ', MULTIFEED, 'but got', header.client)
      self._finalize(new Error('Client mismatch! expected ' + MULTIFEED + ' but got ' + header.client))
      return
    }
    self.remoteClient = header
    self.emit('ready', header)
  })

  feed.on('extension', function (type, message) {
    debug('Extension:', type, message.toString('utf8'))
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
      // case ANNOUNCE_FEED:
      //  self._announceFeed(JSON.parse(message.toString('utf8')))
    }
  })

  if (!self._opts.live ) {
    self.stream.on('prefinalize', function(cb){
      debug('[REPLICATION] feed finish/prefinalize', self.stream.expectedFeeds)
      cb()
    })
  }


  this._ready = readify(function (done) {
    self.on('ready', function(remote){
      debug('[REPLICATION] remote connected and ready')
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
    debug('[REPLICATION] destroyed due to', err)
    this.emit('error', err)
    this._stream.destroy(err)
  } else {
    debug('[REPLICATION] finalized', err)
    this._stream.finalize()
  }
}

// Calls to this method results in the creation of a 'manifest'
// that gets transmitted to the other end.
// application is allowed to provide optional custom data in the opts for higher-level
// 'want' selections.
// The manifest-prop `keys` is required, and must equal an array of strings.
Multiplexer.prototype.haveFeeds = function (keys, opts) {
  var manifest = xtend(opts || {}, {
    keys: extractKeys(keys)
  })
  this._localHave = manifest.keys
  this._feed.extension(MANIFEST, Buffer.from(JSON.stringify(manifest)))
}

// TODO: provide feature to share a secret set of keys that are available but not announced over the wire and can be secretly requested.
// Multiplexer.prototype.secretlyHaveFeeds = function (keys) { ... }

// Sends your wishlist to the remote
// for classical multifeed `ACCEPT_ALL` behaviour both parts must call `want(remoteHas)`
Multiplexer.prototype.wantFeeds = function (keys) {
  keys = extractKeys(keys)
  debug('[REPLICATION] Sending feeds request', keys)
  this._feed.extension(REQUEST_FEEDS, Buffer.from(JSON.stringify(keys)))
  this._localWant = keys
  this._initRepl()
}


// this method is expected to be called twice, and will trigger
// the 'replicate' event when both local and remote 'wants' are available.
// calculating a sorted common denominator between both wants and availablility which
// should result in two identical arrays being built on both ends using algorithm:
//
// formula:  feedsToReplicate = (lWant - (lWant - rHave)) + (rWant - (rWant - lHave ))
//
// The result honors that each node only shares what it offers and does not receive feeds that it didn't ask for.
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

  debug('[REPLICATION] _initRepl', keys.length, keys)

  // End immedietly if there's nothing to replicate.
  if (!this._opts.live && keys.length === 0) return this._finalize()

  this.emit('replicate',  keys, startFeedReplication)

  return keys

  function startFeedReplication(feeds){
    if (!Array.isArray(feeds)) feeds = [feeds]
    self.stream.expectedFeeds = feeds.length

    // only the feeds passed to `feeds` option will be replicated (sent or received)
    // hypercore-protocol has built in protection against receiving unexpected/not asked for data.
    feeds.forEach(function(feed) {
      debug('[REPLICATION] replicating feed:', feed.key.toString('hex'))
      feed.replicate(xtend({}, self._opts, {
        stream: self.stream
      }))
    })
  }
}

/*'feed' event can be used to dynamically append feeds during live replication
 * or to provide a secret non-pre-negotiated feed.
 * Maybe send an ANNOUNCE_FEED message first containing the public-key in plain or encrypted form
 * so that we can provide a core here. Cool for cabal to be able to add feeds in live mode without having to
 * reconnect to a peer, true multifeed live replication.
 * (I don't have the brainpower to speculate what's needed for live-feed-removal right now)
Multiplexer.prototype._announceFeed = function (msg) {
  self.stream.once('feed', function(discoveryKey) {
    self.emit('announce-feed' , msg, function(feed){
      if (!feed) return // no feed provided = not interested.
      feed.replicate({stream: self.stream})
      stream.expectedFeeds++
    })
  })
}*/

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
