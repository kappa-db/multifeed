var multicore = require('.')
var hypercore = require('hypercore')

var ram = require('random-access-memory')

var multi = multicore(hypercore, './db', { valueEncoding: 'json' })

multi.writer(function (err, w) {
  console.log(w.key.toString('hex'))
  w.append('foo', console.log)
})

