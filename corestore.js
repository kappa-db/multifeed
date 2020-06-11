const crypto = require('hypercore-crypto')
const Multiplexer = require('./mux')
const debug = require('debug')('multifeed')
const { EventEmitter } = require('events')

class CorestoreMuxerTopic extends EventEmitter {
  constructor (corestore, rootKey, opts = {}) {
    super()
    this.corestore = corestore
    this.rootKey = rootKey
    this._feeds = new Map()
    this.streams = new Map()
  }

  addStream (stream, info) {
    const self = this
    const isInitiator = !!info.client
    const opts = { stream, live: true }

    const mux = new Multiplexer(isInitiator, this.rootKey, opts)

    mux.on('manifest', onmanifest)
    mux.on('replicate', onreplicate)
    mux.ready(onready)

    stream.once('end', cleanup)
    stream.once('error', cleanup)
    this.streams.set(stream, { mux, cleanup })

    function onready () {
      const keys = Array.from(self._feeds.keys())
      if (keys.length) mux.offerFeeds(keys)
    }

    function onmanifest (manifest) {
      mux.requestFeeds(manifest.keys)
    }

    function onreplicate (keys, repl) {
      for (const key of keys) {
        if (self._feeds.has(key)) continue
        self.addFeed(key)
        self.emit('feed', self._feeds.get(key))
      }
      const feeds = keys.map(key => self._feeds.get(key))
      repl(feeds)
    }

    function cleanup (_err) {
      mux.removeListener('manifest', onmanifest)
      mux.removeListener('replicate', onreplicate)
      self.streams.delete(stream)
    }
  }

  removeStream (stream) {
    if (!this.streams.has(stream)) return
    const { cleanup } = this.streams.get(stream)
    cleanup()
  }

  feeds () {
    return Array.from(this._feeds.values())
  }

  addFeed (key) {
    if (!Buffer.isBuffer(key)) key = Buffer.from(key, 'hex')
    const feed = this.corestore.get(key)
    const hkey = feed.key.toString('hex')
    this._feeds.set(hkey, feed)
    for (const { mux } of this.streams.values()) {
      mux.ready(() => {
        if (mux.knownFeeds().indexOf(hkey) === -1) {
          debug('Forwarding new feed to existing peer:', hkey)
          mux.offerFeeds([hkey])
        }
      })
    }
  }
}

module.exports = class CorestoreMuxer {
  constructor (networker) {
    this.networker = networker
    this.corestore = networker.corestore
    this.muxers = new Map()
    this.streamsByKey = new Map()

    this._joinListener = this._onjoin.bind(this)
    this._leaveListener = this._onleave.bind(this)
    this.networker.on('handshake', this._joinListener)
    this.networker.on('stream-closed', this._leaveListener)
  }

  _onjoin (stream, info) {
    const remoteKey = stream.remotePublicKey
    const keyString = remoteKey.toString('hex')
    this.streamsByKey.set(keyString, { stream, info })
    for (const mux of this.muxers.values()) {
      mux.addStream(stream, info)
    }
  }

  _onleave (stream, info, finishedHandshake) {
    if (!finishedHandshake || (info && info.duplicate)) return
    for (const mux of this.muxers.values()) {
      mux.removeStream(stream)
    }
  }

  join (rootKey, opts) {
    if (!Buffer.isBuffer(rootKey)) rootKey = Buffer.from(rootKey, 'hex')
    const hkey = rootKey.toString('hex')
    if (this.muxers.has(hkey)) return this.muxers.get(hkey)

    const discoveryKey = crypto.discoveryKey(rootKey)
    const mux = new CorestoreMuxerTopic(this.corestore, rootKey, opts)
    this.networker.join(discoveryKey)
    this.muxers.set(hkey, mux)
    for (const { stream, info } of this.streamsByKey.values()) {
      mux.addStream(stream, info)
    }
    return mux
  }
}
