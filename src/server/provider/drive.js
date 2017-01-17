const fs = require('fs')
const path = require('path')
const request = require('request')
const purest = require('purest')({ request })
const mime = require('mime-types').lookup

class Drive {
  constructor (options) {
    options.provider = 'google'
    options.alias = 'drive'

    this.client = purest(options)
  }

  list (options, done) {
    const directory = options.directory || 'root'
    const trashed = options.trashed || false

    return this.client
      .query()
      .get('files')
      .where({ q: `'${directory}' in parents and trashed=${trashed}` })
      .auth(options.token)
      .request(done)
  }

  stats ({ id, token }, done) {
    return this.client.query().get(`files/${id}`).auth(token).request()
  }

  upload (options, done) {
    return this.client
      .query('upload-drive')
      .update('files')
      .where({ uploadType: 'multipart' })
      .upload([
        {
          'Content-Type': 'application/json',
          body: JSON.stringify({ title: path.basename(options.path) })
        },
        {
          'Content-Type': mime(path.extname(options.path)),
          body: options.body || fs.createReadStream(options.path)
        }
      ])
      .auth(options.token)
      .request(done)
  }

  download ({ id, token }) {
    return new Promise((resolve, reject) => {
      this.client
        .query()
        .get(`files/${id}`)
        .where({ alt: 'media' })
        .auth(token)
        .request()
        .on('response', (response) => {
          response.pause()
          resolve(response)
        })
        .on('error', (err) => {
          console.log('there was an error:', err)
        })
    })
  }
}

exports = module.exports = Drive
