var multicore = require('.')
var hypercore = require('hypercore')

var ram = require('random-access-memory')

var multi = multicore(hypercore, './db', { valueEncoding: 'json' })

var w = multi.writer()
console.log(w.key)
w.append('foo', console.log)
