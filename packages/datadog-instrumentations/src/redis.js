'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:redis:command:start')
const asyncEndCh = channel('apm:redis:command:async-end')
const endCh = channel('apm:redis:command:end')
const errorCh = channel('apm:redis:command:error')

addHook({ name: '@node-redis/client', file: 'dist/lib/client/commands-queue.js', versions: ['>=1'] }, redis => {
  shimmer.wrap(redis.default.prototype, 'addCommand', addCommand => function (command) {
    if (!startCh.hasSubscribers) {
      return addCommand.apply(this, arguments)
    }

    const name = command[0]
    const args = command.slice(1)

    startSpan(this, name, args)

    try {
      return wrap(asyncEndCh, errorCh, addCommand.apply(this, arguments))
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=2.6 <4'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'internal_send_command', internalSendCommand => function (options) {
    if (!startCh.hasSubscribers) return internalSendCommand.apply(this, arguments)

    if (!options.callback) return internalSendCommand.apply(this, arguments)

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    const cb = asyncResource.bind(options.callback)

    startSpan(this, options.command, options.args)

    options.callback = AsyncResource.bind(wrap(asyncEndCh, errorCh, cb))

    try {
      return internalSendCommand.apply(this, arguments)
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

addHook({ name: 'redis', versions: ['>=0.12 <2.6'] }, redis => {
  shimmer.wrap(redis.RedisClient.prototype, 'send_command', sendCommand => function (command, args, callback) {
    if (!startCh.hasSubscribers) {
      return sendCommand.apply(this, arguments)
    }

    const asyncResource = new AsyncResource('bound-anonymous-fn')

    startSpan(this, command, args)

    if (typeof callback === 'function') {
      const cb = asyncResource.bind(callback)
      arguments[2] = AsyncResource.bind(wrap(asyncEndCh, errorCh, cb))
    } else if (Array.isArray(args) && typeof args[args.length - 1] === 'function') {
      const cb = asyncResource.bind(args[args.length - 1])
      args[args.length - 1] = AsyncResource.bind(wrap(asyncEndCh, errorCh, cb))
    } else {
      arguments[2] = AsyncResource.bind(wrap(asyncEndCh, errorCh))
    }

    try {
      return sendCommand.apply(this, arguments)
    } catch (err) {
      err.stack // trigger getting the stack at the original throwing point
      errorCh.publish(err)

      throw err
    } finally {
      endCh.publish(undefined)
    }
  })
  return redis
})

function startSpan (client, command, args) {
  const db = client.selected_db
  const connectionOptions = client.connection_options || client.connection_option || client.connectionOption || {}
  startCh.publish({ db, command, args, connectionOptions })
}

function wrap (asyncEndCh, errorCh, done) {
  if (typeof done === 'function' || !done) {
    return wrapCallback(asyncEndCh, errorCh, done)
  } else if (isPromise(done)) {
    done.then(
      () => finish(asyncEndCh, errorCh),
      err => finish(asyncEndCh, errorCh, err)
    )
    return done
  } else if (done && done.length) {
    const lastIndex = done.length - 1
    const callback = done[lastIndex]

    if (typeof callback === 'function') {
      done[lastIndex] = wrapCallback(asyncEndCh, errorCh, done[lastIndex])
    }

    return done
  }
}

function wrapCallback (asyncEndCh, errorCh, callback) {
  return function (err) {
    finish(asyncEndCh, errorCh, err)
    if (callback) {
      return callback.apply(this, arguments)
    }
  }
}

function finish (asyncEndCh, errorCh, error) {
  if (error) {
    errorCh.publish(error)
  }
  asyncEndCh.publish(undefined)
}

function isPromise (obj) {
  return isObject(obj) && typeof obj.then === 'function'
}

function isObject (obj) {
  return typeof obj === 'object' && obj !== null
}
