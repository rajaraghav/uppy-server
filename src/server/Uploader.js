const fs = require('fs')
const path = require('path')
const tus = require('tus-js-client')
const uuid = require('uuid')
const createTailReadStream = require('fs-tail-stream')
const emitter = require('./WebsocketEmitter')
const request = require('request')
const serializeError = require('serialize-error')
const { jsonStringify } = require('./utils')
const logger = require('./logger')

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
      .on('error', (err) => logger.error(err, 'uploader.write.error'))
    /** @type {number} */
    this.emittedProgress = 0
    this.storage = options.storage
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
        logger.error(`cleanup failed for: ${this.options.path} err: ${err}`, 'uploader.cleanup.error')
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
    logger.debug(`${this.token.substring(0, 8)} ${this.writer.bytesWritten} bytes`, 'uploader.download.progress')

    const protocol = this.options.protocol || 'multipart'

    // The download has completed; close the file and start an upload if necessary.
    if (chunk === null) {
      if (this.options.endpoint && protocol === 'multipart') {
        this.uploadMultipart()
      }
      return this.writer.end()
    }

    this.writer.write(chunk, () => {
      if (protocol === 's3-multipart' && !this.s3Upload) {
        return this.uploadS3Streaming()
      }
      if (!this.options.endpoint) return

      if (protocol === 'tus' && !this.tus) {
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

    const protocol = this.options.protocol || 'multipart'

    this.writer.on('finish', () => {
      if (protocol === 's3-multipart') {
        this.uploadS3Full()
      }

      if (!this.options.endpoint) return

      if (protocol === 'tus') {
        this.uploadTus()
      }
      if (protocol === 'multipart') {
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
    logger.debug(
      `${this.token.substring(0, 8)} ${bytesUploaded} ${bytesTotal} ${formatPercentage}%`,
      'uploader.upload.progress'
    )

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
        logger.error(error, 'uploader.tus.error')
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
        logger.error(error, 'upload.multipart.error')
        this.emitError(error)
        return
      }
      const headers = response.headers
      // remove browser forbidden headers
      delete headers['set-cookie']
      delete headers['set-cookie2']

      const respObj = {
        responseText: body.toString(),
        status: response.statusCode,
        statusText: response.statusMessage,
        headers
      }

      if (response.statusCode >= 400) {
        logger.error(`upload failed with status: ${response.statusCode}`, 'upload.multipar.error')
        this.emitError(new Error(response.statusMessage), respObj)
      } else {
        this.emitSuccess(null, { response: respObj })
      }

      this.cleanUp()
    })
  }

  /**
   * Upload the file to S3 while it is still being downloaded.
   */
  uploadS3Streaming () {
    const file = createTailReadStream(this.options.path, {
      tail: true
    })

    this.writer.on('finish', () => {
      file.close()
    })

    return this._uploadS3Managed(file)
  }

  /**
   * Upload the file to S3 after it has been fully downloaded.
   */
  uploadS3Full () {
    const file = fs.createReadStream(this.options.path)
    return this._uploadS3Managed(file)
  }

  /**
   * Upload a stream to S3.
   */
  _uploadS3Managed (stream) {
    if (!this.options.s3) {
      this.emitError(new Error('The S3 client is not configured on this uppy-server.'))
      return
    }

    const filename = this.options.metadata.filename || path.basename(this.options.path)
    const { client, options } = this.options.s3

    const upload = client.upload({
      Bucket: options.bucket,
      Key: options.getKey(null, filename),
      ACL: options.acl,
      ContentType: this.options.metadata.type,
      Body: stream
    })

    this.s3Upload = upload

    upload.on('httpUploadProgress', ({ loaded, total }) => {
      this.emitProgress(loaded, total)
    })

    upload.send((error, data) => {
      this.s3Upload = null
      if (error) {
        this.emitError(error)
      } else {
        this.emitSuccess(null, {
          response: {
            responseText: JSON.stringify(data),
            headers: {
              'content-type': 'application/json'
            }
          }
        })
      }
      this.cleanUp()
    })
  }
}

Uploader.FILE_NAME_PREFIX = 'uppy-file'

module.exports = Uploader
