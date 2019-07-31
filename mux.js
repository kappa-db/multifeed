var protocol = require('hypercore-protocol')
var readify = require('./ready')
var inherits = require('inherits')
var events = require('events')
var debug = require('debug')('multifeed')

// constants
var MULTIFEED = 'MULTIFEED'
var PROTOCOL_VERSION = '3.0.0'

// extensions
var MANIFEST = 'MANIFEST'
var REQUEST_FEEDS = 'REQUEST_FEEDS'
var REPLICATE_FEEDS = 'REPLICATE_FEEDS'

// XXX: hypercore-protocol currently requires extensions be specified in
// alphabetical order.
var SupportedExtensions = [
  MANIFEST,
  REPLICATE_FEEDS,
  REQUEST_FEEDS
]
// `key` - protocol encryption key
// `opts`- hypercore-protocol opts
function Multiplexer (key, opts) {
  if (!(this instanceof Multiplexer)) return new Multiplexer(key, opts)
  var self = this
  self._opts = opts = opts || {}
  this._id = opts._id || Math.floor(Math.random() * 1000).toString(16)
  debug(this._id + ' [REPLICATION] New mux initialized', key.toString('hex'), opts)

  // initialize
  self._localOffer = []
  self._requestedFeeds = []
  self._remoteOffer = []
  self._activeFeedStreams = {}

  var stream = this.stream = protocol(Object.assign({},opts,{
    userData: Buffer.from(JSON.stringify({
      client: MULTIFEED,
      version: PROTOCOL_VERSION
    })),
    // Extend hypercore-protocol for the main stream with multifeed events
    extensions: SupportedExtensions
  }))

  // This is the new 'fake feed' which is purely virtual
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

    // Wait a tick, otherwise the _ready handler below won't be listening for this event yet.
    process.nextTick(function () {
      self.emit('ready', header)
    })
  })

  feed.on('extension', function (type, message) {
    try {
      debug(self._id + 'Extension:', type, message.toString('utf8'))
      var data = JSON.parse(message.toString('utf8'))
      switch(type) {
        case MANIFEST:
          self._remoteOffer = uniq(self._remoteOffer.concat(data.keys))
          self.emit('manifest', data, self.requestFeeds.bind(self))
          break
        case REQUEST_FEEDS:
          self._requestHandler(data)
          break
        case REPLICATE_FEEDS:
          self._onRemoteReplicate(data)
          break
      }
    } catch (err) {
      // Catch JSON parse errors and any other errors that occur
      // during replication and destroy this remote connection
      debug('Error during recieve data handler', err)
      self._finalize(err)
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
Multiplexer.prototype.offerFeeds = function (keys, opts) {
  var manifest = Object.assign(opts || {}, {
    keys: extractKeys(keys)
  })
  debug(this._id + ' [REPLICATON] sending manifest:', manifest)
  manifest.keys.forEach(function (key) { this._localOffer.push(key) }.bind(this))
  this._feed.extension(MANIFEST, Buffer.from(JSON.stringify(manifest)))
}

// Sends your wishlist to the remote
// for classical multifeed `ACCEPT_ALL` behaviour both parts must call `want(remoteHas)`
Multiplexer.prototype.requestFeeds = function (keys) {
  keys = extractKeys(keys)
  keys.forEach(function (k) { this._requestedFeeds.push(k) }.bind(this))
  debug(this._id + ' [REPLICATION] Sending feeds request', keys)
  this._feed.extension(REQUEST_FEEDS, Buffer.from(JSON.stringify(keys)))
}

Multiplexer.prototype._requestHandler = function (keys) {
  var self = this
  var filtered = keys.filter(function(key) {
    if (self._localOffer.indexOf(key) === -1) {
      debug('[REPLICATION] Warning, remote requested feed that is not in offer', key)
      return false
    }

    // All good, we accept the key request
    return true
  })
  filtered = uniq(filtered)
  // Tell remote which keys we will replicate
  debug('[REPLICATION] Sending REPLICATE_FEEDS')
  this._feed.extension(REPLICATE_FEEDS, Buffer.from(JSON.stringify(filtered)))

  // Start replicating as promised.
  this._replicateFeeds(filtered)
}

Multiplexer.prototype._onRemoteReplicate = function (keys) {
  var self = this
  var filtered = keys.filter(function(key) {
    return self._requestedFeeds.indexOf(key) !== -1
  })

  // Start replicating as requested.
  this._replicateFeeds(filtered)
}

// Initializes new replication streams for feeds and joins their streams into
// the main stream.
Multiplexer.prototype._replicateFeeds = function(keys) {
  var self = this
  keys = uniq(keys)
  debug(this._id + '[REPLICATION] _replicateFeeds', keys.length, keys)

  this.emit('replicate', keys, startFeedReplication)

  return keys

  function startFeedReplication(feeds){
    if (!Array.isArray(feeds)) feeds = [feeds]
    self.stream.expectedFeeds += feeds.length

    // only the feeds passed to `feeds` option will be replicated (sent or received)
    // hypercore-protocol has built in protection against receiving unexpected/not asked for data.
    feeds.forEach(function(feed) {
      feed.ready(function() { // wait for each feed to be ready before replicating.
        var hexKey = feed.key.toString('hex')

        // prevent a feed from being folded into the main stream twice.
        if (typeof self._activeFeedStreams[hexKey] !== 'undefined') {
          debug(self._id + '[REPLICATION] warning! Prevented duplicate replication of: ', hexKey)
          // decrease the expectedFeeds that was unconditionally increased
          self.stream.expectedFeeds--
          return
        }

        debug(self._id + '[REPLICATION] replicating feed:', hexKey)
        var fStream = feed.replicate(Object.assign({}, {
          live: self._opts.live,
          download: self._opts.download,
          upload: self._opts.upload,
          encrypt: self._opts.encrypt,
          stream: self.stream
        }))

        // Store reference to this particular feed stream
        self._activeFeedStreams[hexKey] = fStream

        var cleanup = function(err, res) {
          if (!self._activeFeedStreams[hexKey]) return
          // delete feed stream reference
          delete self._activeFeedStreams[hexKey]
          debug(self._id + "[REPLICATION] feedStream closed:", hexKey.substr(0,8))
        }
        fStream.once('end', cleanup)
        fStream.once('error', cleanup)
      })
    })
  }
}

Multiplexer.prototype.knownFeeds = function () {
  return this._localOffer.concat(this._remoteOffer)
}

module.exports = Multiplexer

// String, String -> Boolean
function compatibleVersions (v1, v2) {
  var major1 = v1.split('.')[0]
  var major2 = v2.split('.')[0]
  return parseInt(major1) === parseInt(major2)
}

function extractKeys (keys) {
  if (!Array.isArray(keys)) keys = [keys]
  return keys.map(function(o) {
    if (typeof o === 'string') return o
    if (typeof o === 'object' && o.key) return o.key.toString('hex')
    if (o instanceof Buffer) return o.toString('utf8')
  })
    .filter(function(o) { return !!o }) // remove invalid entries
}

function uniq (arr) {
  return Object.keys(arr.reduce(function(m, i) {
    m[i]=true
    return m
  }, {})).sort()
}

