const fs = require('fs')
const path = require('path')
const { PassThrough } = require('stream')
const tus = require('tus-js-client')
const uuid = require('uuid')
const tee = require('tee')
const emitter = require('./WebsocketEmitter')
const request = require('request')
const serializeError = require('serialize-error')
const { jsonStringify } = require('./utils')

class Uploader {
  /**
   * @typedef {object} Options
   * @property {string} endpoint
   * @property {string=} uploadUrl
   * @property {string} protocol
   * @property {object} metadata
   * @property {number} size
   * @property {string=} fieldname
   * @property {string} pathPrefix
   * @property {string} pathSuffix
   * @property {object=} storage
   * @property {string=} path
   * @property {object=} s3
   *
   * @param {Options} options
   */
  constructor (options) {
    this.options = options
    this.token = uuid.v4()
    this.options.path = `${this.options.pathPrefix}/${Uploader.FILE_NAME_PREFIX}-${this.token}-${this.options.pathSuffix}`
    this.writer = fs.createWriteStream(this.options.path)
    /** @type {number} */
    this.emittedProgress = 0
    this.storage = options.storage

    // Stream to S3 and to the local filesystem.
    if (this.options.protocol === 's3-multipart') {
      this.s3Input = PassThrough()
      const pipe = tee(this.s3Input)
      pipe.pipe(this.writer)
      this.writer = pipe

      this.uploadS3Multipart()
    }
  }

  /**
   *
   * @param {function} callback
   */
  onSocketReady (callback) {
    emitter.once(`connection:${this.token}`, () => callback())
  }

  cleanUp () {
    fs.unlink(this.options.path, (err) => {
      if (err) {
        console.error(`unable to clean up uploaded file: ${this.options.path} err: ${err}`)
      }
    })
    emitter.removeAllListeners(`pause:${this.token}`)
    emitter.removeAllListeners(`resume:${this.token}`)
  }

  /**
   *
   * @param {Buffer | Buffer[]} chunk
   */
  handleChunk (chunk) {
    // Completed.
    if (chunk === null) {
      if (this.options.endpoint && this.options.protocol !== 'tus' && this.options.protocol !== 's3-multipart') {
        this.uploadMultipart()
      }
      return this.writer.end()
    }

    this.writer.write(chunk, () => {
      console.log(`Downloaded ${this.writer.bytesWritten} bytes`)
      if (!this.options.endpoint || this.options.protocol === 's3-multipart') return

      if (this.options.protocol === 'tus' && !this.tus) {
        return this.uploadTus()
      }
    })
  }

  /**
   *
   * @param {object} resp
   */
  handleResponse (resp) {
    resp.pipe(this.writer)
    this.writer.on('finish', () => {
      if (!this.options.endpoint || this.options.protocol === 's3-multipart') return

      if (this.options.protocol === 'tus') {
        this.uploadTus()
      } else {
        this.uploadMultipart()
      }
    })
  }

  getResponse () {
    const body = this.options.endpoint || this.options.protocol === 's3-multipart'
      ? { token: this.token }
      : 'No endpoint, file written to uppy server local storage'

    return { body, status: 200 }
  }

  /**
   * @typedef {{action: string, payload: object}} State
   * @param {State} state
   */
  saveState (state) {
    if (!this.storage) return
    this.storage.set(this.token, jsonStringify(state))
  }

  /**
   *
   * @param {number} bytesUploaded
   * @param {number | null} bytesTotal
   */
  emitProgress (bytesUploaded, bytesTotal) {
    bytesTotal = bytesTotal || this.options.size
    const percentage = (bytesUploaded / bytesTotal * 100)
    const formatPercentage = percentage.toFixed(2)
    console.log(bytesUploaded, bytesTotal, `${formatPercentage}%`)

    const dataToEmit = {
      action: 'progress',
      payload: { progress: formatPercentage, bytesUploaded, bytesTotal }
    }
    this.saveState(dataToEmit)

    // avoid flooding the client with progress events.
    const roundedPercentage = Math.floor(percentage)
    if (this.emittedProgress !== roundedPercentage) {
      this.emittedProgress = roundedPercentage
      emitter.emit(this.token, dataToEmit)
    }
  }

  /**
   *
   * @param {string} url
   * @param {object} extraData
   */
  emitSuccess (url, extraData = {}) {
    const emitData = {
      action: 'success',
      payload: Object.assign(extraData, { complete: true, url })
    }
    this.saveState(emitData)
    emitter.emit(this.token, emitData)
  }

  /**
   *
   * @param {Error} err
   * @param {object=} extraData
   */
  emitError (err, extraData = {}) {
    const dataToEmit = {
      action: 'error',
      // TODO: consider removing the stack property
      payload: Object.assign(extraData, { error: serializeError(err) })
    }
    this.saveState(dataToEmit)
    emitter.emit(this.token, dataToEmit)
  }

  uploadTus () {
    const fname = path.basename(this.options.path)
    const metadata = Object.assign({ filename: fname }, this.options.metadata || {})
    const file = fs.createReadStream(this.options.path)
    const uploader = this

    // @ts-ignore
    this.tus = new tus.Upload(file, {
      endpoint: this.options.endpoint,
      uploadUrl: this.options.uploadUrl,
      resume: true,
      uploadSize: this.options.size || fs.statSync(this.options.path).size,
      metadata,
      chunkSize: this.writer.bytesWritten,
      /**
       *
       * @param {Error} error
       */
      onError (error) {
        console.error(error)
        uploader.emitError(error)
      },
      /**
       *
       * @param {number} bytesUploaded
       * @param {number} bytesTotal
       */
      onProgress (bytesUploaded, bytesTotal) {
        uploader.emitProgress(bytesUploaded, bytesTotal)
      },
      /**
       *
       * @param {number} chunkSize
       * @param {number} bytesUploaded
       * @param {number} bytesTotal
       */
      onChunkComplete (chunkSize, bytesUploaded, bytesTotal) {
        uploader.tus.options.chunkSize = uploader.writer.bytesWritten - bytesUploaded
      },
      onSuccess () {
        uploader.emitSuccess(uploader.tus.url)
        uploader.cleanUp()
      }
    })

    this.tus.start()

    emitter.on(`pause:${this.token}`, () => {
      this.tus.abort()
    })

    emitter.on(`resume:${this.token}`, () => {
      this.tus.start()
    })
  }

  uploadMultipart () {
    const file = fs.createReadStream(this.options.path)

    // upload progress
    let bytesUploaded = 0
    file.on('data', (data) => {
      bytesUploaded += data.length
      this.emitProgress(bytesUploaded, null)
    })

    const formData = Object.assign(
      {},
      this.options.metadata,
      { [this.options.fieldname]: file }
    )
    request.post({ url: this.options.endpoint, formData, encoding: null }, (error, response, body) => {
      if (error) {
        console.error(`error: ${error}`)
        this.emitError(error)
        return
      }
      const headers = response.headers
      // remove browser forbidden headers
      delete headers['set-cookie']
      delete headers['set-cookie2']

      const respObj = {
        reponseText: body.toString(),
        status: response.statusCode,
        statusText: response.statusMessage,
        headers
      }

      if (response.statusCode >= 400) {
        console.error(`upload failed with status: ${response.statusCode}`)
        this.emitError(new Error(response.statusMessage), respObj)
      } else {
        this.emitSuccess(null, { response: respObj })
      }

      this.cleanUp()
    })
  }

  uploadS3Multipart () {
    if (!this.options.s3) {
      this.emitError(new Error('The S3 client is not configured on this uppy-server.'))
      return
    }

    const filename = path.basename(this.options.path)
    const { client, options } = this.options.s3

    this.s3Input.on('data', (chunk) => {
      console.log(`Pushing ${chunk.length} to s3`)
    })
    console.log({
      Bucket: options.bucket,
      Key: options.getKey(null, filename),
      ACL: options.acl,
      ContentType: this.options.metadata.type
    })

    const upload = require('s3-stream-upload')(client, {
      Bucket: options.bucket,
      Key: options.getKey(null, filename),
      ACL: options.acl,
      ContentType: this.options.metadata.type
    })

    const progress = setInterval(() => {
      this.emitProgress(upload.bytesWritten, null)
    }, 300)

    upload.on('error', (error) => {
      clearInterval(progress)
      console.error(`error: ${error}`)
      this.emitError(error)
      this.cleanUp()
    })
    upload.on('finish', (result) => {
      clearInterval(progress)
      console.log(result)
      this.emitSuccess(null, {
        response: {
          responseText: result.toString('utf8')
        }
      })
      this.cleanUp()
    })

    this.s3Input.pipe(upload)
  }
}

Uploader.FILE_NAME_PREFIX = 'uppy-file'

module.exports = Uploader
