"use strict";
/**
 * @fileoverview SessionDescriptionHandler
 */

 /* SessionDescriptionHandler
  * @class PeerConnection helper Class.
  * @param {SIP.Session} session
  * @param {Object} [options]
  */
module.exports = function (SIP) {

// Constructor
var SessionDescriptionHandler = function(logger, observer, options) {
  // TODO: Validate the options
  this.options = options || {};

  this.logger = logger;
  this.observer = observer;
  this.dtmfSender = null;

  this.shouldAcquireMedia = true;

  this.CONTENT_TYPE = 'application/sdp';

  this.C = {};
  this.C.DIRECTION = {
    NULL:     null,
    SENDRECV: "sendrecv",
    SENDONLY: "sendonly",
    RECVONLY: "recvonly",
    INACTIVE: "inactive"
  };

  this.logger.log('SessionDescriptionHandlerOptions: ' + JSON.stringify(this.options));

  this.direction = this.C.DIRECTION.NULL;

  this.modifiers = this.options.modifiers || [];
  if (!Array.isArray(this.modifiers)) {
    this.modifiers = [this.modifiers];
  }

  var environment = global.window || global;
  this.WebRTC = {
    MediaStream           : environment.MediaStream,
    getUserMedia          : environment.navigator.mediaDevices.getUserMedia.bind(environment.navigator.mediaDevices),
    RTCPeerConnection     : environment.RTCPeerConnection
  };

  this.iceGatheringDeferred = null;
  this.iceGatheringTimeout = false;
  this.iceGatheringTimer = null;

  this.initPeerConnection(this.options.peerConnectionOptions);

  this.constraints = this.checkAndDefaultConstraints(this.options.constraints);
};

/**
 * @param {SIP.Session} session
 * @param {Object} [options]
 */

SessionDescriptionHandler.defaultFactory = function defaultFactory (session, options) {
  var logger = session.ua.getLogger('sip.invitecontext.sessionDescriptionHandler', session.id);
  var SessionDescriptionHandlerObserver = require('./SessionDescriptionHandlerObserver');
  var observer = new SessionDescriptionHandlerObserver(session, options);
  return new SessionDescriptionHandler(logger, observer, options);
};

SessionDescriptionHandler.prototype = Object.create(SIP.SessionDescriptionHandler.prototype, {
  // Functions the sesssion can use

  /**
   * Destructor
   */
  close: {writable: true, value: function () {
    this.logger.log('closing PeerConnection');
    // have to check signalingState since this.close() gets called multiple times
    if(this.peerConnection && this.peerConnection.signalingState !== 'closed') {
      if (this.peerConnection.getSenders) {
        this.peerConnection.getSenders().forEach(function(sender) {
          if (sender.track) {
            sender.track.stop();
          }
        });
      } else {
        this.logger.warn('Using getLocalStreams which is deprecated');
        this.peerConnection.getLocalStreams().forEach(function(stream) {
          stream.getTracks().forEach(function(track) {
            track.stop();
          });
        });
      }
      if (this.peerConnection.getReceivers) {
        this.peerConnection.getReceivers().forEach(function(receiver) {
          if (receiver.track) {
            receiver.track.stop();
          }
        });
      } else {
        this.logger.warn('Using getRemoteStreams which is deprecated');
        this.peerConnection.getRemoteStreams().forEach(function(stream) {
          stream.getTracks().forEach(function(track) {
            track.stop();
          });
        });
      }
      this.resetIceGatheringComplete();
      this.peerConnection.close();
    }
  }},

  /**
   * Gets the local description from the underlying media implementation
   * @param {Object} [options] Options object to be used by getDescription
   * @param {MediaStreamConstraints} [options.constraints] MediaStreamConstraints https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamConstraints
   * @param {Object} [options.peerConnectionOptions] If this is set it will recreate the peer connection with the new options
   * @param {Array} [modifiers] Array with one time use description modifiers
   * @returns {Promise} Promise that resolves with the local description to be used for the session
   */
  getDescription: {writable: true, value: function (options, modifiers) {
    options = options || {};
    if (options.peerConnectionOptions) {
      this.initPeerConnection(options.peerConnectionOptions);
    }

    var mediaOptions = options.media || {};

    // Merge passed constraints with saved constraints and save
    var newConstraints = Object.assign({}, this.constraints, options.constraints);
    newConstraints = this.checkAndDefaultConstraints(newConstraints);
    if (JSON.stringify(newConstraints) !== JSON.stringify(this.constraints)) {
        this.constraints = newConstraints;
        this.shouldAcquireMedia = true;
    }

    modifiers = modifiers || [];
    if (!Array.isArray(modifiers)) {
      modifiers = [modifiers];
    }
    modifiers = modifiers.concat(this.modifiers);

    return SIP.Utils.Promise.resolve()
    .then(function() {
      if (this.shouldAcquireMedia) {
        return this.acquire(this.constraints, mediaOptions).then(function() {
          this.shouldAcquireMedia = false;
        }.bind(this));
      }
    }.bind(this))
    .then(function() {
      return this.createOfferOrAnswer(options.RTCOfferOptions, modifiers);
    }.bind(this))
    .then(function(description) {
      this.emit('getDescription', description);
      return {
        body: description.sdp,
        contentType: this.CONTENT_TYPE
      };
    }.bind(this));
  }},

  /**
   * Check if the Session Description Handler can handle the Content-Type described by a SIP Message
   * @param {String} contentType The content type that is in the SIP Message
   * @returns {boolean}
   */
  hasDescription: {writable: true, value: function hasDescription (contentType) {
    return contentType === this.CONTENT_TYPE;
  }},

  /**
   * The modifier that should be used when the session would like to place the call on hold
   * @param {String} [sdp] The description that will be modified
   * @returns {Promise} Promise that resolves with modified SDP
   */
  holdModifier: {writable: true, value: function holdModifier (description) {
    if (!(/a=(sendrecv|sendonly|recvonly|inactive)/).test(description.sdp)) {
      description.sdp = description.sdp.replace(/(m=[^\r]*\r\n)/g, '$1a=sendonly\r\n');
    } else {
      description.sdp = description.sdp.replace(/a=sendrecv\r\n/g, 'a=sendonly\r\n');
      description.sdp = description.sdp.replace(/a=recvonly\r\n/g, 'a=inactive\r\n');
    }
    return SIP.Utils.Promise.resolve(description);
  }},

  /**
   * Set the remote description to the underlying media implementation
   * @param {String} sessionDescription The description provided by a SIP message to be set on the media implementation
   * @param {Object} [options] Options object to be used by getDescription
   * @param {MediaStreamConstraints} [options.constraints] MediaStreamConstraints https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamConstraints
   * @param {Object} [options.peerConnectionOptions] If this is set it will recreate the peer connection with the new options
   * @param {Array} [modifiers] Array with one time use description modifiers
   * @returns {Promise} Promise that resolves once the description is set
   */
  setDescription: {writable:true, value: function setDescription (sessionDescription, options, modifiers) {
    var self = this;

    options = options || {};
    if (options.peerConnectionOptions) {
      this.initPeerConnection(options.peerConnectionOptions);
    }

    var mediaOptions = options.media || {};

    modifiers = modifiers || [];
    if (!Array.isArray(modifiers)) {
      modifiers = [modifiers];
    }
    modifiers = modifiers.concat(this.modifiers);

    var description = {
      type: this.hasOffer('local') ? 'answer' : 'offer',
      sdp: sessionDescription
    };

    return SIP.Utils.Promise.resolve()
    .then(function() {
      // Media should be acquired in getDescription unless we need to do it sooner for some reason (FF61+)
      if (this.shouldAcquireMedia && this.options.alwaysAcquireMediaFirst) {
        return this.acquire(this.constraints, mediaOptions).then(function() {
          this.shouldAcquireMedia = false;
        }.bind(this));
      }
    }.bind(this))
    .then(function() {
      return SIP.Utils.reducePromises(modifiers, description);
    })
    .catch(function modifierError(e) {
      self.logger.error("The modifiers did not resolve successfully");
      self.logger.error(e);
      throw e;
    })
    .then(function(modifiedDescription) {
      self.emit('setDescription', modifiedDescription);
      return self.peerConnection.setRemoteDescription(modifiedDescription);
    })
    .catch(function setRemoteDescriptionError(e) {
      self.logger.error(e);
      self.emit('peerConnection-setRemoteDescriptionFailed', e);
      throw e;
    })
    .then(function setRemoteDescriptionSuccess() {
      if (self.peerConnection.getReceivers) {
        self.emit('setRemoteDescription', self.peerConnection.getReceivers());
      } else {
        self.emit('setRemoteDescription', self.peerConnection.getRemoteStreams());
      }
      self.emit('confirmed', self);
    });
  }},

  /**
   * Send DTMF via RTP (RFC 4733)
   * @param {String} tones A string containing DTMF digits
   * @param {Object} [options] Options object to be used by sendDtmf
   * @returns {boolean} true if DTMF send is successful, false otherwise
   */
  sendDtmf: {writable: true, value: function sendDtmf (tones, options) {
    if (!this.dtmfSender && this.hasBrowserGetSenderSupport()) {
      var senders = this.peerConnection.getSenders();
      if (senders.length > 0) {
        this.dtmfSender = senders[0].dtmf;
      }
    }
    if (!this.dtmfSender && this.hasBrowserTrackSupport()) {
      var streams = this.peerConnection.getLocalStreams();
      if (streams.length > 0) {
        var audioTracks = streams[0].getAudioTracks();
        if (audioTracks.length > 0) {
          this.dtmfSender = this.peerConnection.createDTMFSender(audioTracks[0]);
        }
      }
    }
    if (!this.dtmfSender) {
      return false;
    }
    try {
      this.dtmfSender.insertDTMF(tones, options.duration, options.interToneGap);
    }
    catch (e) {
      if (e.type ===  "InvalidStateError" || e.type ===  "InvalidCharacterError") {
        this.logger.error(e);
        return false;
      } else {
        throw e;
      }
    }
    this.logger.log('DTMF sent via RTP: ' + tones.toString());
    return true;
  }},

  getDirection: {writable: true, value: function getDirection() {
    return this.direction;
  }},

  // Internal functions
  createOfferOrAnswer: {writable: true, value: function createOfferOrAnswer (RTCOfferOptions, modifiers) {
    var self = this;
    var methodName;
    var pc = this.peerConnection;

    RTCOfferOptions = RTCOfferOptions || {};

    methodName = self.hasOffer('remote') ? 'createAnswer' : 'createOffer';

    return pc[methodName](RTCOfferOptions)
      .catch(function methodError(e) {
        self.emit('peerConnection-' + methodName + 'Failed', e);
        throw e;
      })
      .then(function(sdp) {
        return SIP.Utils.reducePromises(modifiers, self.createRTCSessionDescriptionInit(sdp));
      })
      .then(function(sdp) {
        self.resetIceGatheringComplete();
        return pc.setLocalDescription(sdp);
      })
      .catch(function localDescError(e) {
        self.emit('peerConnection-SetLocalDescriptionFailed', e);
        throw e;
      })
      .then(function onSetLocalDescriptionSuccess() {
        return self.waitForIceGatheringComplete();
      })
      .then(function readySuccess() {
        var localDescription = self.createRTCSessionDescriptionInit(self.peerConnection.localDescription);
        return SIP.Utils.reducePromises(modifiers, localDescription);
      })
      .then(function(localDescription) {
        self.setDirection(localDescription.sdp);
        return localDescription;
      })
      .catch(function createOfferOrAnswerError (e) {
        self.logger.error(e);
        // TODO: Not sure if this is correct
        throw new SIP.Exceptions.GetDescriptionError(e);
      });
  }},

  // Creates an RTCSessionDescriptionInit from an RTCSessionDescription
  createRTCSessionDescriptionInit: {writable: true, value: function createRTCSessionDescriptionInit(RTCSessionDescription) {
    return {
      type: RTCSessionDescription.type,
      sdp: RTCSessionDescription.sdp
    };
  }},

  addDefaultIceCheckingTimeout: {writable: true, value: function addDefaultIceCheckingTimeout (peerConnectionOptions) {
    if (peerConnectionOptions.iceCheckingTimeout === undefined) {
      peerConnectionOptions.iceCheckingTimeout = 5000;
    }
    return peerConnectionOptions;
  }},

  addDefaultIceServers: {writable: true, value: function addDefaultIceServers (rtcConfiguration) {
    if (!rtcConfiguration.iceServers) {
      rtcConfiguration.iceServers = [{urls: 'stun:stun.l.google.com:19302'}];
    }
    return rtcConfiguration;
  }},

  checkAndDefaultConstraints: {writable: true, value: function checkAndDefaultConstraints (constraints) {
    var defaultConstraints = {audio: true, video: !this.options.alwaysAcquireMediaFirst};

    constraints = constraints || defaultConstraints;
    // Empty object check
    if (Object.keys(constraints).length === 0 && constraints.constructor === Object) {
      return defaultConstraints;
    }
    return constraints;
  }},

  hasBrowserTrackSupport: {writable: true, value: function hasBrowserTrackSupport () {
    return Boolean(this.peerConnection.addTrack);
  }},

  hasBrowserGetSenderSupport: {writable: true, value: function hasBrowserGetSenderSupport () {
    return Boolean(this.peerConnection.getSenders);
  }},

  initPeerConnection: {writable: true, value: function initPeerConnection(options) {
    var self = this;
    options = options || {};
    options = this.addDefaultIceCheckingTimeout(options);
    options.rtcConfiguration = options.rtcConfiguration || {};
    options.rtcConfiguration = this.addDefaultIceServers(options.rtcConfiguration);

    this.logger.log('initPeerConnection');

    if (this.peerConnection) {
      this.logger.log('Already have a peer connection for this session. Tearing down.');
      this.resetIceGatheringComplete();
      this.peerConnection.close();
    }

    this.peerConnection = new this.WebRTC.RTCPeerConnection(options.rtcConfiguration);

    this.logger.log('New peer connection created');

    if ('ontrack' in this.peerConnection) {
      this.peerConnection.addEventListener('track', function(e) {
        self.logger.log('track added');
        self.observer.trackAdded();
        self.emit('addTrack', e);
      });
    } else {
      this.logger.warn('Using onaddstream which is deprecated');
      this.peerConnection.onaddstream = function(e) {
        self.logger.log('stream added');
        self.emit('addStream', e);
      };
    }

    this.peerConnection.onicecandidate = function(e) {
      self.emit('iceCandidate', e);
      if (e.candidate) {
        self.logger.log('ICE candidate received: '+ (e.candidate.candidate === null ? null : e.candidate.candidate.trim()));
      }
    };

    this.peerConnection.onicegatheringstatechange = function () {
      self.logger.log('RTCIceGatheringState changed: ' + this.iceGatheringState);
      switch (this.iceGatheringState) {
      case 'gathering':
        self.emit('iceGathering', this);
        if (!self.iceGatheringTimer && options.iceCheckingTimeout) {
          self.iceGatheringTimeout = false;
          self.iceGatheringTimer = SIP.Timers.setTimeout(function() {
            self.logger.log('RTCIceChecking Timeout Triggered after ' + options.iceCheckingTimeout + ' milliseconds');
            self.iceGatheringTimeout = true;
            self.triggerIceGatheringComplete();
          }, options.iceCheckingTimeout);
        }
        break;
      case 'complete':
        self.triggerIceGatheringComplete();
        break;
      }
    };

    this.peerConnection.oniceconnectionstatechange = function() {  //need e for commented out case
      var stateEvent;

      switch (this.iceConnectionState) {
      case 'new':
        stateEvent = 'iceConnection';
        break;
      case 'checking':
        stateEvent = 'iceConnectionChecking';
        break;
      case 'connected':
        stateEvent = 'iceConnectionConnected';
        break;
      case 'completed':
        stateEvent = 'iceConnectionCompleted';
        break;
      case 'failed':
        stateEvent = 'iceConnectionFailed';
        break;
      case 'disconnected':
        stateEvent = 'iceConnectionDisconnected';
        break;
      case 'closed':
        stateEvent = 'iceConnectionClosed';
        break;
      default:
        self.logger.warn('Unknown iceConnection state:', this.iceConnectionState);
        return;
      }
      self.emit(stateEvent, this);
    };
  }},

  acquire: {writable: true, value: function acquire (constraints, options) {
    options = options || {};

    // Default audio & video to true
    constraints = this.checkAndDefaultConstraints(constraints);

    return new SIP.Utils.Promise(function(resolve, reject) {
      /**
       * If media streams have been provided in options use them instead of requesting new ones
       */
      if (options.streams) {
        this.logger.log('reusing media stream');
        this.observer.trackAdded();
        resolve(options.streams);
      } else {
        /*
        * Make the call asynchronous, so that ICCs have a chance
        * to define callbacks to `userMediaRequest`
        */
        this.logger.log('acquiring local media');
        this.emit('userMediaRequest', constraints);

        if (constraints.audio || constraints.video) {
          this.WebRTC.getUserMedia(constraints)
          .then(function(streams) {
            this.observer.trackAdded();
            this.emit('userMedia', streams);
            resolve(streams);
          }.bind(this)).catch(function(e) {
            this.emit('userMediaFailed', e);
            reject(e);
          }.bind(this));
        } else {
          // Local streams were explicitly excluded.
          resolve([]);
        }
      }
    }.bind(this))
    .catch(function acquireFailed(err) {
      this.logger.error('unable to acquire streams');
      this.logger.error(err);
      return SIP.Utils.Promise.reject(err);
    }.bind(this))
    .then(function acquireSucceeded(streams) {
      this.logger.log('acquired local media streams');
      try {
        // Remove old tracks
        if (this.peerConnection.removeTrack) {
          this.peerConnection.getSenders().forEach(function (sender) {
            this.peerConnection.removeTrack(sender);
          }, this);
        }
        return streams;
      } catch(e) {
        return SIP.Utils.Promise.reject(e);
      }
    }.bind(this))
    .catch(function removeStreamsFailed(err) {
      this.logger.error('error removing streams');
      this.logger.error(err);
      return SIP.Utils.Promise.reject(err);
    }.bind(this))
    .then(function addStreams(streams) {
      try {
        streams = [].concat(streams);
        streams.forEach(function (stream) {
          if (this.peerConnection.addTrack) {
            stream.getTracks().forEach(function (track) {
              this.peerConnection.addTrack(track, stream);
            }, this);
          } else {
            // Chrome 59 does not support addTrack
            this.peerConnection.addStream(stream);
          }
        }, this);
      } catch(e) {
        return SIP.Utils.Promise.reject(e);
      }
      return SIP.Utils.Promise.resolve();
    }.bind(this))
    .catch(function addStreamsFailed(err) {
      this.logger.error('error adding stream');
      this.logger.error(err);
      return SIP.Utils.Promise.reject(err);
    }.bind(this));
  }},

  hasOffer: {writable: true, value: function hasOffer (where) {
    var offerState = 'have-' + where + '-offer';
    return this.peerConnection.signalingState === offerState;
  }},

  // ICE gathering state handling

  isIceGatheringComplete: {writable: true, value: function isIceGatheringComplete() {
    return this.peerConnection.iceGatheringState === 'complete' || this.iceGatheringTimeout;
  }},

  resetIceGatheringComplete: {writable: true, value: function resetIceGatheringComplete() {
    this.iceGatheringTimeout = false;

    if (this.iceGatheringTimer) {
      SIP.Timers.clearTimeout(this.iceGatheringTimer);
      this.iceGatheringTimer = null;
    }

    if (this.iceGatheringDeferred) {
      this.iceGatheringDeferred.reject();
      this.iceGatheringDeferred = null;
    }
  }},

  setDirection: {writable: true, value: function setDirection(sdp) {
    var match = sdp.match(/a=(sendrecv|sendonly|recvonly|inactive)/);
    if (match === null) {
      this.direction = this.C.DIRECTION.NULL;
      this.observer.directionChanged();
      return;
    }
    var direction = match[1];
    switch (direction) {
      case this.C.DIRECTION.SENDRECV:
      case this.C.DIRECTION.SENDONLY:
      case this.C.DIRECTION.RECVONLY:
      case this.C.DIRECTION.INACTIVE:
        this.direction = direction;
        break;
      default:
        this.direction = this.C.DIRECTION.NULL;
        break;
    }
    this.observer.directionChanged();
  }},

  triggerIceGatheringComplete: {writable: true, value: function triggerIceGatheringComplete() {
    if (this.isIceGatheringComplete()) {
      this.emit('iceGatheringComplete', this);

      if (this.iceGatheringTimer) {
        SIP.Timers.clearTimeout(this.iceGatheringTimer);
        this.iceGatheringTimer = null;
      }

      if (this.iceGatheringDeferred) {
        this.iceGatheringDeferred.resolve();
        this.iceGatheringDeferred = null;
      }
    }
  }},

  waitForIceGatheringComplete: {writable: true, value: function waitForIceGatheringComplete() {
    if (this.isIceGatheringComplete()) {
      return SIP.Utils.Promise.resolve();
    } else if (!this.isIceGatheringDeferred) {
      this.iceGatheringDeferred = SIP.Utils.defer();
    }
    return this.iceGatheringDeferred.promise;
  }}
});

return SessionDescriptionHandler;
};
