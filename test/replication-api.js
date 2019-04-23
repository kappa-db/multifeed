var test = require('tape')
var hypercore = require('hypercore')
var ram = require('random-access-memory')
var multifeed = require('../index')

var bindStorage = function(subpath) {
  return function(p) {
    return ram(subpath + '/' + p)
  }
}

test('Key exchange API', function(t){
  t.plan(26)
  var multi = multifeed(hypercore, bindStorage("first/"), { valueEncoding: 'json' })
  var m2 = multifeed(hypercore, bindStorage("second/"), { valueEncoding: 'json' })
  // A policy that only replicates feeds relevant to cats
  // This policy shares everything but accepts only feeds tagged as 'cat'
  var CatPolicy = {
    have: function(local, share) {
      t.ok(local.keys instanceof Array, "Param 'local' should be an array of localy available feeds")
      t.ok(typeof share === 'function', "Param 'share' should be a function")

      // 'Marketing phase' extract zeroth entry for all feeds an attach it
      // to the feed-exchange
      extractEntries(this.feeds(), function(entries) {
        // Share all feeds including the sounds they make.
        share(local.keys, {
          says: entries.map(function(e) { return e.says })
        })
      })
    },
    want: function(remote, request) {
      t.ok(remote.keys instanceof Array, "Param 'remote' should be an array of remotely available feeds")
      t.ok(typeof request === 'function', "Param 'request' should be a function")
      // Ok let's request only keys relevant to our logic.
      var keys = remote.keys.filter(function(k, i){
        return remote.says[i] === 'meow'
      })
      request(keys)
    }
  }

  // let both multifeeds use the same policy
  multi.use(CatPolicy)
  m2.use(CatPolicy)

  var replicateAndVerify = function(err) {
    t.error(err)
    t.equal(multi.feeds().length, 3)
    t.equal(m2.feeds().length, 3)
    // Verify that both catfeeds and the original dog-feed is present.
    extractEntries(multi.feeds(), function(ent1) {
      t.equal(ent1.filter(function(i) { return i.says === 'meow'}).length, 2, 'Should contain two cats')
      t.equal(ent1.filter(function(i) { return i.says === 'squeek'}).length, 0, 'Should not contain any mice')
      t.equal(ent1.filter(function(i) { return i.says === 'woof'}).length, 1, 'Should contain a dog')

      // Verify that both catfeeds and the original rat-feed is present.
      extractEntries(m2.feeds(), function(ent2) {
        t.equal(ent2.filter(function(i) { return i.says === 'meow'}).length, 2, 'Should contain two cats')
        t.equal(ent2.filter(function(i) { return i.says === 'woof'}).length, 0, 'Should not contain any dogs')
        t.equal(ent2.filter(function(i) { return i.says === 'squeek'}).length, 1, 'Should contain a rat')
        t.end()
      })
    })
  }

  // Initialize a cat feed on the first multifeed
  multi.writer('a1',function(err, catFeed){
    t.error(err)
    // Append a cat-log
    catFeed.append({says: 'meow', name: 'billy'}, function(err){
      t.error(err)
      // Initialize a dog feed on the first multifeed
      multi.writer('a2', function(err, dogFeed) {
        t.error(err)
        // Append a dog-log
        dogFeed.append({says: 'woof', name: 'rupert'}, function(err) {
          t.error(err)
          // Initialize another cat feed on the second multifeed
          m2.writer('b1', function(err, cat2Feed) {
            t.error(err)
            // Append cat-log
            cat2Feed.append({says: 'meow', name: 'amy'}, function(err) {
              t.error(err)
              // And lastly a rat feed on the second multifeed.
              m2.writer('b2', function(err, ratFeed) {
                t.error(err)
                ratFeed.append({says: 'squeek', name: 'engelbrecht'}, function(err){
                  t.error(err)
                  t.ok(true, "Test data setup ok")
                  // Replicating
                  var r = multi.replicate()
                  r.pipe(m2.replicate()).pipe(r)
                    .once('end', replicateAndVerify)
                })
              })
            })
          })
        })
      })
    })
  })
})

function extractEntries(feeds, cb) {
  var entries = []
  var f = function (i) {
    if (typeof feeds[i] === 'undefined') return cb(entries)
    feeds[i].get(0, function(err, entry){
      entries.push(entry)
      f(i+1)
    })
  }
  f(0)
}
