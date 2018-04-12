# multi-hypercore

> multi-writer hypercore

Small module that manages multiple hypercores: yours are writeable, others' are
not. Replicating with another multi-hypercore peers exchanges the content of all of
the hypercores.

## Usage

```js
var multicore = require('multi-hypercore')
var ram = require('random-access-memory')

var multi = multicore('./db', { valueEncoding: 'json' })

// a multi-hypercore starts off empty
console.log(multi.feeds().length)             // => 0

// create as many writeable feeds as you want; returns hypercores
var w = multi.writer()
console.log(w.key, w.writeable, w.readable)   // => Buffer <0x..> true true
console.log(multi.feeds().length)             // => 1

// write data to any writeable feed, just like with hypercore
w.append('foo', function () {
  var m2 = multicore(ram, { valueEncoding: 'json' })
  m2.writer().append('bar', function () {
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

function replicate (a, b, cb) {
  var r = a.replicate()
  r.pipe(b.replicate()).pipe(r)
    .once('end', cb)
    .once('error', cb)
}
```

## API

```js
var multicore = require('multi-hypercore')
```

### var multi = multicore(storage[, opts])

same params as hypercore creation; inherited by calls to `multi.writer()`

### multi.writer(cb)

create a new local writeable feed; `cb(err, feed)`

### var feeds = multi.feeds()

array of hypercores

### var stream = multi.replicate([opts])

create a duplex stream for replication

just like hypercore, except *all* hypercores are replicated

## Install

With [npm](https://npmjs.org/) installed, run

```
$ npm install multi-hypercore
```

## License

ISC
