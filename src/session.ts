/*
 * Copyright (c) 2020, 2026, Oracle and/or its affiliates.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * https://oss.oracle.com/licenses/upl.
 */

import {
  CallOptions,
  Channel,
  ChannelCredentials,
  ChannelOptions,
  credentials,
  connectivityState as ConnectivityState,
  experimental,
  status,
} from '@grpc/grpc-js'
import {EventEmitter} from 'events'
import {PathLike, readFileSync} from 'fs'
import {event} from './events'

import {NamedCache, NamedCacheClient, NamedMap} from './named-cache-client'
import {util} from './util'
import * as net from "node:net"

/**
 * Supported {@link Session} options.
 */
export class Options {
  /**
   * Regular expression for basic validation of IPv4 address.
   */
  private static readonly ADDRESS_REGEXP = RegExp('^(coherence:///\\S+|coherence:\\S+:\\d{1,5}|coherence:///\\S+:\\d{1,5}/[a-zA-Z0-9]+|coherence:///\\S+/[a-zA-Z0-9]+|\\S+:\\d{1,5})$')

  /**
   * Address of the target Coherence cluster.  If not explicitly set, this defaults to {@link Session.DEFAULT_ADDRESS}.
   */
  private _address: string

  /**
   * The scope name used to link this `Session` with to the corresponding
   * `ConfigurableCacheFactory` on the server.
   *
   * @private
   */
  private _scope: string

  /**
   * Defines the request timeout, in `milliseconds`, that will be applied to each remote call.
   *
   * If not explicitly set, this defaults to `60000`.
   */
  private _requestTimeoutInMillis: number

  /**
   * Defines the timeout, in `milliseconds`, that will be applied when waiting for
   * the `gRPC` stream to become ready.
   *
   * If not explicitly set, this defaults to `60000`.
   */
  private _readyTimeoutInMillis: number

  /**
   * The serialization format.  Currently, this is always `json`.
   */
  private readonly _format: string

  /**
   * The `gRPC` `ChannelOptions`.
   *
   * @see https://github.com/grpc/grpc-node/tree/master/packages/grpc-js
   */
  private _channelOptions: { [key: string]: any }

  /**
   * A function taking no arguments returning a gRPC CallOptions instance.
   * If not explicitly configured, then the call options will simply define
   * the request timeout.  If the developer explicitly sets this, they are responsible
   * for configuring the timeout (i.e., the call options deadline)
   */
  private _callOptions: () => CallOptions

  /**
   * Flag indicating mutations are no longer allowed.
   */
  private locked: boolean = false

  /**
   * Optional TLS configuration.
   */
  private _tls: TlsOptions

  /**
   * Return the IPv4 host address and port in the format of `[host]:[port]`.
   *
   * @return the IPv4 host address and port in the format of `[host]:[port]`
   */
  get address (): string {
    return this._address
  }

  /**
   * Set the IPv4 host address and port in the format of `[host]:[port]`.
   * <p>
   * If the Coherence cluster port is available, it's possible to uss
   * the Coherence name service in order to resolve and connect to the available
   * gRPC proxies. If using this functionality, the format is
   * `coherence:///<host>([:port]|[/cluster-name]|[:port/cluster-name])`.
   *
   * @param address  the IPv4 host address and port in the format of `[host]:[port]`
   *                 or the Coherence name service format of
   *                 `coherence:///<host>([:port]|[/cluster-name]|[:port/cluster-name])`
   */
  set address (address: string) {
    if (this.locked) {
      return
    }
    // ensure address is sane
    if (!Options.ADDRESS_REGEXP.test(address)) {
      throw new Error('Expected address format is \'<hostname>:<port>\' or \'coherence:<host>([:port]|[/cluster-name]|[:port/cluster-name])\'.  Configured: ' + address)
    }

    this._address = address
  }

  /**
   * Returns the request timeout in `milliseconds`.
   *
   * @return the request timeout in `milliseconds`
   */
  get requestTimeoutInMillis (): number {
    return this._requestTimeoutInMillis
  }

  /**
   * Set the request timeout in `milliseconds`.  If the timeout value is zero or less, then no timeout will be applied.
   *
   * @param timeout the request timeout in `milliseconds`
   */
  set requestTimeoutInMillis (timeout: number) {
    if (this.locked) {
      return
    }
    if (timeout <= 0) {
      timeout = Number.POSITIVE_INFINITY
    }
    this._requestTimeoutInMillis = timeout
  }

  /**
   * Returns the ready timeout in `milliseconds`.
   *
   * @return the ready timeout in `milliseconds`
   */
  get readyTimeoutInMillis(): number {
    return this._readyTimeoutInMillis
  }

  /**
   * Set the ready timeout in `milliseconds`.  If the timeout value is zero or less, then no timeout will be applied.
   *
   * @param timeout the request timeout in `milliseconds`
   */
  set readyTimeoutInMillis(timeout: number) {
    if (this.locked) {
      return
    }
    if (timeout <= 0) {
      timeout = Number.POSITIVE_INFINITY
    }
    this._readyTimeoutInMillis = timeout
  }

  /**
   * Return the scope name used to link this `Session` with to the corresponding
   * `ConfigurableCacheFactory` on the server.
   *
   * @return the scope name used to link this `Session` with to the corresponding
   *         `ConfigurableCacheFactory` on the server
   */
  get scope (): string {
    return this._scope
  }

  /**
   * Set the scope name used to link this `Session` with to the corresponding
   * `ConfigurableCacheFactory` on the server.
   *
   * @return the scope name used to link this `Session` with to the corresponding
   *         `ConfigurableCacheFactory` on the server
   */
  set scope (value: string) {
    this._scope = value
  }

  /**
   * Return the `gRPC` `ChannelOptions`.
   */
  get channelOptions(): { [p: string]: any } {
    return this._channelOptions
  }

  /**
   * Set the `gRPC` `ChannelOptions`.
   *
   * @param value the `gRPC` `ChannelOptions`
   *
   * @see https://github.com/grpc/grpc-node/tree/master/packages/grpc-js
   */
  set channelOptions(value: { [p: string]: any }) {
    if (this.locked) {
      return
    }
    this._channelOptions = value
  }

  /**
   * The serialization format used by this session.  This library currently supports JSON serialization only, thus
   * this always returns 'json'.
   *
   * @return 'json'
   */
  get format (): string {
    return this._format
  }

  /**
   * Returns the TLS-specific configuration options.
   *
   * @return the TLS-specific configuration options
   */
  get tls (): TlsOptions {
    return this._tls
  }

  /**
   * Set the TLS-specific configuration options.
   *
   * @param tls the TLS-specific configuration options
   */
  set tls (tls: TlsOptions) {
    this._tls = tls
  }

  /**
   * Sets the gRPC CallOptions that will be applied to each request made using this session.
   *
   * @param callOptions the gRPC CallOptions that will be applied to each request made using this session
   */
  set callOptions (callOptions: () => CallOptions) {
    if (this.locked) {
      return
    }
    this._callOptions = callOptions
  }

  /**
   * Returns a function that will return the gRPC CallOptions that will be applied to each request made using this session.
   *
   * @return a function that will return the gRPC CallOptions that will be applied to each request made using this session
   */
  get callOptions (): () => CallOptions {
    return this._callOptions
  }

  /**
   * Once called, no further mutations can be made.
   * @hidden
   */
  lock(): void {
    this.locked = true
    this.tls.lock()
  }

  /**
   * Construct a new {@link Options}.
   */
  constructor () {
    this._address = (process.env.grpc_proxy_address ||
                     process.env.COHERENCE_GRPC_PROXY_ADDRESS ||
                     process.env.COHERENCE_SERVER_ADDRESS)
        || Session.DEFAULT_ADDRESS

    if (process.env.COHERENCE_GRPC_PROXY_ADDRESS !== undefined) {
      console.warn("The COHERENCE_GRPC_PROXY_ADDRESS environment variable"
                   + " is deprecated. Please use COHERENCE_SERVER_ADDRESS instead.")
    }

    this._requestTimeoutInMillis = Session.DEFAULT_REQUEST_TIMEOUT
    this._readyTimeoutInMillis = Session.DEFAULT_READY_TIMEOUT
    this._format = Session.DEFAULT_FORMAT
    this._scope = Session.DEFAULT_SCOPE
    this._channelOptions = {}
    this._tls = new TlsOptions()

    const self = this
    this._callOptions = function () {
      return {
        deadline: Date.now() + self.requestTimeoutInMillis
      }
    }
  }
}

/**
 * Options specific to the configuration of TLS.
 */
export class TlsOptions {
  /**
   * If `true`, prevents further mutations to the options.
   */
  private locked: boolean = false

  /**
   * Enable/disable TLS support.
   */
  private _enabled: boolean = false

  /**
   * The CA certificate paths (separated by ',').
   */
  private _caCertPath?: PathLike

  /**
   * The client certificate path.
   */
  private _clientCertPath?: PathLike

  /**
   * The client certificate key.
   */
  private _clientKeyPath?: PathLike


  constructor() {
    this._clientKeyPath = process.env.COHERENCE_TLS_CLIENT_KEY || undefined
    this._clientCertPath = process.env.COHERENCE_TLS_CLIENT_CERT || undefined
    this._caCertPath = process.env.COHERENCE_TLS_CERTS_PATH || undefined
    this._enabled = this._clientKeyPath !== undefined
        && this._clientCertPath !== undefined && this._caCertPath !== undefined
  }

  /**
   * Returns `true` if TLS is to be enabled.
   *
   * @return `true` if TLS is to be enabled.
   */
  get enabled (): boolean {
    return this._enabled
  }

  /**
   * Enables/disables TLS support.
   *
   * @param value  `true` to enable TLS, otherwise `false` (default)
   */
  set enabled (value: boolean) {
    if (this.locked) {
      return
    }
    this._enabled = value
  }

  /**
   * Return the configured CA certificate paths.
   *
   * @return the configured CA certificate paths, if any
   */
  get caCertPath (): PathLike | undefined {
    return this._caCertPath
  }

  /**
   * Sets the comma-delimited CA certificate paths.
   *
   * @param value  the comma-delimited CA certificate paths
   */
  set caCertPath (value: PathLike | undefined) {
    if (this.locked) {
      return
    }
    this._caCertPath = value
  }

  /**
   * Return the client certificate path.
   *
   * @return the client certificate path, if any
   */
  get clientCertPath (): PathLike | undefined {
    return this._clientCertPath
  }

  /**
   * Sets the client certificate path.
   *
   * @param value the client certificate path, if any
   */
  set clientCertPath (value: PathLike | undefined) {
    if (this.locked) {
      return
    }
    this._clientCertPath = value
  }

  /**
   * Returns the configured client certificate key path.
   *
   * @return the configured client certificate key path, if any
   */
  get clientKeyPath (): PathLike | undefined {
    return this._clientKeyPath
  }

  /**
   * Set the client certificate key path.
   *
   * @param value the client certificate key path
   */
  set clientKeyPath (value: PathLike | undefined) {
    if (this.locked) {
      return
    }
    this._clientKeyPath = value
  }

  /**
   * Once called, no further mutations can be made.
   * @hidden
   */
  lock(): void {
    this.locked = true
  }
}

/**
 * Session represents a logical connection to an endpoint. It also
 * acts as a factory for creating caches.
 *
 * This class also extends EventEmitter and emits the following
 * events:
 * 1. {@link event.MapLifecycleEvent.DESTROYED}: when the underlying cache is destroyed
 * 2. {@link event.MapLifecycleEvent.TRUNCATED}: When the underlying cache is truncated
 * 3. {@link event.MapLifecycleEvent.RELEASED}: When the underlying cache is released
 * 4. {@link event.SessionLifecycleEvent.CONNECTED}`: when the Session detects the underlying `gRPC` channel has connected.
 * 4. {@link event.SessionLifecycleEvent.DISCONNECTED}`: when the Session detects the underlying `gRPC` channel has disconnected
 * 5. {@link event.SessionLifecycleEvent.RECONNECTED}`: when the Session detects the underlying `gRPC` channel has re-connected
 * 5. {@link event.SessionLifecycleEvent.CLOSED}`: when the Session has been closed
 */
export class Session
  extends EventEmitter {
  /**
   * The default target address to connect to Coherence gRPC server.
   */
  public static readonly DEFAULT_ADDRESS = 'localhost:1408'

  /**
   * The default request timeout.
   */
  public static readonly DEFAULT_REQUEST_TIMEOUT = 60000

  /**
   * The default `gRPC` stream ready timeout.
   */
  public static readonly DEFAULT_READY_TIMEOUT = 30000

  /**
   * The default scope.
   */
  public static readonly DEFAULT_SCOPE = ''

  /**
   * The default serialization format: 'json'
   */
  public static readonly DEFAULT_FORMAT = 'json'

  /**
   * Flag indicating if {@link close} has been invoked.
   */
  private markedForClose: boolean = false

  /**
   * Flag indicating the session has been closed.
   */
  private _closed: boolean = false

  /**
   * An internal cache using a composite key based on the cache name and serialization
   * format allowing the same cache instance to be used with different serialization formats.
   * that the keys are of the form <cache_name>:<serialization_format>.
   */
  private caches = new Map<string, NamedCacheClient>()

  /**
   * The {@link Options} used to create this {@link Session}.
   */
  private readonly _sessionOptions: Options

  /**
   * The gRPC ChannelCredentials to use.
   */
  private readonly _channelCredentials: ChannelCredentials

  /**
   * The gRPC Channel to use for all the {@link NamedCacheClient} that are created by this {@link Session}.
   */
  private readonly _channel: Channel

  /**
   * The set of options to use while creating a {@link NamedCacheClient}.
   */
  private readonly _clientOptions: object = {}

  /**
   * Promise that will resolve once the session has been closed.
   */
  private readonly sessionClosedPromise: Promise<boolean>

  /**
   * Construct a new `Session` based on the provided {@link Options}.
   *
   * @param sessionOptions  the {@link Options}
   */
  constructor (sessionOptions?: Options | object) {
    super()

    experimental.registerResolver("coherence", CoherenceResolver)

    if (sessionOptions) {
      this._sessionOptions = Object.assign(new Options(), sessionOptions)
      // @ts-ignore  -- added for 'tls' index access
      this._sessionOptions.tls = Object.assign(new TlsOptions(), sessionOptions['tls'])
    } else {
      this._sessionOptions = new Options()
    }

    // If TLS is enabled then create an SSL channel credentials object.
    if (this.options.tls.enabled) {
      let skipValidation: string | undefined = process.env.COHERENCE_IGNORE_INVALID_CERTS|| undefined
      if (skipValidation !== undefined) {
        console.warn("WARNING: you have turned off SSL certificate validation. This is insecure and not recommended.")
      }

      let caCert: Buffer = Session.readFile('caCert', this.options.tls.caCertPath)
      let clientKey: Buffer = Session.readFile('clientKey', this.options.tls.clientKeyPath)
      let clientCert: Buffer = Session.readFile('clientCert', this.options.tls.clientCertPath)

      if (skipValidation !== undefined) {
        this._channelCredentials = credentials.createSsl(caCert, clientKey,
            clientCert, {checkServerIdentity: () => undefined})
      } else {
        this._channelCredentials = credentials.createSsl(caCert, clientKey, clientCert)
      }
    } else {
      this._channelCredentials = credentials.createInsecure()
    }

    let channel = this._channel = new Channel(this.options.address,
                                              this.channelCredentials,
                                              this.options.channelOptions)

    // register handler to monitoring gRPC channel state.
    // When transitioning from READY to any other state, other than SHUTDOWN,
    // emit the `disconnect` event.
    // When transitioning from any other state,
    // other than SHUTDOWN, to READY, emit the 'reconnect' event.
    let connected: boolean = false
    let firstConnect: boolean = true
    let lastState: number = 0
    let callback = async () => {
      let state = channel.getConnectivityState(false)
      lastState = state
      if (state === ConnectivityState.SHUTDOWN) {
        // nothing to do
        return
      } else if (state === ConnectivityState.READY) {
        if (!firstConnect && !connected) {
          this.emit(event.SessionLifecycleEvent.RECONNECTED)
          connected = true
        } else if (firstConnect && !connected){
          this.emit(event.SessionLifecycleEvent.CONNECTED)
          firstConnect = false
          connected = true
        }
      } else {
        if (connected) {
          this.emit(event.SessionLifecycleEvent.DISCONNECTED)
          connected = false
        }
      }
      let deadline = Number.POSITIVE_INFINITY
      if (state !== ConnectivityState.READY) {
        deadline = Date.now() + this._sessionOptions.readyTimeoutInMillis
      }
      channel.watchConnectivityState(state, deadline, callback)
    }
    channel.watchConnectivityState(ConnectivityState.READY, Number.POSITIVE_INFINITY, callback)

    // channel will now be shared by all caches created by this session
    this._clientOptions = {
      channelOverride: channel
    }

    this.sessionClosedPromise = new Promise((resolve) => {
      const self = this
      const handler = function () {
        if (self.markedForClose && self.caches.size == 0) {
          self._closed = true
          resolve(true)
        }
      }
      self.on(event.MapLifecycleEvent.RELEASED, handler)
        .on(event.MapLifecycleEvent.DESTROYED, handler)
        .on(event.SessionLifecycleEvent.CLOSED, handler)
    })
    this._sessionOptions.lock()
  }

  /**
   * An internal method to read a cert file given its path.
   *
   * @param certType   the type of the certificate. Used only while creating an error message
   * @param nameOrURL  the path or URL to the cert
   *
   * @returns The {@link Buffer} containing the certificate.
   */
  private static readFile (certType: string, nameOrURL?: PathLike): Buffer {
    if (!nameOrURL) {
      throw new Error('When TLS is enabled, ' + certType + ' cannot be undefined or null')
    }
    return readFileSync(nameOrURL)
  }

  /**
   * Return the {@link Options} (read-only) used to configure this session.
   *
   * @return the {@link Options} (read-only) used to configure this session
   */
  get options (): Options {
    return this._sessionOptions
  }

  /**
   * Return the gRPC ChannelCredentials used by this session.
   *
   * @return the gRPC ChannelCredentials used by this session
   */
  get channelCredentials (): ChannelCredentials {
    return this._channelCredentials
  }

  /**
   * Return the scope name used to link this `Session` with to the corresponding
   * `ConfigurableCacheFactory` on the server.
   *
   * @return return the scope name used to link this `Session` with to the corresponding
   * `ConfigurableCacheFactory` on the server.
   */
  get scope (): string {
    return this._sessionOptions.scope
  }

  /**
   * Return the underlying `gRPC` Channel used by this session.
   *
   * @return the underlying `gRPC` Channel used by this session
   */
  get channel (): Channel {
    return this._channel
  }

  /**
   * Return the number of active caches created by this session.
   *
   * @return the number of active caches created by this session
   */
  get activeCacheCount (): number {
    return this.caches.size
  }

  /**
   * Returns an array of cache names for those caches that are currently active.
   *
   * @return an array of cache names for those caches that are currently active
   */
  get activeCaches (): Array<NamedCacheClient> {
    const array = new Array<NamedCacheClient>()
    for (const cache of this.caches.values()) {
      array.push(cache)
    }
    return array
  }

  /**
   * Return a `set` of cache names for those caches that are currently active.
   *
   * @return a `set` of cache names for those caches that are currently active
   */
  get activeCacheNames (): Set<string> {
    const set = new Set<string>()
    for (const cache of this.caches.values()) {
      set.add(cache.name)
    }
    return set
  }

  /**
   * Return the client options used to configure this session.
   *
   * @return the client options used to configure this session
   * @internal
   */
  get clientOptions (): object {
    return this._clientOptions
  }

  /**
   * This is an alias for `Session.options.address`.
   *
   * @return the IPv4 host address and port in the format of `[host]:[port]`
   */
  get address (): string {
    return this._sessionOptions.address
  }

  /**
   * This is a shortcut to invoke the {@link Session options callOptions} function.
   *
   * @return the gRPC CallOptions that will be applied to each request made using this session
   */
  callOptions (): CallOptions {
    return this._sessionOptions.callOptions()
  }

  /**
   * Returns a {@link NamedCache} for the specified cache name.
   *
   * @param name    the cache name
   * @param format  the serialization format for keys and values stored within the cache
   */
  getCache<K, V> (name: string, format: string = Session.DEFAULT_FORMAT): NamedCache<K, V> {
    if (this.markedForClose) {
      throw new Error('Session is closing')
    }
    if (this._closed) {
      throw new Error('Session has been closed')
    }

    const cacheKey = Session.makeCacheKey(name, format)
    const serializer = util.SerializerRegistry.instance().serializer(format)

    let namedCache = this.caches.get(cacheKey)
    if (!namedCache) {
      namedCache = new NamedCacheClient(name, this, serializer)
      this.setupEventHandlers(namedCache)
      this.caches.set(cacheKey, namedCache)
    }

    return namedCache
  }

  /**
   * Returns a {@link NamedMap} for the specified map name.
   *
   * @param name    the cache name
   * @param format  the serialization format for keys and values stored within the cache
   */
  getMap<K, V> (name: string, format: string = Session.DEFAULT_FORMAT): NamedMap<K, V> {
    return this.getCache(name, format) as NamedMap<K, V>
  }

  /**
   * Close the {@link Session}.
   */
  async close (): Promise<void> {
    if (this.markedForClose) {
      return
    }

    this.markedForClose = true
    for (const entry of this.caches.entries()) {
      await entry[1].release()
    }
    this._channel.close()

    this.emit(event.SessionLifecycleEvent.CLOSED)
    return Promise.resolve()
  }

  /**
   * Returns `true` if the session is closed.
   *
   * @return `true` if the session is closed
   */
  get closed (): boolean {
    return this._closed
  }

  /**
   * Returns a promise that will resolve to `true` once the session has been closed.
   *
   * @return a promise that will resolve to `true` once the session has been closed
   */
  waitUntilClosed (): Promise<boolean> {
    return this.sessionClosedPromise
  }

  /**
   * Create a composite key based on the provided cache name and serialization format.
   *
   * @param cacheName  the cache name
   * @param format     the serialization format
   *
   * @return a composite key based on the provided cache name and serialization format
   */
  private static makeCacheKey (cacheName: string, format: string): string {
    return cacheName + ':' + format
  }

  /**
   * Returns `true` if the key contains the given cache name.
   *
   * @param key        the internal cache key
   * @param cacheName  the name of the cache
   *
   * @return `true` if the key contains the given cache name
   * @private
   */
  private static isKeyForCacheName (key: string, cacheName: string): boolean {
    return key.startsWith(cacheName + ':')
  }

  /**
   * Attach event handlers to the given cache.
   *
   * @param cache  the cache to attach event handlers to
   * @private
   */
  private setupEventHandlers (cache: NamedCacheClient) {
    const self = this
    cache.on(event.MapLifecycleEvent.DESTROYED, (cacheName: string) => {
      // Our keys in caches Map are of the form cacheName:format.
      // We will destroy all caches whose key starts with 'cacheName:'
      for (const key of self.caches.keys()) {
        if (Session.isKeyForCacheName(key, cacheName)) {
          self.caches.delete(key)
          self.emit(event.MapLifecycleEvent.DESTROYED, cacheName)
        }
      }
    })

    cache.on(event.MapLifecycleEvent.RELEASED, (cacheName: string, format: string) => {
      self.caches.delete(Session.makeCacheKey(cacheName, format))
      self.emit(event.MapLifecycleEvent.RELEASED, cacheName, format)
    })
  }
}

enum ResolveState {
  CHANNEL,
  CONNECTION,
  DONE,
  INITIAL,
  LOOKUP,
}

class LookupState {
  state: ResolveState = ResolveState.INITIAL
  query: string
  result?: string
  channel?: Buffer
  resolve?: (value: (PromiseLike<void> | void)) => void;
  reject?: (reason?: any) => void
  waitResolve: Promise<void>

  constructor(query: string) {
    this.query = query
    this.waitResolve = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

/**
 * INTERNAL: Implementation of the gRPC Resolver that will resolve gRPC proxies endpoints
 * using the Coherence name service.
 */
export class CoherenceResolver implements experimental.Resolver {

  private static readonly MULTIPLEXED_SOCKET = Buffer.from([90, 193, 224, 0])
  private static readonly NAME_SERVICE_SUB_PORT = Buffer.from([0, 0, 0, 3])
  private static readonly CONNECTION_OPEN = Buffer.from([
    0, 1, 2, 0, 66, 0, 1, 14, 0, 0, 66, 166, 182, 159, 222, 178, 81,
    1, 65, 227, 243, 228, 221, 15, 2, 65, 143, 246, 186, 153, 1, 3,
    65, 248, 180, 229, 242, 4, 4, 65, 196, 254, 220, 245, 5, 5, 65, 215,
    206, 195, 141, 7, 6, 65, 219, 137, 220, 213, 10, 64, 2, 110, 3,
    93, 78, 87, 2, 17, 77, 101, 115, 115, 97, 103, 105, 110, 103, 80,
    114, 111, 116, 111, 99, 111, 108, 2, 65, 2, 65, 2, 19, 78, 97, 109,
    101, 83, 101, 114, 118, 105, 99, 101, 80, 114, 111, 116, 111, 99,
    111, 108, 2, 65, 1, 65, 1, 5, 160, 2, 0, 0, 14, 0, 0, 66, 174, 137,
    158, 222, 178, 81, 1, 65, 129, 128, 128, 240, 15, 5, 65, 152, 159,
    129, 128, 8, 6, 65, 147, 158, 1, 64, 1, 106, 2, 110, 3, 106, 4, 113,
    5, 113, 6, 78, 8, 67, 108, 117, 115, 116, 101, 114, 66, 9, 78, 9, 108,
    111, 99, 97, 108, 104, 111, 115, 116, 10, 78, 5, 50, 48, 50, 51, 51, 12,
    78, 16, 67, 111, 104, 101, 114, 101, 110, 99, 101, 67, 111, 110, 115,
    111, 108, 101, 64, 64,
  ])
  private static readonly CHANNEL_OPEN = Buffer.from([
    0, 11, 2, 0, 66, 1, 1, 78, 19, 78, 97, 109, 101, 83, 101, 114, 118,
    105, 99, 101, 80, 114, 111, 116, 111, 99, 111, 108, 2, 78, 11, 78,
    97, 109, 101, 83, 101, 114, 118, 105, 99, 101, 64,
  ])
  private static readonly NS_LOOKUP_REQ_ID = Buffer.from([1, 1, 0, 66, 0, 1, 78])
  private static readonly REQ_END_MARKER = Buffer.from([64])

  private static readonly NAME_SERVICE: string = 'NameService/string'
  private static readonly CLUSTER_NS_LOOKUP_PREFIX: string = `${CoherenceResolver.NAME_SERVICE}/Cluster/foreign/`
  private static readonly CLUSTER_NS_LOOKUP_SUFFIX: string = '/NameService/localPort'
  private static readonly GRPC_PROXY_LOOKUP: string = `${CoherenceResolver.NAME_SERVICE}/$GRPC:GrpcProxy`

  private readonly target: experimental.GrpcUri
  private readonly listener: experimental.ResolverListener
  private readonly backoff: experimental.BackoffTimeout
  private readonly sockets = new Set<net.Socket>()
  private generation = 0
  private resolving = false

  constructor (
      target: experimental.GrpcUri,
      listener: experimental.ResolverListener,
      channelOptions: ChannelOptions
  ) {
    this.target = target
    this.listener = listener
    this.backoff = new experimental.BackoffTimeout(() => this.updateResolution(), {
      initialDelay: channelOptions?.['grpc.initial_reconnect_backoff_ms'],
      maxDelay: channelOptions?.['grpc.max_reconnect_backoff_ms'],
    })
    this.backoff.unref()
  }

  // ----- experimental.Resolver interface ----------------------------------

  destroy(): void {
    ++this.generation
    this.resolving = false
    this.backoff.stop()
    this.backoff.reset()
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()
  }

  updateResolution(): void {
    if (this.resolving || this.backoff.isRunning()) {
      return
    }
    this.resolving = true
    const generation = ++this.generation
    // Resolver callbacks must be asynchronous, including target validation errors.
    Promise.resolve().then(() => this.resolveEndpoints(generation)).then(
      endpoints => this.reportResult(generation, experimental.statusOrFromValue(endpoints)),
      reason => this.reportResult(generation, experimental.statusOrFromError({
        code: status.UNAVAILABLE,
        details: `Unable to resolve an address from ${JSON.stringify(this.target)}: ${reason instanceof Error ? reason.message : String(reason)}`,
      }))
    )
  }

  static getDefaultAuthority(target: experimental.GrpcUri): string {
    let [host] = this.parseConn(target.path)
    return host
  }

  // ----- internal ---------------------------------------------------------

  createForeignLookupState(clusterName: string): LookupState {
    return new LookupState(`${CoherenceResolver.CLUSTER_NS_LOOKUP_PREFIX}${clusterName}${CoherenceResolver.CLUSTER_NS_LOOKUP_SUFFIX}`)
  }

  createGrpcLookupState(): LookupState {
    return new LookupState(CoherenceResolver.GRPC_PROXY_LOOKUP)
  }

  static parseConn(path: string): [string, string, string] {
    let parts: string[] = path.split(/[/:]/)
    const host = parts[0]
    let port = '7574'
    let clusterName = ''
    if (parts.length === 2) {
      let p = parseInt(parts[1])
      if (isNaN(p)) {
        // this is a cluster reference using the default port
        clusterName = parts[1]
      } else {
        port = parts[1]
      }
    } else if (parts.length === 3) {
      port = parts[1]
      clusterName = parts[2]
    }
    return [host, port, clusterName]
  }

  private reportResult(generation: number, result: experimental.StatusOr<experimental.Endpoint[]>): void {
    if (generation !== this.generation) {
      return
    }
    this.resolving = false
    const accepted = this.listener(result, {}, null, '')
    // A rejected result requires a fresh lookup. Do not restart after a listener
    // synchronously destroys the resolver or starts another resolution.
    if (generation === this.generation) {
      if (accepted) {
        this.backoff.reset()
      } else {
        this.backoff.runOnce()
      }
    }
  }

  private async resolveEndpoints(generation: number): Promise<experimental.Endpoint[]> {
    let [host, port, clusterName] = CoherenceResolver.parseConn(this.target.path)
    if (clusterName.length > 0) {
      const foreign = this.createForeignLookupState(clusterName)
      await this.runLookup(foreign, host, port, generation)
      port = foreign.result!
    }
    const state = this.createGrpcLookupState()
    await this.runLookup(state, host, port, generation)
    return this.parseLookupResult(state)
  }

  private async runLookup(state: LookupState, host: string, port: string, generation: number): Promise<void> {
    if (generation !== this.generation) {
      throw new Error('Resolution cancelled')
    }
    const portNumber = CoherenceResolver.parsePort(port)
    const socket = this.createSocket(state)
    try {
      socket.connect(portNumber, host)
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)))
    }
    await state.waitResolve
  }

  private static parsePort(port: string): number {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error(`Invalid NameService port: ${port}`)
    }
    return Number(port)
  }

  private parseLookupResult(state: LookupState): experimental.Endpoint[] {
    const result = state.result || ''
    if (!result.startsWith('[') || !result.endsWith(']')) {
      throw new Error('Malformed gRPC proxy lookup response')
    }
    const parts = result.substring(1, result.length - 1).split(',').map(part => part.trim())
    if (parts.length < 2 || parts.length % 2 !== 0) {
      throw new Error('No gRPC proxy endpoints in lookup response')
    }
    return Array.from({length: parts.length / 2}, (_, i) => {
      const host = parts[i * 2]
      if (!host || /[\s\[\]]/.test(host)) {
        throw new Error('Invalid gRPC proxy host in lookup response')
      }
      return {addresses: [{host, port: CoherenceResolver.parsePort(parts[i * 2 + 1])}]}
    })
  }

  private static writePackedInt(n: number): Buffer {
    let result: Buffer = Buffer.alloc(0)
    let b = 0

    if (n < 0) {
      b = 0x40
      n = ~n // bitwise negation
    }

    b |= n & 0x3F
    n >>= 6

    while (n !== 0) {
      result = Buffer.concat([result, Buffer.from([b | 0x80])])
      b = n & 0x7F
      n >>= 7
    }

    return Buffer.concat([result, Buffer.from([b])])
  }

  private static readPackedIntFromBuffer(bytes: Buffer, offset = 0): [number, number] | null {
    if (offset >= bytes.length) {
      return null
    }
    const negative = (bytes[offset] & 0x40) !== 0
    let value = bytes[offset] & 0x3F
    let bits = 6
    for (let i = offset; i < bytes.length; i++) {
      if (i > offset) {
        value += (bytes[i] & 0x7F) * Math.pow(2, bits)
        bits += 7
      }
      if (value > 0x7FFFFFFF || i - offset >= 5) {
        throw new Error('Invalid packed integer in NameService response')
      }
      if ((bytes[i] & 0x80) === 0) {
        return [negative ? -value - 1 : value, i - offset + 1]
      }
    }
    return null
  }

  private static sendConnectionOpen(socket: net.Socket) {
    socket.write(CoherenceResolver.MULTIPLEXED_SOCKET)
    socket.write(CoherenceResolver.NAME_SERVICE_SUB_PORT)
    socket.write(CoherenceResolver.writePackedInt(CoherenceResolver.CONNECTION_OPEN.length))
    socket.write(CoherenceResolver.CONNECTION_OPEN)
  }

  private static sendChannelOpen(socket: net.Socket) {
    socket.write(CoherenceResolver.writePackedInt(CoherenceResolver.CHANNEL_OPEN.length))
    socket.write(CoherenceResolver.CHANNEL_OPEN)
  }

  private static sendLookup(socket: net.Socket, channel: Buffer, query: string) {
      const request = Buffer.concat([
        channel,
        CoherenceResolver.NS_LOOKUP_REQ_ID,
        CoherenceResolver.writePackedInt(Buffer.byteLength(query)),
        Buffer.from(query),
        CoherenceResolver.REQ_END_MARKER,
      ])

      socket.write(CoherenceResolver.writePackedInt(request.length))
      socket.write(request)
  }

  // Read a string from the response
  private static readString(data: Buffer): string {
    const packed = CoherenceResolver.readPackedIntFromBuffer(data, 6)
    if (!packed || packed[0] <= 0 || 6 + packed[1] + packed[0] > data.length) {
      throw new Error('Failure to parse lookup response')
    }
    return data.subarray(6 + packed[1], 6 + packed[1] + packed[0]).toString()
  }

  private createSocket(state: LookupState): net.Socket {
    const socket = new net.Socket()
    this.sockets.add(socket)
    let buffered: Buffer = Buffer.alloc(0)
    const finish = (error?: Error) => {
      if (state.state === ResolveState.DONE) {
        return
      }
      state.state = ResolveState.DONE
      this.sockets.delete(socket)
      socket.destroy()
      if (error) {
        state.reject!(error)
      } else {
        state.resolve!()
      }
    }

    socket.setNoDelay(true)
    socket.setTimeout(10 * 1000) // Set timeout

    socket.on("connect", () => {
          CoherenceResolver.sendConnectionOpen(socket)
          state.state = ResolveState.CONNECTION
        }
    )

    socket.on('error', finish)
    socket.on('timeout', () => finish(new Error('NameService lookup timed out')))
    socket.on('close', () => finish(new Error('NameService connection closed before lookup completed')))

    // TCP may split either a packed length or its payload across data events.
    socket.on('data', data => {
      buffered = Buffer.concat([buffered, data])
      try {
        while (state.state !== ResolveState.DONE) {
          const packed = CoherenceResolver.readPackedIntFromBuffer(buffered)
          if (!packed) {
            return
          }
          const [length, headerLength] = packed
          if (length <= 0) {
            throw new Error('Invalid NameService response length')
          }
          if (buffered.length < headerLength + length) {
            return
          }
          const msg = buffered.subarray(headerLength, headerLength + length)
          buffered = buffered.subarray(headerLength + length)
          switch (state.state) {
            case ResolveState.CONNECTION:
              CoherenceResolver.sendChannelOpen(socket)
              state.state = ResolveState.CHANNEL
              break
            case ResolveState.CHANNEL:
              if (msg.length <= 9) {
                throw new Error('Unable to parse channel from response')
              }
              state.channel = msg.subarray(8, msg.length - 1)
              CoherenceResolver.sendLookup(socket, state.channel, state.query)
              state.state = ResolveState.LOOKUP
              break
            case ResolveState.LOOKUP:
              state.result = CoherenceResolver.readString(msg.subarray(state.channel!.length + 1))
              finish()
              break
            default:
              throw new Error('Unexpected NameService response')
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })

    return socket
  }
}

