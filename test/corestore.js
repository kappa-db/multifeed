const test = require('tape')
const crypto = require('hypercore-crypto')
const hyperswarm = require('hyperswarm')
const ram = require('random-access-memory')
const Corestore = require('corestore')
const dht = require('@hyperswarm/dht')
const SwarmNetworker = require('corestore-swarm-networking')

const Muxer = require('../corestore')
const multifeed = require('..')

const BOOTSTRAP_PORT = 3100
var bootstrap = null

const KEY_A = Buffer.alloc(32, 1)
const KEY_B = Buffer.alloc(32, 2)

test('corestore networker example', async function (t) {
  // Create two distinct corestores and networkers.
  // They will communicate over a localhost DHT.
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  // Init some cores.
  const core1 = store1.get()
  const core2a = store2.get()
  const core2b = store2.get()

  await append(core1, 'hello')
  const data = await get(core1, 0)
  t.same(data, Buffer.from('hello'))

  // For each networker, setup the mulitfeed mux wrapper.
  const muxer1 = new Muxer(networker1)
  const muxer2 = new Muxer(networker2)

  // For each mux wrapper, join on two different multifeed rootkeys.
  const mux1a = muxer1.join(KEY_A, { name: 'm1a' })
  const mux1b = muxer1.join(KEY_B, { name: 'm1b' })

  const mux2a = muxer2.join(KEY_A, { name: 'mux2a' })
  const mux2b = muxer2.join(KEY_B, { name: 'mux2b' })

  // Person 1 adds the same feed to both multifeeds.
  mux1a.addFeed(core1.key)
  mux1b.addFeed(core1.key)

  // Person2 adds two different feeds to each multifeed.
  mux2a.addFeed(core2a.key)
  mux2b.addFeed(core2b.key)

  // Wait for things to sync.
  // TODO: Remove timeout, wait for event instead.
  await timeout(500)

  // Check that the muxers for the same keys arrived at the same set of feeds.
  t.deepEqual(toKeys(mux1a.feeds()), toKeys([core1, core2a]))
  t.deepEqual(toKeys(mux2a.feeds()), toKeys([core1, core2a]))
  t.deepEqual(toKeys(mux1b.feeds()), toKeys([core1, core2b]))
  t.deepEqual(toKeys(mux2b.feeds()), toKeys([core1, core2b]))

  // Check that the cores actually replicated.
  let checked = false
  for (const feed of mux2b.feeds()) {
    if (feed.key.toString('hex') === core1.key.toString('hex')) {
      const data = await get(store2.get(core1.key), 0)
      t.same(data, Buffer.from('hello'))
      checked = true
    }
  }
  if (!checked) t.fail('missing data check')

  // Cleanup.
  await cleanup([networker1, networker2])
  t.end()
})

test('corestore to multifeed over hyperswarm', async t => {
  const muxkey = KEY_A

  // setup a corestore muxer
  const { store, networker } = await create()
  const core = store.get()
  const muxer = new Muxer(networker)
  const mux = muxer.join(muxkey)
  mux.addFeed(core.key)

  // setup a multifeed muxer plus network
  const multi = multifeed(ram, { encryptionKey: muxkey })
  let multifeedWriter
  await new Promise(resolve => {
    multi.writer('local', (err, feed) => {
      multifeedWriter = feed
      t.error(err)
      feed.append('hello', resolve)
    })
  })
  const swarm2 = hyperswarm({
    bootstrap: `localhost:${BOOTSTRAP_PORT}`
  })
  swarm2.join(crypto.discoveryKey(muxkey), { announce: true, lookup: true })
  let didConnect = false
  // Just pipe all connections directly into the multifeed replication stream.
  // This is what e.g. cabal currently does, and would need a seperate hyperswarm
  // instance to replicate multiple multifeeds in parallel (before this patch).
  swarm2.on('connection', (socket, details) => {
    if (didConnect) return
    didConnect = true
    const isInitiator = !!details.client
    const stream = multi.replicate(isInitiator, { live: true })
    stream.pipe(socket).pipe(stream)
  })

  // wait and see
  await timeout(500)
  t.deepEqual(toKeys(multi.feeds()), toKeys([multifeedWriter, core]))
  t.deepEqual(toKeys(mux.feeds()), toKeys([multifeedWriter, core]))
  swarm2.destroy()
  await cleanup([networker])
})

function toKeys (feeds) {
  return feeds.map(f => f.key.toString('hex')).sort()
}

function append (core, data) {
  return new Promise((resolve, reject) => {
    core.append(data, err => {
      if (err) return reject(err)
      return resolve()
    })
  })
}
function get (core, idx, opts = {}) {
  return new Promise((resolve, reject) => {
    core.get(idx, opts, (err, data) => {
      if (err) return reject(err)
      return resolve(data)
    })
  })
}

function timeout (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function create (opts = {}) {
  if (!bootstrap) {
    bootstrap = dht({
      bootstrap: false
    })
    bootstrap.listen(BOOTSTRAP_PORT)
    await new Promise(resolve => {
      return bootstrap.once('listening', resolve)
    })
  }
  const store = new Corestore(ram)
  await store.ready()
  const networker = new SwarmNetworker(store, {
    ...opts,
    bootstrap: `localhost:${BOOTSTRAP_PORT}`
  })
  // logEvents(networker, 'networker')
  return { store, networker }
}

async function cleanup (networkers) {
  for (let networker of networkers) {
    await networker.close()
  }
  if (bootstrap) {
    await bootstrap.destroy()
    bootstrap = null
  }
}

function logEvents (emitter, name) {
  const emit = emitter.emit.bind(emitter)
  emitter.emit = function (event, ...args) {
    console.log(name, event)
    if (event === 'replication-error') console.log(args)
    emit(event, ...args)
  }
}
