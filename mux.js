var Protocol = require('hypercore-protocol')
var readify = require('./ready')
var inherits = require('inherits')
var events = require('events')
var debug = require('debug')('multifeed')
var once = require('once')

// constants
var MULTIFEED = 'MULTIFEED'
var PROTOCOL_VERSION = '4.0.0'

// extensions
var EXT_HANDSHAKE = 'MULTIFEED_HANDSHAKE'
var EXT_MANIFEST = 'MULTIFEED_MANIFEST'
var EXT_REQUEST_FEEDS = 'MULTIFEED_REQUEST_FEEDS'
var EXT_REPLICATE_FEEDS = 'MULTIFEED_REPLICATE_FEEDS'

// errors
var ERR_VERSION_MISMATCH = 'ERR_VERSION_MISMATCH'
var ERR_CLIENT_MISMATCH = 'ERR_CLIENT_MISMATCH'

// `key` - protocol encryption key
function Multiplexer (isInitiator, key, opts) {
  if (!(this instanceof Multiplexer)) return new Multiplexer(isInitiator, key, opts)
  var self = this
  self._opts = opts = opts || {}
  this._id = opts._id || Math.floor(Math.random() * 10000).toString(16)
  this._initiator = isInitiator
  debug(this._id + ' [REPLICATION] New mux initialized', opts)

  // initialize
  self._localOffer = []
  self._requestedFeeds = []
  self._remoteOffer = []
  self._activeFeedStreams = {}

  var onFirstKey = true

  self._ondiscoverykey = function (key) {
    if (onFirstKey) {
      onFirstKey = false
      if (!this.stream.remoteVerified(key)) {
        this._finalize(new Error('Exchange key did not match remote'))
      }
    }
  }.bind(self)

  if (Protocol.isProtocolStream(isInitiator)) {
    var stream = this.stream = isInitiator
    stream.on('discovery-key', self._ondiscoverykey)
  } else {
    var stream = this.stream = new Protocol(isInitiator, Object.assign({}, opts, {
      ondiscoverykey: self._ondiscoverykey
    }))
  }

  this._handshakeExt = this.stream.registerExtension(EXT_HANDSHAKE, {
    onmessage: onHandshake,
    onerror: function (err) {
      self._finalize(err)
    },
    encoding: 'json'
  })

  function onHandshake (header) {
    debug(self._id + ' [REPLICATION] recv\'d handshake: ', JSON.stringify(header))
    var err

    if (!compatibleVersions(header.version, PROTOCOL_VERSION)) {
      debug(self._id + ' [REPLICATION] aborting; version mismatch (us=' + PROTOCOL_VERSION + ')')
      err = new Error('protocol version mismatch! us=' + PROTOCOL_VERSION + ' them=' + header.version)
      err.code = ERR_VERSION_MISMATCH
      err.usVersion = PROTOCOL_VERSION
      err.themVersion = header.version
      self._finalize(err)
      return
    }

    if (header.client !== MULTIFEED) {
      debug(self._id + ' [REPLICATION] aborting; Client mismatch! expected ', MULTIFEED, 'but got', header.client)
      err = new Error('Client mismatch! expected ' + MULTIFEED + ' but got ' + header.client)
      err.code = ERR_CLIENT_MISMATCH
      err.usClient = MULTIFEED
      err.themClient = header.client
      self._finalize(err)
      return
    }

    // Wait a tick, otherwise the _ready handler below won't be listening for this event yet.
    process.nextTick(function () {
      self.emit('ready', header)
    })
  }

  // Open a virtual feed that has the key set to the shared key.
  this._feed = stream.open(key, {
    onopen: function () {
      onFirstKey = false
      if (!stream.remoteVerified(key)) {
        debug(self._id + ' [REPLICATION] aborting; shared key mismatch')
        self._finalize(new Error('shared key version mismatch!'))
        return
      }

      // send handshake
      self._handshakeExt.send(Object.assign({}, opts, {
        client: MULTIFEED,
        version: PROTOCOL_VERSION,
        userData: opts.userData
      }))
    }
  })

  this._manifestExt = stream.registerExtension(EXT_MANIFEST, {
    onmessage: function (msg) {
      debug(self._id, 'RECV\'D Ext MANIFEST:', JSON.stringify(msg))
      self._remoteOffer = uniq(self._remoteOffer.concat(msg.keys))
      self.emit('manifest', msg, self.requestFeeds.bind(self))
    },
    onerror: function (err) {
      self._finalize(err)
    },
    encoding: 'json'
  })

  this._requestFeedsExt = stream.registerExtension(EXT_REQUEST_FEEDS, {
    onmessage: function (msg) {
      debug(self._id, 'RECV\'D Ext REQUEST_FEEDS:', msg)
      self._onRequestFeeds(msg)
    },
    onerror: function (err) {
      self._finalize(err)
    },
    encoding: 'json'
  })

  this._replicateFeedsExt = stream.registerExtension(EXT_REPLICATE_FEEDS, {
    onmessage: function (msg) {
      debug(self._id, 'RECV\'D Ext REPLICATE_FEEDS:', msg)
      self._onRemoteReplicate(msg)
    },
    onerror: function (err) {
      self._finalize(err)
    },
    encoding: 'json'
  })

  if (!self._opts.live) {
    self.stream.on('prefinalize', onPrefinalize)
    function onPrefinalize () {
      self.stream.removeListener('prefinalize', onPrefinalize)
      self._feed.close()
      debug(self._id + ' [REPLICATION] feed finish/prefinalize (' + self.stream.prefinalize._tick + ')')
    }
  }

  this._ready = readify(function (done) {
    self.once('ready', function (remote) {
      debug(self._id + ' [REPLICATION] remote connected and ready')
      done(remote)
    })
  })
}

inherits(Multiplexer, events.EventEmitter)

Multiplexer.prototype.ready = function (cb) {
  this._ready(cb)
}

Multiplexer.prototype._finalize = function (err) {
  if (err) {
    debug(this._id + ' [REPLICATION] destroyed due to', err)
    this.stream.emit('error', err)
    this.stream.destroy(err)
  } else {
    debug(this._id + ' [REPLICATION] finalized', err)
    this.stream.finalize()
  }
  this.stream.removeListener('discovery-key', this._ondiscoverykey)
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
  this._manifestExt.send(manifest)
}

// Sends your wishlist to the remote
// for classical multifeed `ACCEPT_ALL` behaviour both parts must call `want(remoteHas)`
Multiplexer.prototype.requestFeeds = function (keys) {
  keys = extractKeys(keys)
  keys.forEach(function (k) { this._requestedFeeds.push(k) }.bind(this))
  debug(this._id + ' [REPLICATION] Sending feeds request', keys)
  this._requestFeedsExt.send(keys)
}

Multiplexer.prototype._onRequestFeeds = function (keys) {
  var self = this
  var filtered = keys.filter(function (key) {
    if (self._localOffer.indexOf(key) === -1) {
      debug('[REPLICATION] Warning, remote requested feed that is not in offer', key)
      return false
    }

    // All good, we accept the key request
    return true
  })
  filtered = uniq(filtered)
  // Tell remote which keys we will replicate
  debug(this._id, '[REPLICATION] Sending REPLICATE_FEEDS')
  this._replicateFeedsExt.send(filtered)

  // Start replicating as promised.
  this._replicateFeeds(filtered, false)
}

Multiplexer.prototype._onRemoteReplicate = function (keys) {
  var self = this
  var filtered = keys.filter(function (key) {
    return self._requestedFeeds.indexOf(key) !== -1
  })

  // Start replicating as requested.
  this._replicateFeeds(filtered, true, function () {
    self.stream.emit('remote-feeds')
  })
}

// Initializes new replication streams for feeds and joins their streams into
// the main stream.
Multiplexer.prototype._replicateFeeds = function (keys, terminateIfNoFeeds, cb) {
  if (!cb) cb = noop

  var self = this
  keys = uniq(keys)
  debug(this._id, '[REPLICATION] _replicateFeeds', keys.length, keys)

  // Postpone stream finalization until all pending cores are added. Otherwise
  // a non-live replication might terminate because it thinks all feeds have
  // been synced, even though new ones are still in the process of being set up
  // for sync.
  this.stream.prefinalize.wait()

  this.emit('replicate', keys, once(startFeedReplication))

  return keys

  function startFeedReplication (feeds) {
    if (!Array.isArray(feeds)) feeds = [feeds]

    var pending = feeds.length

    // Stop postponement of prefinalization.
    self.stream.prefinalize.continue()

    // only the feeds passed to `feeds` option will be replicated (sent or received)
    // hypercore-protocol has built in protection against receiving unexpected/not asked for data.
    feeds.forEach(function (feed) {
      feed.ready(function () { // wait for each feed to be ready before replicating.
        var hexKey = feed.key.toString('hex')

        // prevent a feed from being folded into the main stream twice.
        if (typeof self._activeFeedStreams[hexKey] !== 'undefined') {
          if (!--pending) cb()
          return
        }

        debug(self._id, '[REPLICATION] replicating feed:', hexKey)
        var fStream = feed.replicate(self._initiator, Object.assign({}, {
          live: self._opts.live,
          download: self._opts.download,
          upload: self._opts.upload,
          encrypt: self._opts.encrypt,
          stream: self.stream
        }))

        // Store reference to this particular feed stream
        self._activeFeedStreams[hexKey] = fStream

        var cleanup = function (_, res) {
          fStream.removeListener('end', cleanup)
          fStream.removeListener('error', cleanup)
          if (!self._activeFeedStreams[hexKey]) return
          // delete feed stream reference
          delete self._activeFeedStreams[hexKey]
          debug(self._id, '[REPLICATION] feedStream closed:', hexKey.substr(0, 8))
        }
        fStream.once('end', cleanup)
        fStream.once('error', cleanup)

        if (!--pending) cb()
      })
    })

    // Bail on replication entirely if there were no feeds to add, and none are pending or active.
    if (feeds.length === 0 && Object.keys(self._activeFeedStreams).length === 0 && terminateIfNoFeeds) {
      debug(self._id, '[REPLICATION] terminating mux: no feeds to sync')
      self._feed.close()
      process.nextTick(cb)
    } else if (feeds.length === 0) {
      process.nextTick(cb)
    }
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
  return keys.map(function (o) {
    if (typeof o === 'string') return o
    if (typeof o === 'object' && o.key) return o.key.toString('hex')
    if (o instanceof Buffer) return o.toString('utf8')
  })
    .filter(function (o) { return !!o }) // remove invalid entries
}

function uniq (arr) {
  return Object.keys(arr.reduce(function (m, i) {
    m[i] = true
    return m
  }, {})).sort()
}

function noop () {}
