import remove from 'lodash/remove';

const PROTOCOL_SCHEMA = 'ww';
const EXPOSED_BRIDGE_NAME = 'mobileBridge';
const STORAGE_KEY = '_storage';
const REGISTRATION_EVENT_NAME = '_register';
const QUEUE_UTILIZATION_TICK_TIME = 1000 / 60;

export const BRIDGE_SEND_EVENT = 'bridgeSend';
export const BRIDGE_REGISTER_EVENT = 'bridgeRegister';

export default class WWBridge {
    /** Send queue successive calls. */
    _sendQueue;

    /** Takes a role of transport to deliver messages through the url changes */
    _iframe;

    /** Nested key's name of object exposed in `window` global object. */
    _exposedBridgeName;

    /** Protocol's schema of signal. */
    _protocolSchema;

    /** Debug mode shows info of bridge calls. */
    _debug;

    /** `true` if bridge registered, otherwise `false`. */
    _isBridgeRegistered;

    /** `true` if bridge registration request sent. */
    _isBridgeRegistrationSent;

    /** Storage keeps information which has been sent by native while registration process. */
    _storage;

    /** Reference to registration handler which will be used for registration process. */
    _registrationHandler;

    constructor({
        debug = false
    } = {}) {
        this._sendQueue = [];
        this._iframe = this._createIframe();
        this._debug = debug;
        this._isBridgeRegistered = false;
        this._isBridgeRegistrationSent = false;
        this._storage = {};
        this._exposeBridge();
        this._registerBridge();
    }

    /**
     * Send event signal to mobile.
     *
     * @param {String} name Event's name.
     * @param {Object} data Data to send.
     */
    send(name, data) {
        this._sendQueue.push({ name, data, id: this._generateId() });
        this._utilizeQueue();
    }

    /**
     * Add event listener.
     *
     * @param {String}   name    Event's name.
     * @param {Function} handler Handler to handle event.
     */
    on(name, handler) {
        if (typeof window !== 'undefined') {
            this._iframe.addEventListener(name, handler);
        }
    }

    /**
     * Remove event listener.
     *
     * @param {String}   name Event's name.
     * @param {Function} handler Handler linked to event.
     */
    remove(name, handler) {
        if (typeof window !== 'undefined') {
            this._iframe.removeEventListener(name, handler);
        }
    }

    /** Send each event signal to native consistently. */
    _utilizeQueue() {
        // Do not utilize if interval is already presented.
        if (this._interval) return;

        // Start interval to utilize `sendQueue`.
        this._interval = setInterval(() => {
            if (this._sendQueue.length === 0) {
                clearInterval(this._interval);
                this._interval = null;
                return;
            }

            // Get next event in send queue.
            let evt;
            if (this._isBridgeRegistered) {
                // Remove event listener and unref registration handler.
                if (this._registerHandler) {
                    this.remove(BRIDGE_SEND_EVENT, this._registerHandler);
                    this._registerHandler = null;
                }
                evt = this._sendQueue.shift();
            } else if (!this._isBridgeRegistrationSent) {
                evt = remove(this._sendQueue, { name: REGISTRATION_EVENT_NAME })[0];
                this._isBridgeRegistrationSent = true;
            }

            if (evt) {
                const { name, data, id } = evt;
                const addr = this._wrapSchema(name, id);

                /* eslint no-console: "off" */
                if (this._debug) console.log(`JS invokes bridge ${addr}`, data);

                // Notify native about event.
                this._iframe.setAttribute('src', addr);
                // Keep event's data to exposed object with `id` as a key.
                this._addData(id, data);
            }
        }, QUEUE_UTILIZATION_TICK_TIME);
    }

    /**
     * Wrap inbound event's data to schema.
     *
     * @param   {String} eventName Event's name.
     * @param   {String} id        Event's id.
     * @returns {String}           Schema based url.
     */
    _wrapSchema(eventName, id) {
        return `${PROTOCOL_SCHEMA}://${eventName}/${id}`;
    }

    /**
     * Create iframe which will be used as transport for data sending between native and js.
     *
     * @returns {IFrameElement} IFrame element.
     */
    _createIframe() {
        let iframe;
        if (typeof window !== 'undefined') {
            iframe = window.document.createElement('iframe');
            iframe.style.display = 'none';
            window.document.body.appendChild(iframe);
        }
        return iframe;
    }

    /**
     * Create custom event.
     *
     * @param   {String}      eventType Type of event.
     * @param   {String}      name      Event's name.
     * @param   {String}      data      JSON string with data.
     * @returns {CustomEvent}           Created custom event.
     */
    _createEvent(eventType, name, data) {
        let evtBody = { detail: { name, data } };
        if (data) {
            try {
                evtBody.detail.data = JSON.parse(data);
            } catch (e) {
                /* eslint no-console: "off" */
                console.error('Can\'t parse json data');
            }
        }
        return new window.CustomEvent(eventType, evtBody);
    }

    /** Expose bridge which makes it available from mobile's native app. */
    _exposeBridge() {
        if (typeof window !== 'undefined') {
            window[EXPOSED_BRIDGE_NAME] = {
                pullOutDataById: (id) => {
                    const data = window[EXPOSED_BRIDGE_NAME][STORAGE_KEY][id];
                    delete window[EXPOSED_BRIDGE_NAME][STORAGE_KEY][id];
                    return data;
                },
                send: (name, data) => {
                    const evt = this._createEvent(BRIDGE_SEND_EVENT, name, data);
                    /* eslint no-console: "off" */
                    if (this._debug) {
                        const { data: evtData } = evt.detail || {};
                        console.log(`Native invokes bridge with event '${name}'`, evtData);
                    }
                    this._iframe.dispatchEvent(evt);
                },
                [STORAGE_KEY]: {}
            };
        }
    }

    /**
     * Write data to bridge's storage.
     *
     * @param {String} id   Event's id.
     * @param {Object} data Data which will be kept as JSON string in storage.
     */
    _addData(id, data) {
        window[EXPOSED_BRIDGE_NAME][STORAGE_KEY][id] = JSON.stringify(data);
    }

    /** Register mobile bridge on native device. */
    _registerBridge() {
        if (typeof window !== 'undefined') {
            this._registerHandler = (evt) => {
                const { detail: { name, data } } = evt;
                if (name === REGISTRATION_EVENT_NAME) {
                    this._isBridgeRegistered = true;
                    this._storage = { ...this._storage, ...(data || {}) };
                    this._iframe.dispatchEvent(this._createEvent(BRIDGE_REGISTER_EVENT, name, JSON.stringify(data)));
                }
            };
            this.on(BRIDGE_SEND_EVENT, this._registerHandler);
            this.send(REGISTRATION_EVENT_NAME);
        }
    }

    /**
     * Generate unique ID.
     *
     * @returns {String} unique ID.
     */
    _generateId() {
        const s4 = () => (Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1));
        return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
    }

    get storage() {
        return this._storage;
    }
}
