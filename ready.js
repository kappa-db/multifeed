module.exports = function (work, noauto) {
  var ready = false
  var fns = []

  var startWork = function () {
    process.nextTick(function () {
      work(function () {
        ready = true
        fns.forEach(process.nextTick)
      })
    })
  }

  if (!noauto) startWork() // default behaviour

  return function (fn) {
    if (noauto) { // start on first invocation
      noauto = false
      startWork()
    }

    if (!ready) fns.push(fn)
    else process.nextTick(fn)
  }
}

