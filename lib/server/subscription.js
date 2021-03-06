"use strict";
/**
 * @module opcua.server
 */
require("requirish")._(module);

var Dequeue = require("collections/deque");

var subscription_service = require("lib/services/subscription_service");
var NotificationMessage = subscription_service.NotificationMessage;
var StatusChangeNotification = subscription_service.StatusChangeNotification;

var StatusCodes = require("lib/datamodel/opcua_status_code").StatusCodes;
var Enum = require("lib/misc/enum");
var assert = require("better-assert");
var _ = require("underscore");

var AttributeIds = require("lib/datamodel/attributeIds").AttributeIds;

var SequenceNumberGenerator = require("lib/misc/sequence_number_generator").SequenceNumberGenerator;

var EventEmitter = require("events").EventEmitter;
var util = require("util");

var debugLog = require("lib/misc/utils").make_debugLog(__filename);
var doDebug = false;
/// debugLog = console.log.bind(console);


var SubscriptionState = new Enum([
    "CLOSED",   // The Subscription has not yet been created or has terminated.
    "CREATING", // The Subscription is being created
    "NORMAL",   // The Subscription is cyclically checking for Notifications from its MonitoredItems.
                // The keep-alive counter is not used in this state.
    "LATE",     // The publishing timer has expired and there are Notifications available or a keep-alive Message is
                // ready to be sent, but there are no Publish requests queued. When in this state, the next Publish
                // request is processed when it is received. The keep-alive counter is not used in this state.
    "KEEPALIVE",// The Subscription is cyclically checking for Notification
                // alive counter to count down to 0 from its maximum.
    "TERMINATED"
]);
exports.SubscriptionState = SubscriptionState;


var SubscriptionDiagnostics = require("schemas/39394884f696ff0bf66bacc9a8032cc074e0158e/SubscriptionDiagnostics").SubscriptionDiagnostics;

var minimumPublishingInterval = 100;  // fastest possible
var defaultPublishingInterval = 100;
var maximumPublishingInterval = 1000 * 60 * 60 * 24 * 30; // 1 month

function _adjust_publishing_interval(publishingInterval) {
    publishingInterval = publishingInterval || defaultPublishingInterval;
    publishingInterval = Math.max(publishingInterval, minimumPublishingInterval);
    publishingInterval = Math.min(publishingInterval, maximumPublishingInterval);
    return publishingInterval;
}

var minimumMaxKeepAliveCount = 2;
var maximumMaxKeepAliveCount = 12000;
function _adjust_maxKeepAliveCount(maxKeepAliveCount) {
    maxKeepAliveCount = maxKeepAliveCount || 10;
    maxKeepAliveCount = Math.max(maxKeepAliveCount, minimumMaxKeepAliveCount);
    maxKeepAliveCount = Math.min(maxKeepAliveCount, maximumMaxKeepAliveCount);
    return maxKeepAliveCount;
}
function _adjust_lifeTimeCount(lifeTimeCount, maxKeepAliveCount) {
    lifeTimeCount = lifeTimeCount || 1;

    // let's make sure that lifeTimeCount is at least three time maxKeepAliveCount
    lifeTimeCount = Math.max(lifeTimeCount, maxKeepAliveCount * 3);
    return lifeTimeCount;
}

function _adjust_publishinEnable(publishingEnabled) {
    return (publishingEnabled === null || publishingEnabled === undefined) ? true : !!publishingEnabled;
}

function _adjust_maxNotificationsPerPublish(maxNotificationsPerPublish) {
    return (maxNotificationsPerPublish >= 0) ? maxNotificationsPerPublish : 0;
}
// verify that the injected publishEngine provides the expected services
// regarding the Subscription requirements...
function _assert_valid_publish_engine(publishEngine) {
    assert(_.isObject(publishEngine));
    assert(_.isNumber(publishEngine.pendingPublishRequestCount));
    assert(_.isFunction(publishEngine.send_notification_message));
    assert(_.isFunction(publishEngine.send_keep_alive_response));
}


function installSubscriptionDiagnostics(self) {

    self.subscriptionDiagnostics = new SubscriptionDiagnostics({});

    // "sessionId"
    self.subscriptionDiagnostics.__defineGetter__("sessionId",                  function() { return self.sessionId; });
    self.subscriptionDiagnostics.__defineGetter__("subscriptionId",             function() { return self.id; });
    self.subscriptionDiagnostics.__defineGetter__("priority",                   function() { return self.priority; });
    self.subscriptionDiagnostics.__defineGetter__("publishingInterval",         function() { return self.publishingInterval; });
    self.subscriptionDiagnostics.__defineGetter__("maxLifetimeCount",           function() { return self.lifeTimeCount; });
    self.subscriptionDiagnostics.__defineGetter__("maxKeepAliveCount",          function() { return self.maxKeepAliveCount; });
    self.subscriptionDiagnostics.__defineGetter__("maxNotificationsPerPublish", function() { return self.maxNotificationsPerPublish; });
    self.subscriptionDiagnostics.__defineGetter__("publishingEnabled",          function() { return self.publishingEnabled; });
    self.subscriptionDiagnostics.__defineGetter__("monitoredItemCount",         function() { return self.monitoredItemCount; });
    self.subscriptionDiagnostics.__defineGetter__("nextSequenceNumber",         function() { return self._get_future_sequence_number(); });
    self.subscriptionDiagnostics.__defineGetter__("disabledMonitoredItemCount", function() { return self.disabledMonitoredItemCount; });



    /* those member of self.subscriptionDiagnostics are handled directly

     modifyCount
     enableCount,
     disableCount,
     republishRequestCount,
     notificationsCount,
     publishRequestCount,
     dataChangeNotificationsCount,
     eventNotificationsCount,
    */

    /*

     those members have not be correctly updated yet in the code :

     "republishMessageRequestCount",
     "republishMessageCount",
     "transferRequestCount",
     "transferredToAltClientCount",
     "transferredToSameClientCount",
     "latePublishRequestCount",
     "currentKeepAliveCount",
     "currentLifetimeCount",
     "unacknowledgedMessageCount",
     "discardedMessageCount",
     "monitoringQueueOverflowCount",
     "eventQueueOverFlowCount"
     */

    // add object in Variable SubscriptionDiagnosticArray (i=2290) ( Array of SubscriptionDiagnostics)
    // add properties in Variable to reflect
}
/**
 * The Subscription class used in the OPCUA server side.
 * @class Subscription
 * @param {Object} options
 * @param options.id {Integer} - a unique identifier
 * @param options.publishingInterval {Integer} - [optional](default:1000) the publishing interval.
 * @param options.maxKeepAliveCount  {Integer} - [optional](default:10) the max KeepAlive Count.
 * @param options.lifeTimeCount      {Integer} - [optional](default:10) the max Life Time Count
 * @param options.publishingEnabled  {Boolean} - [optional](default:true)
 * @param options.maxNotificationsPerPublish {Integer} - [optional](default:0)
 * @param options.priority {Byte}
 * @constructor
 */
function Subscription(options) {

    options = options || {};

    EventEmitter.apply(this, arguments);
    var self = this;

    self.publishEngine = options.publishEngine;
    _assert_valid_publish_engine(self.publishEngine);

    self.id = options.id || "<invalid_id>";

    self.priority = options.priority || 0;


    /**
     * the Subscription publishing interval
     * @property  publishingInterval
     * @type {number}
     * @default 1000
     */
    self.publishingInterval = _adjust_publishing_interval(options.publishingInterval);

    /**
     * The keep alive count defines how many times the publish interval need to
     * expires without having notifications available before the server send an
     * empty message.
     * OPCUA Spec says: a value of 0 is invalid.
     * @property  maxKeepAliveCount
     * @type {number}
     * @default 10
     *
     */
    self.maxKeepAliveCount = _adjust_maxKeepAliveCount(options.maxKeepAliveCount);

    self.resetKeepAliveCounter();

    /**
     * The life time count defines how many times the publish interval expires without
     * having a connection to the client to deliver data.
     * If the life time count reaches maxKeepAliveCount, the subscription will
     * automatically terminate.
     * OPCUA Spec: The life-time count shall be a minimum of three times the keep keep-alive count.
     *
     * Note: this has to be interpreted as without having a PublishRequest available
     * @property  lifeTimeCount
     * @type {Number}
     * @default 1
     */
    self.lifeTimeCount = _adjust_lifeTimeCount(options.lifeTimeCount, self.maxKeepAliveCount);


    /**
     * The maximum number of notifications that the Client wishes to receive in a
     * single Publish response. A value of zero indicates that there is no limit.
     * The number of notifications per Publish is the sum of monitoredItems in the
     * DataChangeNotification and events in the EventNotificationList.
     *
     * @property maxNotificationsPerPublish
     * @type {Number}
     * #default 0
     */
    self.maxNotificationsPerPublish = _adjust_maxNotificationsPerPublish(options.maxNotificationsPerPublish);

    self._life_time_counter = 0;
    self.resetLifeTimeCounter();

    // notification message that are ready to be sent to the client
    self._pending_notifications = new Dequeue();

    self._sent_notifications = [];

    self._sequence_number_generator = new SequenceNumberGenerator();

    // initial state of the subscription
    self.state = SubscriptionState.CREATING;

    self.publishIntervalCount = 0;

    self.monitoredItems = {}; // monitored item map

    /**
     *  number of monitored Item
     *  @property monitoredItemIdCounter
     *  @type {Number}
     */
    self.monitoredItemIdCounter = 0;

    self.publishingEnabled = _adjust_publishinEnable(options.publishingEnabled);

    self.timerId = null;
    self._start_timer();

    installSubscriptionDiagnostics(self);
    //xx console.log("wxxxxx ",self.toString());

}

util.inherits(Subscription, EventEmitter);

Subscription.registry = new (require("lib/misc/objectRegistry").ObjectRegistry)();

Subscription.prototype.toString = function () {

    var self = this;
    var str = "";
    str += "  publishingEnabled  " + self.publishingEnabled + "\n";
    str += "  maxKeepAliveCount  " + self.maxKeepAliveCount + "\n";
    str += "  publishingInterval " + self.publishingInterval + "\n";
    str += "  lifeTimeCount      " + self.lifeTimeCount + "\n";
    str += "  maxKeepAliveCount  " + self.maxKeepAliveCount + "\n";
    return str;
};

/**
 * @method modify
 * @param param {Object}
 * @param param.requestedPublishingInterval  {Duration}  requestedPublishingInterval =0 means fastest possible
 * @param param.requestedLifetimeCount       {Counter}   requestedLifetimeCount      ===0 means no change
 * @param param.requestedMaxKeepAliveCount   {Counter}   requestedMaxKeepAliveCount  ===0 means no change
 * @param param.maxNotificationsPerPublish   {Counter}
 * @param param.priority                     {Byte}
 *
 */
Subscription.prototype.modify = function (param) {
    var self = this;

    // update diagnostic counter
    self.subscriptionDiagnostics.modifyCount +=1;

    var publishingInterval_old = self.publishingInterval;

    param.requestedPublishingInterval = param.requestedPublishingInterval || 0;
    param.requestedMaxKeepAliveCount = param.requestedMaxKeepAliveCount || self.maxKeepAliveCount;
    param.requestedLifetimeCount = param.requestedLifetimeCount || self.lifeTimeCount;

    self.publishingInterval = _adjust_publishing_interval(param.requestedPublishingInterval);
    self.maxKeepAliveCount = _adjust_maxKeepAliveCount(param.requestedMaxKeepAliveCount);
    self.lifeTimeCount = _adjust_lifeTimeCount(param.requestedLifetimeCount, self.maxKeepAliveCount);

    self.maxNotificationsPerPublish = param.maxNotificationsPerPublish;
    self.priority = param.priority;

    self.resetLifeTimeAndKeepAliveCounters();

    if (publishingInterval_old !== self.publishingInterval) {
        // todo
    }
    self._stop_timer();
    self._start_timer();

};

Subscription.prototype._stop_timer = function () {
    var self = this;
    if (self.timerId) {
        //xx console.log("xxxx Subscription.prototype._stop_timer".bgWhite.red);
        clearInterval(self.timerId);
        self.timerId = null;
        Subscription.registry.unregister(self);
    }
};


Subscription.prototype._start_timer = function () {

    //xx console.log("xxxx Subscription.prototype._start_timer".bgWhite.blue);
    var self = this;
    assert(self.timerId === null);
    // from the spec:
    // When a Subscription is created, the first Message is sent at the end of the first publishing cycle to
    // inform the Client that the Subscription is operational. A NotificationMessage is sent if there are
    // Notifications ready to be reported. If there are none, a keep-alive Message is sent instead that
    // contains a sequence number of 1, indicating that the first NotificationMessage has not yet been sent.
    // This is the only time a keep-alive Message is sent without waiting for the maximum keep-alive count
    // to be reached, as specified in (f) above.

    // subscription is now in Normal state
    self.state = SubscriptionState.NORMAL;

    // make sure that a keep-alive Message will be send at the end of the first publishing cycle
    // if there are no Notifications ready.
    self._keep_alive_counter = self.maxKeepAliveCount;

    assert(self.publishingInterval > 0);
    self.timerId = setInterval(self._tick.bind(self), self.publishingInterval);
    Subscription.registry.register(self);

};

// counter
Subscription.prototype._get_next_sequence_number = function () {
    return this._sequence_number_generator.next();
};

// counter
Subscription.prototype._get_future_sequence_number = function () {
    return this._sequence_number_generator.future();
};


Subscription.prototype.setPublishingMode = function (publishingEnabled) {

    this.publishingEnabled = !!publishingEnabled;

    // update diagnostics

    if (this.publishingEnabled) {
        this.subscriptionDiagnostics.enableCount += 1;
    } else {
        this.subscriptionDiagnostics.disableCount += 1;
    }

    return StatusCodes.Good;
};


/**
 *  _attempt_to_publish_notification send a "notification" event:
 *
 * @method _attempt_to_publish_notification *
 * @private
 *
 * the event receiver shall implement a method that looks like:
 *
 * @example
 *
 *     subscription.on("notification",function() {
 *         if (can_publish) {
 *             var notification = subscription.popNotificationToSend();
 *             send_notification(notification);
 *         }
 *     });
 *
 */
Subscription.prototype._attempt_to_publish_notification = function () {

    var self = this;
    assert(self.hasPendingNotifications);

    self.emit("notification");

    var publishEngine = self.publishEngine;
    if (publishEngine.pendingPublishRequestCount > 0) {

        var subscriptionId = self.id;

        var notificationMessage = self.popNotificationToSend().notification;


        // update diagnostics
        self.subscriptionDiagnostics.notificationsCount += 1;
        if (notificationMessage instanceof DataChangeNotification) {
            self.subscriptionDiagnostics.dataChangeNotificationsCount += 1;
        }
        if (notificationMessage instanceof EventNotificationList) {
            self.subscriptionDiagnostics.eventNotificationsCount += 1;
        }

        var availableSequenceNumbers = (self.state === SubscriptionState.CLOSED) ? [] : self.getAvailableSequenceNumbers();

        assert(notificationMessage.hasOwnProperty("sequenceNumber"));
        assert(notificationMessage.hasOwnProperty("notificationData"));
        var moreNotifications = self.hasPendingNotifications;

        self.subscriptionDiagnostics.publishRequestCount += 1;

        publishEngine.send_notification_message({
            subscriptionId: subscriptionId,
            sequenceNumber: notificationMessage.sequenceNumber,
            notificationData: notificationMessage.notificationData,
            availableSequenceNumbers: availableSequenceNumbers,
            moreNotifications: moreNotifications
        });

        if (doDebug) {
            debugLog("Subscription sending a notificationMessage ", subscriptionId, notificationMessage.toString());
        }

        if (self.state === SubscriptionState.LATE || self.state === SubscriptionState.KEEPALIVE) {
            self.state = SubscriptionState.NORMAL;
        }

    } else {

        if (self.state === SubscriptionState.CLOSED) {
            debugLog("Subscription has been closed");
            return;
        }
        if (self.state !== SubscriptionState.LATE) {
            debugLog("Subscription is now Late due to a lack of PublishRequest to process");
        }
        // publishEngine has no PublishRequest available to process :

        self.state = SubscriptionState.LATE;
        //xx console.log(" _attempt_to_publish_notification  self.state = SubscriptionState.LATE");
    }


};


Subscription.prototype.process_subscription = function () {

    var self = this;

    // collect notification from monitored items
    self.prepareNotification();

    //xx console.log("xxxxx process_subscription",self.hasPendingNotifications);

    if (self.hasPendingNotifications && self.publishingEnabled) {

        self._attempt_to_publish_notification();

        if (self.state === SubscriptionState.NORMAL && self.hasPendingNotifications > 0) {

            // TO DO : fix me ,
            //xx console.log("xxxxx pendingPublishRequestCount > 0 && normal state => retrigger tick event immediately ");
            setImmediate(self._tick.bind(self));
        }

    } else {

        self.increaseKeepAliveCounter();

        if (self.keepAliveCounterHasExpired) {

            if (self._sendKeepAliveResponse()) {

                self.resetLifeTimeAndKeepAliveCounters();

            } else {
                assert(false, " ?????");
                self.state = SubscriptionState.LATE;
            }
        }
    }

};

/**
 * @method _tick
 * @private
 */
Subscription.prototype._tick = function () {
    var self = this;

    if (self.publishEngine._on_tick) {
        self.publishEngine._on_tick();
    }


    self.publishIntervalCount += 1;
    /**
     * request a notification update from the subscription owner.
     * @event perform_update
     *
     * this event is sent when the subscription requires a data update. it is up to the subscription owner to
     * perform the necessary operations to update the monitored values.
     *
     */
    self.emit("perform_update");

    // collect notification from monitored items
    self.prepareNotification();

    self.increaseLifeTimeCounter();

    self.discardOldSentNotifications();

    if (self.lifeTimeHasExpired) {

        console.log(" Subscription has expired !!!!! => Terminating".red.bold);
        /**
         * notify the subscription owner that the subscription has expired by exceeding its life time.
         * @event expired
         *
         */
        self.emit("expired");

        // kill timer and delete monitored items
        self.terminate();

    } else {
        var publishEngine = self.publishEngine;
        if (publishEngine.pendingPublishRequestCount === 0) {
            //xx console.log("xxxxxxxxxxxxxxxxxxxxx normal tick -> LATE");
            self.state = SubscriptionState.LATE;
            return;
        }
        //xx console.log("xxxxxxxxxxxxxxxxxxxxx normal tick");
        self.process_subscription();
    }
};


/**
 * @method _sendKeepAliveResponse
 * @private
 */
Subscription.prototype._sendKeepAliveResponse = function () {

    var self = this;
    var future_sequence_number = self._get_future_sequence_number();

    if (self.publishEngine.send_keep_alive_response(self.id, future_sequence_number)) {
        /**
         * notify the subscription owner that a keepalive message has to be sent.
         * @event keepalive
         *
         */
        self.emit("keepalive", future_sequence_number);

        return true;
    }
    return false;
};


/**
 * @method resetKeepAliveCounter
 * @private
 * Reset the Lifetime Counter Variable to the value specified for the lifetime of a Subscription in
 * the CreateSubscription Service( 5.13.2).
 */
Subscription.prototype.resetKeepAliveCounter = function () {
    var self = this;
    self._keep_alive_counter = 0;
};

/**
 * @method increaseKeepAliveCounter
 * @private
 */
Subscription.prototype.increaseKeepAliveCounter = function () {
    var self = this;
    self._keep_alive_counter += 1;
};

/**
 * @property keepAliveCounterHasExpired
 * @private
 * @type {Boolean} true if the keep alive counter has reach its limit.
 */
Subscription.prototype.__defineGetter__("keepAliveCounterHasExpired", function () {
    var self = this;
    return self._keep_alive_counter >= self.maxKeepAliveCount;
});


/**
 * Reset the Lifetime Counter Variable to the value specified for the lifetime of a Subscription in
 * the CreateSubscription Service( 5.13.2).
 * @method resetLifeTimeCounter
 * @private
 */
Subscription.prototype.resetLifeTimeCounter = function () {
    var self = this;
    self._life_time_counter = 0;
};
/**
 * @method increaseLifeTimeCounter
 * @private
 */
Subscription.prototype.increaseLifeTimeCounter = function () {
    var self = this;
    self._life_time_counter += 1;
};

/**
 *  True if the subscription life time has expired.
 *
 * @property lifeTimeHasExpired
 * @type {boolean} - true if the subscription life time has expired.
 */
Subscription.prototype.__defineGetter__("lifeTimeHasExpired", function () {
    var self = this;
    assert(self.lifeTimeCount > 0);
    return self._life_time_counter >= self.lifeTimeCount;
});

/**
 * number of milliseconds before this subscription times out (lifeTimeHasExpired === true);
 * @property timeToExpiration
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("timeToExpiration", function () {
    var self = this;
    return (self.lifeTimeCount - self._life_time_counter ) * self.publishingInterval;
});


/**
 *
 *  the server invokes the resetLifeTimeAndKeepAliveCounters method of the subscription
 *  when the server  has send a Publish Response, so that the subscription
 *  can reset its life time counter.
 *
 * @method resetLifeTimeAndKeepAliveCounters
 *
 */
Subscription.prototype.resetLifeTimeAndKeepAliveCounters = function () {
    var self = this;
    self.resetLifeTimeCounter();
    self.resetKeepAliveCounter();
};

/**
 * Terminates the subscription.
 * @method terminate
 *
 * Calling this method will also remove any monitored items.
 *
 */
Subscription.prototype.terminate = function () {
    var self = this;

    if (self.state === SubscriptionState.CLOSED) {
        // todo verify if asserting is required here
        return;
    }
    assert(self.state !== SubscriptionState.CLOSED, "terminate already called ?");

    // stop timer
    //xx console.log("xxxxxxx //xx subscription.terminate();".cyan.bgWhite);
    self._stop_timer();

    debugLog("terminating Subscription  ", self.id, " with ", self.monitoredItemCount, " monitored items");

    // dispose all monitoredItem
    var keys = Object.keys(self.monitoredItems);

    keys.forEach(function (key) {
        var status = self.removeMonitoredItem(key);
        assert(status === StatusCodes.Good);
    });

    assert(self.monitoredItemCount === 0);

    // notify new terminated status
    debugLog("adding StatusChangeNotification notification message for BadTimeout subscription = ", self.id);
    self.addNotificationMessage([new StatusChangeNotification({statusCode: StatusCodes.BadTimeout})]);

    self.state = SubscriptionState.CLOSED;
    /**
     * notify the subscription owner that the subscription has been terminated.
     * @event "terminated"
     */
    self.emit("terminated");
};

function assert_validNotificationData(n) {
    assert(
        n instanceof DataChangeNotification ||
        n instanceof EventNotificationList  ||
        n instanceof StatusChangeNotification
    );
}

/**
 * @method addNotificationMessage
 * @param notificationData {DataChangeNotification|EventNotificationList|StatusChangeNotification}
 */
Subscription.prototype.addNotificationMessage = function (notificationData) {

    assert(_.isArray(notificationData));
    assert(notificationData.length === 1 || notificationData.length === 2); // as per spec part 3.

    //xx console.log("xxxxx addNotificationMessage".yellow,notificationData.toString());
    var self = this;
    assert(_.isObject(notificationData[0]));

    assert_validNotificationData(notificationData[0]);
    if (notificationData.length === 2) {
        assert_validNotificationData(notificationData[1]);
    }

    var notification_message = new NotificationMessage({
        sequenceNumber: self._get_next_sequence_number(),
        publishTime: new Date(),
        notificationData: notificationData
    });

    self._pending_notifications.push({
        notification: notification_message,
        start_tick: self.publishIntervalCount,
        publishTime: new Date(),
        sequenceNumber: notification_message.sequenceNumber
    });

};

Subscription.prototype.getMessageForSequenceNumber = function (sequenceNumber) {

    var self = this;

    function filter_func(e) {
        return e.sequenceNumber === sequenceNumber;
    }

    var notification_message = _.find(self._sent_notifications, filter_func);

    if (!notification_message) {
        return null;
    }
    self.resetLifeTimeAndKeepAliveCounters();
    return notification_message;

};

/**
 * Extract the next Notification that is ready to be sent to the client.
 * @method popNotificationToSend
 * @return {NotificationMessage}  the Notification to send._pending_notifications
 */
Subscription.prototype.popNotificationToSend = function () {
    var self = this;
    assert(self.hasPendingNotifications);
    var notification_message = self._pending_notifications.shift();
    self._sent_notifications.push(notification_message);
    self.resetLifeTimeAndKeepAliveCounters();
    return notification_message;
};

/**
 * returns true if the notification has expired
 * @method notificationHasExpired
 * @param notification
 * @return {boolean}
 */
Subscription.prototype.notificationHasExpired = function (notification) {
    var self = this;
    assert(notification.hasOwnProperty("start_tick"));
    assert(_.isFinite(notification.start_tick + self.maxKeepAliveCount));
    return (notification.start_tick + self.maxKeepAliveCount) < self.publishIntervalCount;
};

var maxNotificationMessagesInQueue = 100;
/**
 * discardOldSentNotification find all sent notification message that have expired keep-alive
 * and destroy them.
 * @method discardOldSentNotifications
 * @private
 *
 * Subscriptions maintain a retransmission queue of sent  NotificationMessages.
 * NotificationMessages are retained in this queue until they are acknowledged or until they have
 * been in the queue for a minimum of one keep-alive interval.
 *
 */
Subscription.prototype.discardOldSentNotifications = function () {

    var self = this;
    // Sessions maintain a retransmission queue of sent NotificationMessages. NotificationMessages
    // are retained in this queue until they are acknowledged. The Session shall maintain a
    // retransmission queue size of at least two times the number of Publish requests per Session the
    // Server supports.  Clients are required to acknowledge NotificationMessages as they are received. In the
    // case of a retransmission queue overflow, the oldest sent NotificationMessage gets deleted. If a
    // Subscription is transferred to another Session, the queued NotificationMessages for this
    // Subscription are moved from the old to the new Session.
    if (maxNotificationMessagesInQueue <= self._sent_notifications) {
        self._sent_notifications(0, self._sent_notifications.length - maxNotificationMessagesInQueue);
    }
    //
    //var arr = _.filter(self._sent_notifications,function(notification){
    //   return self.notificationHasExpired(notification);
    //});
    //var results = arr.map(function(notification){
    //    return self.acknowledgeNotification(notification.sequenceNumber);
    //});
    //xx return results;
};

function getSequenceNumbers(arr) {
    return arr.map(function (e) {
        return e.notification.sequenceNumber;
    });
}
/**
 *  returns in an array the sequence numbers of the notifications that haven't been
 *  acknowledged yet.
 *
 *  @method getAvailableSequenceNumbers
 *  @return {Integer[]}
 *
 */
Subscription.prototype.getAvailableSequenceNumbers = function () {
    var self = this;
    var availableSequenceNumbers = getSequenceNumbers(self._sent_notifications);
    var pendingSequenceNumbers = getSequenceNumbers(self._pending_notifications);
    return [].concat(availableSequenceNumbers, pendingSequenceNumbers);
};

/**
 * @method acknowledgeNotification
 * @param sequenceNumber {Number}
 * @return {StatusCode}
 */
Subscription.prototype.acknowledgeNotification = function (sequenceNumber) {
    var self = this;

    var foundIndex = -1;
    _.find(self._sent_notifications, function (e, index) {
        if (e.sequenceNumber === sequenceNumber) {
            foundIndex = index;
        }
    });
    if (foundIndex === -1) {
        return StatusCodes.BadSequenceNumberUnknown;
    } else {
        self._sent_notifications.splice(foundIndex, 1);
        return StatusCodes.Good;
    }
};


/**
 *
 * @property pendingNotificationsCount  - number of pending notifications
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("pendingNotificationsCount", function () {
    return this._pending_notifications.length;
});

/**
 * return True is there are pending notifications for this subscription. (i.e moreNotifications)
 *
 * @property hasPendingNotifications
 * @type {Boolean}
 */
Subscription.prototype.__defineGetter__("hasPendingNotifications", function () {
    var self = this;
    return self.pendingNotificationsCount > 0;
});

/**
 * number of sent notifications
 * @property sentNotificationsCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("sentNotificationsCount", function () {
    return this._sent_notifications.length;
});

/**
 * number of monitored items.
 * @property monitoredItemCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("monitoredItemCount", function () {
    return Object.keys(this.monitoredItems).length;
});

/**
 * number of disabled monitored items.
 * @property disabledMonitoredItemCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("disabledMonitoredItemCount", function () {

    return  _.reduce(Object.values(this.monitoredItems),function(cumul,monitoredItem) {
        return cumul + ( (monitoredItem.monitoringMode === MonitoringMode.Disabled ) ? 1 : 0 );
    },0);
    
});

/**
 * The number of unacknowledged messages saved in the republish queue.
 * @property unacknowledgedMessageCount
 * @type {Number}
 */
Subscription.prototype.__defineGetter__("unacknowledgedMessageCount", function () {

    return 0;

});



var MonitoredItem = require("lib/server/monitored_item").MonitoredItem;


var MonitoredItemCreateRequest = require("lib/services/subscription_service").MonitoredItemCreateRequest;


/**
 * adjust monitored item sampling interval
 *  - an samplingInterval ===0 means that we use a event-base model ( no sampling)
 *  - otherwise the sampling is adjusted
 *
 * @method adjustSamplingInterval
 * @param samplingInterval
 * @param node
 * @return {number|*}
 * @private
 */
Subscription.prototype.adjustSamplingInterval = function (samplingInterval, node) {

    var self = this;

    if (samplingInterval < 0) {
        // - The value -1 indicates that the default sampling interval defined by the publishing
        //   interval of the Subscription is requested.
        // - Any negative number is interpreted as -1.
        samplingInterval = self.publishingInterval;

    } else if (samplingInterval === 0 ) {

        // OPCUA 1.0.3 Part 4 - 5.12.1.2
        // The value 0 indicates that the Server should use the fastest practical rate.

        // The fastest supported sampling interval may be equal to 0, which indicates
        // that the data item is exception-based rather than being sampled at some period.
        // An exception-based model means that the underlying system does not require sampling and reports data changes.

        var dataValueSamplingInterval = node.readAttribute(AttributeIds.MinimumSamplingInterval);

        // TODO if attributeId === AttributeIds.Value : sampling interval required here
        if (dataValueSamplingInterval.statusCode === StatusCodes.Good) {
            // node provides a Minimum sampling interval ...
            samplingInterval = dataValueSamplingInterval.value.value;
            assert(samplingInterval >=0 && samplingInterval <= MonitoredItem.maximumSamplingInterval);

            // note : at this stage, a samplingInterval===0 means that the data item is really exception-based

        }

    } else if (samplingInterval < MonitoredItem.minimumSamplingInterval) {

        samplingInterval = MonitoredItem.minimumSamplingInterval;

    } else if (samplingInterval > MonitoredItem.maximumSamplingInterval) {

        // If the requested samplingInterval is higher than the
        // maximum sampling interval supported by the Server, the maximum sampling
        // interval is returned.
        samplingInterval = MonitoredItem.maximumSamplingInterval;
    }

    var node_minimumSamplingInterval = (node && node.minimumSamplingInterval) ? node.minimumSamplingInterval : 0;
    samplingInterval = Math.max(samplingInterval, node_minimumSamplingInterval);

    return samplingInterval;
};


var checkSelectClauses = require("lib/tools/tools_event_filter").checkSelectClauses;

function analyseEventFilterResult(node, eventFilter) {
    assert(eventFilter instanceof subscription_service.EventFilter);

    var selectClauseResults = checkSelectClauses(node, eventFilter.selectClauses);

    var whereClauseResult = new subscription_service.ContentFilterResult();

    return new subscription_service.EventFilterResult({
        selectClauseResults: selectClauseResults,
        selectClauseDiagnosticInfos: [],
        whereClauseResult: whereClauseResult
    });
}
function analyseDataChangeFilterResult(node, dataChangeFilter) {
    assert(dataChangeFilter instanceof subscription_service.DataChangeFilter);
    // the opcu specification doesn't provide dataChangeFilterResult
    return null;
}
function analyseAggregateFilterResult(node, aggregateFilter) {
    assert(aggregateFilter instanceof subscription_service.AggregateFilter);
    return new subscription_service.AggregateFilterResult({});
}
function _process_filter(node, filter) {

    if (!filter) {
        return null;
    }

    if (filter instanceof subscription_service.EventFilter) {
        return analyseEventFilterResult(node, filter);
    } else if (filter instanceof subscription_service.DataChangeFilter) {
        return analyseDataChangeFilterResult(node, filter);
    } else if (filter instanceof subscription_service.AggregateFilter) {
        return analyseAggregateFilterResult(node, filter);
    }
    // istanbul ignore next
    assert(false || "");
}

var UAVariable = require("lib/address_space/ua_variable").UAVariable;
var NodeId = require("lib/datamodel/nodeid").NodeId;

function __validateDataChangeFilter(filter,itemToMonitor,node) {

    assert(itemToMonitor.attributeId  === AttributeIds.Value);
    assert(filter instanceof subscription_service.DataChangeFilter);

    if (!(node instanceof UAVariable)) {
        return StatusCodes.BadNodeIdInvalid;
    }

    assert(node instanceof UAVariable);

    // if node is not Numerical=> DataChangeFilter
    assert(node.dataType instanceof NodeId);
    var dataType = node.__address_space.findDataType(node.dataType);

    var dataTypeNumber = node.__address_space.findDataType("Number");
    if (!dataType.isSupertypeOf(dataTypeNumber)) {
        return StatusCodes.BadFilterNotAllowed;
    }


    if (filter.deadbandType === subscription_service.DeadbandType.Percent) {
        if (filter.deadbandValue <= 0 || filter.deadbandValue >= 100) {
            return StatusCodes.BadDeadbandFilterInvalid;
        }
    }
    return StatusCodes.Good;
}
function __validateFilter(filter, itemToMonitor ,node) {

    // handle filter information
    if (filter && filter instanceof subscription_service.EventFilter && itemToMonitor.attributeId !== AttributeIds.EventNotifier) {
        // invalid filter on Event
        return StatusCodes.BadFilterNotAllowed;
    }

    if (filter && filter instanceof subscription_service.DataChangeFilter && itemToMonitor.attributeId !== AttributeIds.Value) {
        // invalid DataChange filter on non Value Attribute
        return StatusCodes.BadFilterNotAllowed;
    }

    if (filter && itemToMonitor.attributeId !== AttributeIds.EventNotifier && itemToMonitor.attributeId !== AttributeIds.Value) {
        return StatusCodes.BadFilterNotAllowed;
    }

    if (filter instanceof subscription_service.DataChangeFilter) {

        return __validateDataChangeFilter(filter,itemToMonitor,node);
    }

    return StatusCodes.Good;
}


var is_valid_dataEncoding = require("lib/misc/data_encoding").is_valid_dataEncoding;

Subscription.prototype.createMonitoredItem = function (addressSpace, timestampsToReturn, monitoredItemCreateRequest) {

    var self = this;
    assert(addressSpace.constructor.name === "AddressSpace");
    assert(monitoredItemCreateRequest instanceof MonitoredItemCreateRequest);


    function handle_error(statusCode) {
        return new subscription_service.MonitoredItemCreateResult({statusCode: statusCode});
    }

    var itemToMonitor = monitoredItemCreateRequest.itemToMonitor;

    var node = addressSpace.findNode(itemToMonitor.nodeId);
    if (!node) {
        return handle_error(StatusCodes.BadNodeIdUnknown);
    }


    if (itemToMonitor.attributeId === AttributeIds.Value && !(node instanceof UAVariable)) {
        // AttributeIds.Value is only valid for monitoring value of UAVariables.
        return handle_error(StatusCodes.BadAttributeIdInvalid);
    }


    if (itemToMonitor.attributeId === AttributeIds.INVALID) {
        return handle_error(StatusCodes.BadAttributeIdInvalid);
    }

    if (!itemToMonitor.indexRange.isValid()) {
        return handle_error(StatusCodes.BadIndexRangeInvalid);
    }

    // check dataEncoding applies only on Values
    if (itemToMonitor.dataEncoding.name && itemToMonitor.attributeId !== AttributeIds.Value) {
        return handle_error(StatusCodes.BadDataEncodingInvalid);
    }

    // check dataEncoding
    if (!is_valid_dataEncoding(itemToMonitor.dataEncoding)) {
        return handle_error(StatusCodes.BadDataEncodingUnsupported);
    }


    // filter
    var requestedParameters = monitoredItemCreateRequest.requestedParameters;
    var filter = requestedParameters.filter;
    var statusCodeFilter = __validateFilter(filter, itemToMonitor , node);
    if (statusCodeFilter !== StatusCodes.Good) {
        return handle_error(statusCodeFilter);
    }
    //xx var monitoringMode      = monitoredItemCreateRequest.monitoringMode; // Disabled, Sampling, Reporting
    //xx var requestedParameters = monitoredItemCreateRequest.requestedParameters;

    var monitoredItemCreateResult = self._createMonitoredItemStep2(timestampsToReturn, monitoredItemCreateRequest, node);

    assert(monitoredItemCreateResult.statusCode === StatusCodes.Good);

    var monitoredItem = self.getMonitoredItem(monitoredItemCreateResult.monitoredItemId);
    assert(monitoredItem);

    // TODO: fix old way to set node. !!!!
    monitoredItem.node = node;

    self.emit("monitoredItem", monitoredItem, itemToMonitor);

    self._createMonitoredItemStep3(monitoredItem,monitoredItemCreateRequest);

    return monitoredItemCreateResult;

};

/**
 *
 * @method _createMonitoredItemStep2
 * @param timestampsToReturn
 * @param {MonitoredItemCreateRequest} monitoredItemCreateRequest - the parameters describing the monitored Item to create
 * @param node {BaseNode}
 * @return {subscription_service.MonitoredItemCreateResult}
 * @private
 */
Subscription.prototype._createMonitoredItemStep2 = function (timestampsToReturn, monitoredItemCreateRequest, node) {

    var self = this;

    // note : most of the parameter inconsistencies shall have been handled by the caller
    // any error here will raise an assert here

    assert(monitoredItemCreateRequest instanceof MonitoredItemCreateRequest);
    var itemToMonitor = monitoredItemCreateRequest.itemToMonitor;

    //xx check if attribute Id invalid (we only support Value or EventNotifier )
    //xx assert(itemToMonitor.attributeId !== AttributeIds.INVALID);

    self.monitoredItemIdCounter += 1;
    var monitoredItemId = self.monitoredItemIdCounter;

    var requestedParameters = monitoredItemCreateRequest.requestedParameters;

    // adjust requestedParameters.samplingInterval
    requestedParameters.samplingInterval = self.adjustSamplingInterval(requestedParameters.samplingInterval, node);

    // reincorporate monitoredItemId and itemToMonitor into the requestedParameters
    requestedParameters.monitoredItemId = monitoredItemId;
    requestedParameters.itemToMonitor = itemToMonitor;


    var monitoredItem = new MonitoredItem(requestedParameters);
    monitoredItem.timestampsToReturn = timestampsToReturn;

    assert(monitoredItem.monitoredItemId === monitoredItemId);
    self.monitoredItems[monitoredItemId] = monitoredItem;

    var filterResult = _process_filter(node, requestedParameters.filter);


    var monitoredItemCreateResult = new subscription_service.MonitoredItemCreateResult({
        statusCode: StatusCodes.Good,
        monitoredItemId: monitoredItemId,
        revisedSamplingInterval: monitoredItem.samplingInterval,
        revisedQueueSize: monitoredItem.queueSize,
        filterResult: filterResult
    });
    return monitoredItemCreateResult;
};

var MonitoringMode = subscription_service.MonitoringMode;

Subscription.prototype._createMonitoredItemStep3 = function (monitoredItem,monitoredItemCreateRequest) {

    assert(monitoredItem.monitoringMode === MonitoringMode.Invalid);
    assert(_.isFunction(monitoredItem.samplingFunc));
    var monitoringMode = monitoredItemCreateRequest.monitoringMode; // Disabled, Sampling, Reporting
    monitoredItem.setMonitoringMode(monitoringMode);

};

/**
 * get a monitoredItem by Id.
 * @method getMonitoredItem
 * @param monitoredItemId  {Number} the id of the monitored item to get.
 * @return {MonitoredItem}
 */
Subscription.prototype.getMonitoredItem = function (monitoredItemId) {
    assert(_.isFinite(monitoredItemId));
    var self = this;
    return self.monitoredItems[monitoredItemId];
};

/**
 * getMonitoredItems is used to get information about monitored items of a subscription.Its intended
 * use is defined in Part 4. This method is the implementation of the Standard OPCUA GetMonitoredItems Method.
 * @method getMonitoredItems
 * @param  result.serverHandles {Int32[]} Array of serverHandles for all MonitoredItems of the subscription identified by subscriptionId.
 *         result.clientHandles {Int32[]} Array of clientHandles for all MonitoredItems of the subscription identified by subscriptionId.
 *         result.statusCode    {StatusCode}
 * from spec:
 * This method can be used to get the  list of monitored items in a subscription if CreateMonitoredItems failed due to
 * a network interruption and the client does not know if the creation succeeded in the server.
 *
 */
Subscription.prototype.getMonitoredItems = function (/*out*/ result) {

    result = result || {};
    var subscription = this;
    result.serverHandles = [];
    result.clientHandles = [];
    result.statusCode = StatusCodes.Good;

    Object.keys(subscription.monitoredItems).forEach(function (monitoredItemId) {

        var monitoredItem = subscription.getMonitoredItem(monitoredItemId);

        result.clientHandles.push(monitoredItem.clientHandle);
        // TODO:  serverHandle is defined anywhere in the OPCUA Specification 1.02
        //        I am not sure what shall be reported for serverHandle...
        //        using monitoredItem.monitoredItemId instead...
        //        May be a clarification in the OPCUA Spec is required.
        result.serverHandles.push(monitoredItemId);

    });
    return result;
};

/**
 * remove a monitored Item from the subscription.
 * @method removeMonitoredItem
 * @param monitoredItemId  {Number} the id of the monitored item to get.
 */
Subscription.prototype.removeMonitoredItem = function (monitoredItemId) {

    debugLog("Removing monitoredIem ", monitoredItemId);

    assert(_.isFinite(monitoredItemId));
    var self = this;
    if (!self.monitoredItems.hasOwnProperty(monitoredItemId)) {
        return StatusCodes.BadMonitoredItemIdInvalid;
    }

    var monitoredItem = self.monitoredItems[monitoredItemId];

    monitoredItem.terminate();

    delete self.monitoredItems[monitoredItemId];

    return StatusCodes.Good;

};

var DataChangeNotification = subscription_service.DataChangeNotification;
var EventNotificationList = subscription_service.EventNotificationList;



// collect DataChangeNotification
Subscription.prototype.collectNotificationData = function () {

    var self = this;
    var all_notifications = new Dequeue();

    // visit all monitored items
    var keys = Object.keys(self.monitoredItems);
    keys.forEach(function (key) {
        var monitoredItem = self.monitoredItems[key];
        var notifications = monitoredItem.extractMonitoredItemNotifications();
        all_notifications = all_notifications.concat(notifications);
    });
    assert(all_notifications instanceof Dequeue);

    /**
     * extract up to maxNotificationsPerPublish notificiation into a Dequeue
     * @param monitoredItems
     * @param maxNotificationsPerPublish
     * @returns {Deque|exports|module.exports}
     */
    function extract_notifications_chunk(monitoredItems, maxNotificationsPerPublish) {
        var n = maxNotificationsPerPublish === 0 ?
            monitoredItems.length :
            Math.min(monitoredItems.length, maxNotificationsPerPublish);

        var chunk_monitoredItems = new Dequeue();
        while (n) {
            chunk_monitoredItems.push(monitoredItems.shift());
            n--;
        }
        return chunk_monitoredItems;
    }

    var notificationsMessage = new Dequeue();

    function filter_instanceof(Class,e) {
        return (e instanceof Class);
    }

    while (all_notifications.length > 0) {

        // split into one or multiple dataChangeNotification with no more than
        //  self.maxNotificationsPerPublish monitoredItems
        var notifications_chunk = extract_notifications_chunk(all_notifications, self.maxNotificationsPerPublish);

        notifications_chunk = notifications_chunk.toArray();

        // separate data for DataChangeNotification (MonitoredItemNotification) from data for EventNotificationList(EventFieldList)
        var dataChangedNotificationData = notifications_chunk.filter(filter_instanceof.bind(null,subscription_service.MonitoredItemNotification));
        var eventNotificationListData = notifications_chunk.filter(filter_instanceof.bind(null,subscription_service.EventFieldList));
        assert(notifications_chunk.length === dataChangedNotificationData.length +  eventNotificationListData.length);



        var notifications = [];


        // add dataChangeNotification
        if (dataChangedNotificationData.length) {
            var dataChangeNotification = new DataChangeNotification({
                monitoredItems: dataChangedNotificationData,
                diagnosticInfos: []
            });
            notifications.push(dataChangeNotification);
        }

        // add dataChangeNotification
        if (eventNotificationListData.length) {
            var eventNotificationList = new EventNotificationList({
                events: eventNotificationListData
            });
            notifications.push(eventNotificationList);
        }

        assert(notifications.length === 1 || notifications.length === 2);
        notificationsMessage.push(notifications);
    }

    assert(notificationsMessage instanceof Dequeue);
    return notificationsMessage;
};

Subscription.prototype.prepareNotification = function () {

    var self = this;

    if (self.publishEngine.pendingPublishRequestCount === 0) {
        return;
    }

    // Only collect data change notification for the time being
    var notificationData = self.collectNotificationData();
    assert(notificationData instanceof Dequeue);
    //xx console.log("xxxxxx prepareNotification dataChangeNotifications.length",dataChangeNotifications.length);
    notificationData.forEach(function (notificationMessage) {
        //xx console.log("xxxxxx before self.addNotificationMessage",dataChangeNotifications.length);
        self.addNotificationMessage(notificationMessage);
    });

};


exports.Subscription = Subscription;
