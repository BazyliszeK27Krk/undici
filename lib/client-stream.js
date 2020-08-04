'use strict'

const { finished } = require('stream')
const { AsyncResource } = require('async_hooks')
const {
  InvalidArgumentError,
  InvalidReturnValueError
} = require('./errors')
const util = require('./util')

class StreamHandler extends AsyncResource {
  constructor (opts, factory, callback) {
    super('UNDICI_STREAM')

    if (!opts || typeof opts !== 'object') {
      throw new InvalidArgumentError('invalid opts')
    }

    if (typeof factory !== 'function') {
      throw new InvalidArgumentError('invalid factory')
    }

    if (opts.method === 'CONNECT') {
      throw new InvalidArgumentError('invalid method')
    }

    this.opaque = opts.opaque
    this.controller = null
    this.factory = factory
    this.callback = callback
    this.res = null
    this.trailers = null
  }

  onConnect (pause, resume, error) {
    this.controller = { pause, resume, error }
  }

  onHeaders (statusCode, headers) {
    if (statusCode < 200) {
      return
    }

    const { factory, controller, opaque } = this

    this.factory = null
    const res = this.runInAsyncScope(factory, null, { statusCode, headers, opaque })

    const { callback } = this

    if (!callback) {
      // Aborted inside factory.
      return
    }

    if (
      !res ||
      typeof res.write !== 'function' ||
      typeof res.end !== 'function' ||
      typeof res.on !== 'function'
    ) {
      throw new InvalidReturnValueError('expected Writable')
    }

    res.on('drain', controller.resume)
    // TODO: Avoid finished. It registers an unecessary amount of listeners.
    finished(res, { readable: false }, (err) => {
      const { callback, res, opaque, controller, trailers } = this

      this.res = null
      if (err || !res.readable) {
        util.destroy(res, res)
      }

      if (err) {
        controller.error(err)
      }

      this.callback = null
      callback(err, err ? null : { opaque, trailers })
    })

    if (typeof res.destroy === 'function') {
      res.destroy = this.runInAsyncScope.bind(this, res.destroy, res)
    }

    this.res = res
  }

  onData (chunk) {
    const { res, controller } = this

    if (!this.runInAsyncScope(res.write, res, chunk)) {
      controller.pause()
    }
  }

  onComplete (trailers) {
    const { res } = this

    this.trailers = trailers || {}
    this.runInAsyncScope(res.end, res)
  }

  onError (err) {
    const { res, callback } = this

    this.factory = null

    if (res) {
      this.res = null
      util.destroy(res, err)
    } else if (callback) {
      this.callback = null
      // TODO: Async Scope
      process.nextTick(callback, err, null)
    }
  }
}

module.exports = function stream (client, opts, factory, callback) {
  if (callback === undefined) {
    return new Promise((resolve, reject) => {
      stream(client, opts, factory, (err, data) => {
        return err ? reject(err) : resolve(data)
      })
    })
  }

  if (typeof callback !== 'function') {
    throw new InvalidArgumentError('invalid callback')
  }

  try {
    client.dispatch(opts, new StreamHandler(opts, factory, callback))
  } catch (err) {
    process.nextTick(callback, err, null)
  }
}
