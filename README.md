# uppy-server

<img src="http://uppy.io/images/logos/uppy-dog-full.svg" width="120" alt="Uppy logo — a superman puppy in a pink suit" align="right">

[![Build Status](https://travis-ci.org/transloadit/uppy-server.svg?branch=master)](https://travis-ci.org/transloadit/uppy-server)

Uppy-server is a server integration for [Uppy](https://github.com/transloadit/uppy) file uploader.

It handles the server-to-server communication between your server and file storage providers such as Google Drive, Dropbox,
Instagram, etc.

## Supported Providers

As of now uppy-server is integrated to work with:

- Google Drive
- Dropbox
- Instagram
- Amazon S3
- Local disk

## Install

```bash
npm install uppy-server
```

## Usage

Uppy-server may either be used as pluggable express app, which you plug to your already existing server, or it may simply be run as a standalone server:

### Plug to already existing server

```javascript

var express = require('express')
var bodyParser = require('body-parser')
var uppy = require('uppy-server')

var app = express()
app.use(bodyParser.json())
...
// be sure to place this anywhere after app.use(bodyParser.json())
const options = {
  providerOptions: {
    google: {
      key: 'GOOGLE_KEY',
      secret: 'GOOGLE_SECRET'
    }
  },
  server: {
    host: 'localhost:3020',
    protocol: 'http',
  },
  filePath: '/path/to/folder/'
}

app.use(uppy.app(options))

```
[See](#options) for valid configuration options.

To enable uppy socket for realtime feed to the client while upload is going on, you call the `socket` method like so.

```javascript
...
var server = app.listen(PORT)

uppy.socket(server, options)

```

### Run as standalone server
Please ensure that the required env varaibles are set before runnning/using uppy-server as a standalone server. [See](#configure-standalone).

```bash
$ uppy-server
```

If you cloned the repo from gtihub and want to run it as a standalone server, you may also run the following command from within its
directory

```bash
npm run start:production
```

#### Configure Standalone
To run uppy-server as a standalone server, you are required to set your uppy options via environment variables

```bash
####### Mandatory variables ###########
export UPPYSERVER_DOMAIN="YOUR SERVER DOMAIN"
export UPPYSERVER_DATADIR="PATH/TO/UPLOAD/DIRECTORY"

###### Optionional variables ##########
export UPPYSERVER_PROTOCOL="YOUR SERVER PROTOCOL" # defaults to http
export UPPYSERVER_PORT="YOUR SERVER PORT" # defaults to 3020
export UPPYSERVER_PATH="/SERVER/PATH/TO/WHERE/UPPY/SERVER/LIVES" # defaults to ''

# use this in place of UPPYSERVER_PATH if the server path should not be
# handled by the express.js app but maybe by an external server configuration
# instead.
export UPPYSERVER_IMPLICIT_PATH="/SERVER/PATH/TO/WHERE/UPPY/SERVER/LIVES"

# To enable redis session storage
# and enable upload progress storage
export UPPYSERVER_REDIS_URL="REDIS URL" 

# If used with Dropbox
export UPPYSERVER_DROPBOX_KEY="YOUR DROPBOX KEY"
export UPPYSERVER_DROPBOX_SECRET="YOUR DROPBOX SECRET"

# If used with Google Drive
export UPPYSERVER_GOOGLE_KEY="YOUR GOOGLE KEY"
export UPPYSERVER_GOOGLE_SECRET="YOUR GOOGLE SECRET"

# If used with Instagram Drive
export UPPYSERVER_INSTAGRAM_KEY="YOUR INSTAGRAM KEY"
export UPPYSERVER_INSTAGRAM_SECRET="YOUR INSTAGRAM SECRET"

# If used with s3
export UPPYSERVER_AWS_KEY="YOUR AWS KEY"
export UPPYSERVER_AWS_SECRET="YOUR AWS SECRET"
export UPPYSERVER_AWS_BUCKET="YOUR AWS S3 BUCKET"
export UPPYSERVER_AWS_REGION="AWS REGION"

# for multiple server instances with multiple subdomains
export UPPYSERVER_OAUTH_DOMAIN="sub.domain.com"
export UPPYSERVER_DOMAINS="sub1.domain.com,sub2.domain.com,sub3.domain.com"

# Only set this variable if you want uppy server to set the "i-am" header
# in every response.
export UPPYSERVER_SELF_ENDPOINT="THIS SHOULD BE SAME AS YOUR DOMAIN + PATH"
export
export
```

### Options

```javascript
{
  providerOptions: {
    google: {
      key: "***",
      secret: "***"
    },
    dropbox: {
      key: "***",
      secret: "***"
    },
    instagram: {
      key: "***",
      secret: "***"
    },
    s3: {
      key: "***",
      secret: "***",
      bucket: "bucke-name",
      region: "us-east-1"
    }
  },
  server: {
    host: "localhost:3020", // or yourdomain.com
    protocol: "http"
  },
  filePath: "path/to/download/folder"
}
```

1. filePath(required) - Full path to the directory where provider files would temporarily be downloaded to.

2. redisUrl(optional) - URL to running redis server. If this is set, the state of uploads would be stored temporarily. This helps for resumed uploads after a browser crash from the client. The stored upload would be sent back to the client on reconnection.

3. providerOptions(optional) - An object containing credentials (`key` and `secret`) for each provider you would like to enable. Please [see](#supported-providers) for supported providers.

4. server(optional) - An object with details mainly used to carry out oauth authentication from any of the enable providers above. Though it is optional, it is required if you would be enabling any of the supported providers. The following are the server options you may set

  - protocol - `http | https`
  - host(required) - your server host (e.g localhost:3020, mydomain.com)
  - path - the server path to where the uppy app is sitting (e.g if uppy server is at `mydomain.com/uppy`, then the path would be `/uppy`).
  - oauthDoamin - if you have multiple instances of uppy server with different(and maybe dynamic) subdomains, you can set a master domain(e.g `sub1.mydomain.com`) to handle your oauth authentication for you. This would then redirect to the slave subdomain with the required credentials on completion.
  - validHosts - if you are setting a master `oauthDomain`, you need to set a list of valid hosts, so the master oauth handler can validate the host of the uppy instance requesting the authentication. This is basically a list of valid domains running your uppy server instances. The list may also contain regex patterns. e.g `['sub2.mydomain.com', 'sub3.mydomain.com', '(\\w+).mydomain.com']`

5. customProviders - This option enables you add custom providers along with the already supported providers. [See](#adding-custom-providers) for more.

### Adding Custom Providers

As of now, uppy-server supports **Google Drive**, **Dropbox** and **Instagram** out of the box, but you may also choose to add your custom providers. You can do this by passing the `customPrivders` 
option when calling the uppy `app` method. The custom provider is expected to supoort Oauth 1 or 2 for authentication/authorization.

```javascript
let options = {
    customProviders: {
        myprovidername: {
            config: {
                authorize_url: "https://mywebsite.com/authorize",
                access_url: "https://mywebsite.com/token",
                oauth: 2,
                key: "***",
                secret: "**",
                scope: ["read", "write"]
            },
            module: require('/path/to/provider/module')
        }
    }
}

uppy.app(options)
```

The `customProviders` option should be an object containing each custom provider.
Each custom provider would in turn be an object with two keys, `config` and `module`. The `config` option would contain Oauth API settings, while the `module` would point to the provider module.

To work well with uppy server, the **Module** must be a class with the following methods.

1. `list (options, done)` - lists json data of user files (e.g list of all the files in a particular directory).
  - `options` - is an object containing the following attributes
    - token - authorization token(retrieved from oauth process) to send along with your request
    - directory - the `id/name` of the directory whose data is to be retrieved. This may be ignored if it doesn't apply to your provider
    - query - expressjs query params object received by the server(just in case there's some data you need in there).
  - `done (err, response, body)` - the callback that should be called when the request to your provider is done. As the signature indicates the following data should be passed along to the callback `err`, `response`, and `body`.
2. `download (options, onData, onResponse)` - downloads a particular file from the provider.
  - `options` - is an object containing the following attributes
    - token - authorization token(retrieved from oauth process) to send along with your request.
    - id - id of the file being downloaded.
  - `onData (chunk)` - a callback that should be called with each data chunk received on download. This is useful if the size of the downloaded file can be pre-determined. This would allow for pipelined upload of the file(to the desired destination), while the download is still going on.
  - `onResponse (response)` - if the size of the downloaded file can not be pre-determined by uppy-server, then this callback should be called in place of the `onData` callback. This callback would be called after the download is done, and would the downloaded data(response) as argument.

## Development

1. To setup uppy-server for local development, please clone the repo and install like so:

```bash
git clone https://github.com/transloadit/uppy-server && cd uppy-server && npm install
```


2. Configure your enviorment variables by copying the `env.example.sh` file to `env.sh` and edit it to its correct values.

```bash
cp env.example.sh env.sh
$EDITOR env.sh
```


3. To start the server, simply run:

```bash
npm run start
```

This would get the uppy-server running on `http://localhost:3020`.

It also expects the [uppy client](https://github.com/transloadit/uppy) to be running on `http://localhost:3452`

## Running example

An example server is running at http://server.uppy.io, which is deployed via
[Frey](https://github.com/kvz/frey), using the following [Freyfile](infra/Freyfile.toml).

All the secrets are stored in `env.infra.sh`, so using `env.infra.example.sh`, you could
use the same Freyfile but target a different cloud vendor with different secrets, and run your own
uppy-server.

## Logging

Requires Frey, if you haven't set it up yet type

```bash
npm run install:frey
```

afterwards, production logs are available through:

```bash
npm run logtail
```

This requires at least the `FREY_ENCRYPTION_SECRET` key present in your `./env.sh`.
