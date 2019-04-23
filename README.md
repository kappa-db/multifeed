# multifeed

> multi-writer hypercore

Small module that manages multiple hypercores: feeds you create locally are
writeable, others' are readonly. Replicating with another multifeed peers
exchanges the content of all of the hypercores.

## Usage

```js
var multifeed = require('multifeed')
var hypercore = require('hypercore')
var ram = require('random-access-memory')

var multi = multifeed(hypercore, './db', { valueEncoding: 'json' })

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

### var multi = multifeed(hypercore, storage[, opts])

Pass in the a hypercore module (`require('hypercore')`), a
[random-access-storage](https://github.com/random-access-storage/random-access-storage)
backend, and options. Included `opts` are passed into new hypercores created,
and are the same as
[hypercore](https://github.com/mafintosh/hypercore#var-feed--hypercorestorage-key-options)'s.

Valid `opts` include:
- `opts.key` (string): optional encryption key to use during replication.

### multi.writer([name, ]cb)

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

### var feeds = multi.feeds()

An array of all hypercores in the multifeed. Check a feed's `key` to
find the one you want, or check its `writable` / `readable` properties.

Only populated once `multi.ready(fn)` is fired.

### var feed = multi.feed(key)

Fetch a feed by its key `key` (a `Buffer` or hex string).

### var stream = multi.replicate([opts])

Create a duplex stream for replication.

Works just like hypercore, except *all* local hypercores are exchanged between
replication endpoints.

**Note**: this stream is *not* an encrypted channel.

### multi.on('feed', function (feed, name) { ... })

Emitted whenever a new feed is added, whether locally or remotely.

## multi.close(cb)

Close all file resources being held by the multifeed instance. `cb` is called once this is complete.

**NOTE**: Once a multifeed is closed, use of the rest of the API is basically undefined behaviour.

## multi.closed

`true` if `close()` was run successfully, falsey otherwise.

## Install

With [npm](https://npmjs.org/) installed, run

```
$ npm install multifeed
```

## Replication Policies

You can control which feeds get replicated by providing a policy object:

```js

var randomReplication = {
  init: function(multifeed) {
    // called on multifeed.ready
    // use it for initalization.
  },
  have: function(local, share) {
    // called on peer connection
    // select which feeds to share
    share(local.keys, {
      random: local.keys.map(function() { return Math.random() - 0.5 })
    })
  },
  want: function(remote, request) {
    // called when remote peer's
    // share list is available.
    // remote.keys is always available
    // remote contains also all custom props sent by remote.
    var keys = remote.keys.filter(function(k, i){
        return remote.random[i] > 0.5
    })
    request(keys)
  }
}

var multi = multifeed(hypercore, './db', { valueEncoding: 'json' })
multi.use(randomReplication)

```
## See Also

- [multifeed-index](https://github.com/noffle/multifeed-index)
- [hypercore](https://github.com/mafintosh/hypercore)
- [kappa-core](https://github.com/noffle/kappa-core)

## License

ISC
