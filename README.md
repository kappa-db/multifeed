# multifeed

> multi-writer hypercore

Multifeed lets you:

1. manage many hypercores, stored together
2. replicate a local set of hypercores with a remote set of hypercores (union-syle)

It solves the problem of [hypercore](https://github.com/mafintosh/hypercore)
only allowing one writer by making it easy to manage and sync a set of
hypercores -- by a variety of authors -- across peers.

Replication works by extending the regular hypercore exchange mechanism to
include a meta-exchange, where peers share information about the feeds they
have locally, and choose which of the remote feeds they'd like to download in
exchange. Right now, the replication mechanism defaults to sharing all local
feeds and downloading all remote feeds.

## Usage

```js
var multifeed = require('multifeed')
var ram = require('random-access-memory')

var multi = multifeed('./db', { valueEncoding: 'json' })

// a multifeed starts off empty
console.log(multi.feeds().length)             // => 0

// create as many writeable feeds as you want; returns hypercores
multi.writer('local', function (err, w) {
  console.log(w.key, w.writeable, w.readable)   // => Buffer <0x..> true true
  console.log(multi.feeds().length)             // => 1

  // write data to any writeable feed, just like with hypercore
  w.append('foo', function () {
    var m2 = multifeed(hypercore, ram, { valueEncoding: 'json' })
    m2.writer('local', function (err, w2) {
      w2.append('bar', function () {
        replicate(multi, m2, function () {
          console.log(m2.feeds().length)        // => 2
          m2.feeds()[1].get(0, function (_, data) {
            console.log(data)                   // => foo
          })
          multi.feeds()[1].get(0, function (_, data) {
            console.log(data)                   // => bar
          })
        })
      })
    })
  })
})

function replicate (a, b, cb) {
  var r = a.replicate()
  r.pipe(b.replicate()).pipe(r)
    .once('end', cb)
    .once('error', cb)
}
```

## API

```js
var multifeed = require('multifeed')
```

### var multi = multifeed(storage[, opts])

Pass in a [random-access-storage](https://github.com/random-access-storage/random-access-storage) backend, and options. Included `opts` are passed into new hypercores created, and are the same as [hypercore](https://github.com/mafintosh/hypercore#var-feed--hypercorestorage-key-options)'s.

Valid `opts` include:
- `opts.encryptionKey` (string): optional encryption key to use during replication. If not provided, a default insecure key will be used.
- `opts.hypercore`: constructor of a hypercore implementation. `hypercore@8.x.x` is used from npm if not provided.

### multi.writer([name], [options], cb)

If no `name` is given, a new local writeable feed is created and returned via
`cb`.

If `name` is given and was created in the past on this local machine, it is
returned. Otherwise it is created. This is useful for managing multiple local
feeds, e.g.

```js
var main = multi.writer('main')        // created if doesn't exist
var content = multi.writer('content')  // created if doesn't exist

main === multi.writer('main')          // => true
```

`options` is an optional object which may contain: 
- `options.keypair` - an object with a custom keypair for the new writer.  This should have properties `keypair.publicKey` and `keypair.secretKey`, both of which should be buffers.

### var feeds = multi.feeds()

An array of all hypercores in the multifeed. Check a feed's `key` to
find the one you want, or check its `writable` / `readable` properties.

Only populated once `multi.ready(fn)` is fired.

### var feed = multi.feed(key)

Fetch a feed by its key `key` (a `Buffer` or hex string).

### var stream = multi.replicate(isInitiator, [opts])

Create an encrypted duplex stream for replication.

Ensure that `isInitiator` to `true` to one side, and `false` on the other. This is necessary for setting up the encryption mechanism.

Works just like hypercore, except *all* local hypercores are exchanged between
replication endpoints.

### stream.on('remote-feeds', function () { ... })

Emitted when a new batch (1 or more) of remote feeds have begun to replicate with this multifeed instance.

This is useful for knowing when `multi.feeds()` contains the full set of feeds from the remote side.

### multi.on('feed', function (feed, name) { ... })

Emitted whenever a new feed is added, whether locally or remotely.

## multi.close(cb)

Close all file resources being held by the multifeed instance. `cb` is called once this is complete.

## multi.closed

`true` if `close()` was run successfully, falsey otherwise.

# Errors

The duplex stream returned by `.replicate()` can emit, in addition to regular
stream errors, two fatal errors specific to multifeed:

- `ERR_VERSION_MISMATCH`
  - `err.code = 'ERR_VERSION_MISMATCH'`
  - `err.usVersion = 'X.Y.Z'` (semver)
  - `err.themVersion = 'A.B.C'` (semver)

- `ERR_CLIENT_MISMATCH`
  - `err.code = 'ERR_CLIENT_MISMATCH'`
  - `err.usClient = 'MULTIFEED'`
  - `err.themClient = '???'`

## Install

With [npm](https://npmjs.org/) installed, run

```
$ npm install multifeed
```

## See Also

- [multifeed-index](https://github.com/noffle/multifeed-index)
- [hypercore](https://github.com/mafintosh/hypercore)
- [kappa-core](https://github.com/noffle/kappa-core)

## License

ISC
