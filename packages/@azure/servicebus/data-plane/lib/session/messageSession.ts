// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
  translate,
  Constants,
  ErrorNameConditionMapper,
  MessagingError,
  Func
} from "@azure/amqp-common";
import { Receiver, OnAmqpEvent, EventContext, ReceiverOptions, ReceiverEvents } from "rhea-promise";
import * as log from "../log";
import {
  OnError,
  OnAmqpEventAsPromise,
  PromiseLike,
  DispositionOptions,
  OnMessage
} from "../core/messageReceiver";
import { LinkEntity } from "../core/linkEntity";
import { ClientEntityContext } from "../clientEntityContext";
import { convertTicksToDate, calculateRenewAfterDuration } from "../util/utils";
import {
  ServiceBusMessage,
  DispositionType,
  ReceiveMode,
  ReceivedMessageInfo
} from "../serviceBusMessage";
import { messageDispositionTimeout } from "../util/constants";

export enum Callee {
  standalone = "standalone",
  sessionManager = "sessionManager"
}

/**
 * Describes the options that need to be provided while creating a message session receiver link.
 * @ignore
 */
export interface CreateMessageSessionReceiverLinkOptions {
  onClose: OnAmqpEventAsPromise;
  onSessionClose: OnAmqpEventAsPromise;
  onError: OnAmqpEvent;
  onSessionError: OnAmqpEvent;
  onSettled: OnAmqpEvent;
  sessionId?: string;
}

/**
 * Describes the options for creating a SessionReceiver.
 */
export interface SessionReceiverOptions {
  /**
   * @property {string} [sessionId] The sessionId for the message session.
   */
  sessionId?: string;
  /**
   * @property {number} [receiveMode] The mode in which messages should be received.
   * Possible values are `ReceiveMode.peekLock` (default) and `ReceiveMode.receiveAndDelete`
   */
  receiveMode?: ReceiveMode;
  /**
   * @property {number} [maxSessionAutoRenewLockDurationInSeconds] The maximum duration in seconds
   * until which, the lock on the session will be renewed automatically.
   * - **Default**: `300` seconds (5 minutes).
   * - **To disable autolock renewal**, set `maxSessionAutoRenewLockDurationInSeconds` to `0`.
   */
  maxSessionAutoRenewLockDurationInSeconds?: number;
}

/**
 * Describes the options to control receiving of messages in streaming mode.
 */
export interface SessionMessageHandlerOptions {
  /**
   * @property {boolean} [autoComplete] Indicates whether the message (if not settled by the user)
   * should be automatically completed after the user provided onMessage handler has been executed.
   * Completing a message, removes it from the Queue/Subscription.
   * - **Default**: `true`.
   */
  autoComplete?: boolean;
  /**
   * @property {number} [newMessageWaitTimeoutInSeconds] The maximum amount of time the receiver
   * will wait to receive a new message. If no new message is received in this time, then the
   * receiver will be closed.
   *
   * Caution: When setting this value, take into account the time taken to process messages. Once
   * the receiver is closed, operations like complete()/abandon()/defer()/deadletter() cannot be
   * invoked on messages.
   *
   * If this option is not provided, then receiver link will stay open until manually closed.
   */
  newMessageWaitTimeoutInSeconds?: number;
}
/**
 * Describes the options for creating a Session Manager.
 */
export interface SessionManagerOptions extends SessionMessageHandlerOptions {
  /**
   * @property {number} [maxConcurrentSessions] The maximum number of sessions that the user wants to
   * handle concurrently.
   * - **Default**: `2000`.
   */
  maxConcurrentSessions?: number;
}

/**
 * Describes all the options that can be set while instantiating a MessageSession object.
 */
export type MessageSessionOptions = SessionManagerOptions &
  SessionReceiverOptions & {
    callee?: Callee;
  };

/**
 * Describes the receiver for a Message Session.
 */
export class SessionReceiver extends LinkEntity {
  /**
   * @property {Date} [sessionLockedUntilUtc] Provides the duration until which the session is locked.
   */
  sessionLockedUntilUtc?: Date;
  /**
   * @property {string} [sessionId] The sessionId for the message session.
   */
  sessionId?: string;
  /**
   * @property {number} [maxConcurrentSessions] The maximum number of concurrent sessions that the
   * client should initate.
   * - **Default**: `1`.
   */
  maxConcurrentSessions?: number;
  /**
   * @property {number} [maxConcurrentCallsPerSession] The maximum number of messages that should be
   * processed concurrently in a session while in peek lock mode. Once this limit has been reached,
   * more messages will not be received until messages currently being processed have been settled.
   * - **Default**: `1` (message in a session at a time).
   */
  maxConcurrentCallsPerSession?: number;
  /**
   * @property {number} [receiveMode] The mode in which messages should be received.
   * Default: ReceiveMode.peekLock
   */
  receiveMode: ReceiveMode;
  /**
   * @property {boolean} autoComplete Indicates whether `Message.complete()` should be called
   * automatically after the message processing is complete while receiving messages with handlers
   * or while messages are received using receiveBatch(). Default: false.
   */
  autoComplete: boolean;
  /**
   * @property {number} maxAutoRenewDurationInSeconds The maximum duration within which the
   * lock will be renewed automatically. This value should be greater than the longest message
   * lock duration; for example, the `lockDuration` property on the received message.
   *
   * Default: `300` (5 minutes);
   */
  maxAutoRenewDurationInSeconds: number;
  /**
   * @property {number} [newMessageWaitTimeoutInSeconds] The maximum amount of idle time the session
   * reaceiver will wait ater a message has been received. If no messages are received in that
   * time frame then the session will be closed.
   */
  newMessageWaitTimeoutInSeconds?: number;
  /**
   * @property {boolean} autoRenewLock Should lock renewal happen automatically.
   */
  autoRenewLock: boolean;
  /**
   * @property {Callee} callee Describes who instantied the MessageSession. Whether it was called
   * by the SessionManager or it was called standalone.
   * - Default: "standalone"
   */
  callee: Callee;
  /**
   * @property {Receiver} [_receiver] The AMQP receiver link.
   */
  private _receiver?: Receiver;
  /**
   * @property {Map<number, Promise<any>>} _deliveryDispositionMap Maintains a map of deliveries that
   * are being actively disposed. It acts as a store for correlating the responses received for
   * active dispositions.
   */
  private _deliveryDispositionMap: Map<number, PromiseLike> = new Map<number, PromiseLike>();
  /**
   * @property {OnMessage} _onMessage The message handler provided by the user that will
   * be wrapped inside _onAmqpMessage.
   */
  private _onMessage!: OnMessage;
  /**
   * @property {OnError} _onError The error handler provided by the user that will be wrapped
   * inside _onAmqpError.
   */
  private _onError?: OnError;
  /**
   * @property {OnError} _notifyError If the user provided error handler is present then it will
   * notify the user's error handler about the error.
   */
  private _notifyError: OnError;
  /**
   * @property {OnAmqpEventAsPromise} _onAmqpClose The message handler that will be set as the handler on the
   * underlying rhea receiver for the "receiver_close" event.
   */
  private _onAmqpClose: OnAmqpEventAsPromise;
  /**
   * @property {OnAmqpEvent} _onSessionError The message handler that will be set as the handler on
   * the underlying rhea receiver's session for the "session_error" event.
   */
  private _onSessionError: OnAmqpEvent;
  /**
   * @property {OnAmqpEventAsPromise} _onSessionClose The message handler that will be set as the handler on
   * the underlying rhea receiver's session for the "session_close" event.
   */
  private _onSessionClose: OnAmqpEventAsPromise;
  /**
   * @property {OnAmqpEvent} _onAmqpError The message handler that will be set as the handler on the
   * underlying rhea receiver for the "receiver_error" event.
   */
  private _onAmqpError: OnAmqpEvent;
  /**
   * @property {OnAmqpEvent} _onSettled The message handler that will be set as the handler on the
   * underlying rhea receiver for the "settled" event.
   */
  private _onSettled: OnAmqpEvent;
  /**
   * @property {NodeJS.Timer} _sessionLockRenewalTimer The session lock renewal timer that keeps
   * track of when the MessageSession is due for session lock renewal.
   */
  private _sessionLockRenewalTimer?: NodeJS.Timer;
  /**
   * @property {NodeJS.Timer} _newMessageReceivedTimer The new message received timer that keeps
   * track of closing the MessageSession if no message was received in the configured
   * `newMessageWaitTimeoutInSeconds` seconds.
   */
  private _newMessageReceivedTimer?: NodeJS.Timer;

  private _isReceivingMessages: boolean;
  private _totalAutoLockRenewDuration: number;

  constructor(context: ClientEntityContext, options?: MessageSessionOptions) {
    super(context.entityPath, context, {
      address: context.entityPath,
      audience: `${context.namespace.config.endpoint}${context.entityPath}`
    });
    this._context.isSessionEnabled = true;
    this._isReceivingMessages = false;
    if (!options) options = {};
    this.autoComplete = false;
    this.sessionId = options.sessionId;
    this.receiveMode = options.receiveMode || ReceiveMode.peekLock;
    this.callee = options.callee || Callee.standalone;
    this.maxAutoRenewDurationInSeconds =
      options.maxSessionAutoRenewLockDurationInSeconds != undefined
        ? options.maxSessionAutoRenewLockDurationInSeconds
        : 300;
    this._totalAutoLockRenewDuration = Date.now() + this.maxAutoRenewDurationInSeconds * 1000;
    this.autoRenewLock =
      this.maxAutoRenewDurationInSeconds > 0 && this.receiveMode === ReceiveMode.peekLock;

    // setting all the handlers
    this._onSettled = (context: EventContext) => {
      const connectionId = this._context.namespace.connectionId;
      const delivery = context.delivery;
      if (delivery) {
        const id = delivery.id;
        const state = delivery.remote_state;
        const settled = delivery.remote_settled;
        log.receiver(
          "[%s] Delivery with id %d, remote_settled: %s, remote_state: %o has been " + "received.",
          connectionId,
          id,
          settled,
          state && state.error ? state.error : state
        );
        if (settled && this._deliveryDispositionMap.has(id)) {
          const promise = this._deliveryDispositionMap.get(id) as PromiseLike;
          clearTimeout(promise.timer);
          log.receiver(
            "[%s] Found the delivery with id %d in the map and cleared the timer.",
            connectionId,
            id
          );
          const deleteResult = this._deliveryDispositionMap.delete(id);
          log.receiver(
            "[%s] Successfully deleted the delivery with id %d from the map.",
            connectionId,
            id,
            deleteResult
          );
          if (state && state.error && (state.error.condition || state.error.description)) {
            const error = translate(state.error);
            return promise.reject(error);
          }

          return promise.resolve();
        }
      }
    };

    this._notifyError = (error: MessagingError | Error) => {
      if (this._onError) {
        this._onError(error);
        log.error(
          "[%s] Notified the user's error handler about the error received by the " +
            "Receiver '%s'.",
          this._context.namespace.connectionId,
          this.name
        );
      }
    };

    this._onAmqpError = (context: EventContext) => {
      const connectionId = this._context.namespace.connectionId;
      const receiverError = context.receiver && context.receiver.error;
      if (receiverError) {
        const sbError = translate(receiverError);
        log.error(
          "[%s] An error occurred for Receiver '%s': %O.",
          connectionId,
          this.name,
          sbError
        );
        this._notifyError(sbError);
      }
    };

    this._onSessionError = (context: EventContext) => {
      const connectionId = this._context.namespace.connectionId;
      const sessionError = context.session && context.session.error;
      if (sessionError) {
        const sbError = translate(sessionError);
        log.error(
          "[%s] An error occurred on the session for Receiver '%s': %O.",
          connectionId,
          this.name,
          sbError
        );
        this._notifyError(sbError);
      }
    };

    this._onAmqpClose = async (context: EventContext) => {
      const connectionId = this._context.namespace.connectionId;
      const receiverError = context.receiver && context.receiver.error;
      const receiver = this._receiver || context.receiver!;
      if (receiverError) {
        const sbError = translate(receiverError);
        log.error(
          "[%s] 'receiver_close' event occurred for receiver '%s' for sessionId '%s'. " +
            "The associated error is: %O",
          connectionId,
          this.name,
          this.sessionId,
          sbError
        );
        // no need to notify the user's error handler since rhea guarantees that receiver_error
        // will always be emitted before receiver_close.
      }
      if (receiver && !receiver.isItselfClosed()) {
        log.error(
          "[%s] 'receiver_close' event occurred on the receiver '%s' for sessionId '%s' " +
            "and the sdk did not initiate this. Hence, let's gracefully close the receiver.",
          connectionId,
          this.name,
          this.sessionId
        );
        try {
          await this.close();
        } catch (err) {
          log.error(
            "[%s] An error occurred while closing the receiver '%s' for sessionId '%s': %O.",
            connectionId,
            this.name,
            this.sessionId,
            err
          );
        }
      } else {
        log.error(
          "[%s] 'receiver_close' event occurred on the receiver '%s' for sessionId '%s' " +
            "because the sdk initiated it. Hence no need to gracefully close the receiver",
          connectionId,
          this.name,
          this.sessionId
        );
      }
    };

    this._onSessionClose = async (context: EventContext) => {
      const connectionId = this._context.namespace.connectionId;
      const receiver = this._receiver || context.receiver!;
      const sessionError = context.session && context.session.error;
      if (sessionError) {
        const sbError = translate(sessionError);
        log.error(
          "[%s] 'session_close' event occurred for receiver '%s' for sessionId '%s'. " +
            "The associated error is: %O",
          connectionId,
          this.name,
          this.sessionId,
          sbError
        );
        // no need to notify the user's error handler since rhea guarantees that session_error
        // will always be emitted before session_close.
      }

      if (receiver && !receiver.isSessionItselfClosed()) {
        log.error(
          "[%s] 'session_close' event occurred on the receiver '%s' for sessionId '%s' " +
            "and the sdk did not initiate this. Hence, let's gracefully close the receiver.",
          connectionId,
          this.name,
          this.sessionId
        );
        try {
          await this.close();
        } catch (err) {
          log.error(
            "[%s] An error occurred while closing the receiver '%s' for sessionId '%s': %O.",
            connectionId,
            this.name,
            this.sessionId,
            err
          );
        }
      } else {
        log.error(
          "[%s] 'session_close' event occurred on the receiver '%s' for sessionId '%s' " +
            "because the sdk initiated it. Hence no need to gracefully close the receiver",
          connectionId,
          this.name,
          this.sessionId
        );
      }
    };
  }

  /**
   * Closes the underlying AMQP receiver link.
   */
  async close(): Promise<void> {
    try {
      log.messageSession(
        "[%s] Closing the MessageSession '%s' for queue '%s'.",
        this._context.namespace.connectionId,
        this.sessionId,
        this.name
      );

      this._isReceivingMessages = false;
      if (this._newMessageReceivedTimer) clearTimeout(this._newMessageReceivedTimer);
      if (this._sessionLockRenewalTimer) clearTimeout(this._sessionLockRenewalTimer);
      log.messageSession(
        "[%s] Cleared the timers for 'no new message received' task and " +
          "'session lock renewal' task.",
        this._context.namespace.connectionId
      );
      if (this._receiver) {
        const receiverLink = this._receiver;
        this._deleteFromCache();
        await this._closeLink(receiverLink);
      }
    } catch (err) {
      log.error(
        "[%s] An error occurred while closing the message session with id '%s': %O.",
        this._context.namespace.connectionId,
        this.sessionId,
        err
      );
    }
  }

  /**
   * Determines whether the AMQP receiver link is open. If open then returns true else returns false.
   */
  isOpen(): boolean {
    const result: boolean = this._receiver! && this._receiver!.isOpen();
    log.messageSession(
      "[%s] Receiver '%s' for sessionId '%s' is open? -> %s",
      this._context.namespace.connectionId,
      this.name,
      this.sessionId,
      result
    );
    return result;
  }

  /**
   * Registers handlers to deal with the incoming stream of messages over an AMQP receiver link
   * from a Queue/Subscription.
   * To stop receiving messages, call `close()` on the SessionReceiver or set the property
   * `newMessageWaitTimeoutInSeconds` in the options to provide a timeout.
   *
   * @param onMessage - Handler for processing each incoming message.
   * @param onError - Handler for any error that occurs while receiving or processing messages.
   * @param options - Options to control whether messages should be automatically completed. You can
   * also provide a timeout in seconds to denote the amount of time to wait for a new message
   * before closing the receiver.
   *
   * @returns void
   */
  receive(onMessage: OnMessage, onError: OnError, options?: SessionMessageHandlerOptions): void {
    if (this._isReceivingMessages) {
      throw new Error(
        `MessageSession '${this.name}' with sessionId '${this.sessionId}' is ` +
          `already receiving messages.`
      );
    }
    if (typeof onMessage !== "function") {
      throw new Error("'onSessionMessage' is a required parameter and must be of type 'function'.");
    }
    if (typeof onError !== "function") {
      throw new Error("'onError' is a required parameter and must be of type 'function'.");
    }
    if (!options) options = {};
    this._isReceivingMessages = true;
    this.maxConcurrentCallsPerSession = 1;
    this.newMessageWaitTimeoutInSeconds = options.newMessageWaitTimeoutInSeconds;

    // If explicitly set to false then autoComplete is false else true (default).
    this.autoComplete = options.autoComplete === false ? options.autoComplete : true;
    this._onMessage = onMessage;
    this._onError = onError;
    const connectionId = this._context.namespace.connectionId;

    /**
     * Resets the timer when a new message is received for Session Manager.
     * It will close the receiver gracefully, if no
     * messages were received for the configured newMessageWaitTimeoutInSeconds
     * @ignore
     */
    const resetTimerOnNewMessageReceived = () => {
      if (this._newMessageReceivedTimer) clearTimeout(this._newMessageReceivedTimer);
      if (this.newMessageWaitTimeoutInSeconds) {
        this._newMessageReceivedTimer = setTimeout(async () => {
          const msg =
            `MessageSession '${this.sessionId}' with name '${this.name}' did not receive ` +
            `any messages in the last ${
              this.newMessageWaitTimeoutInSeconds
            } seconds. Hence closing it.`;
          log.error("[%s] %s", this._context.namespace.connectionId, msg);

          if (this.callee === Callee.sessionManager) {
            // The session manager will not forward this error to user.
            // Instead, this is taken as a indicator to create a new session client for the next session.
            const error = translate({
              condition: "com.microsoft:message-wait-timeout",
              description: msg
            });
            this._notifyError(translate(error));
          }
          await this.close();
        }, this.newMessageWaitTimeoutInSeconds * 1000);
      }
    };

    if (this._receiver && this._receiver.isOpen()) {
      const onSessionMessage = async (context: EventContext) => {
        resetTimerOnNewMessageReceived();
        const bMessage: ServiceBusMessage = new ServiceBusMessage(
          this._context,
          context.message!,
          context.delivery!
        );
        try {
          await this._onMessage(bMessage);
        } catch (err) {
          const error = translate(err);
          // Nothing much to do if user's message handler throws. Let us try abandoning the message.
          if (
            this.receiveMode === ReceiveMode.peekLock &&
            this.isOpen() // only try to abandon the messages if the connection is still open
          ) {
            try {
              log.error(
                "[%s] Abandoning the message with id '%s' on the receiver '%s' since " +
                  "an error occured: %O.",
                connectionId,
                bMessage.messageId,
                this.name,
                error
              );
              await bMessage.abandon();
            } catch (abandonError) {
              const translatedError = translate(abandonError);
              log.error(
                "[%s] An error occurred while abandoning the message with id '%s' on the " +
                  "receiver '%s': %O.",
                connectionId,
                bMessage.messageId,
                this.name,
                translatedError
              );
              this._notifyError(translatedError);
            }
          }
          return;
        }

        // If we've made it this far, then user's message handler completed fine. Let us try
        // completing the message.
        if (
          this.autoComplete &&
          this.receiveMode === ReceiveMode.peekLock &&
          !bMessage.delivery.remote_settled
        ) {
          try {
            log.messageSession(
              "[%s] Auto completing the message with id '%s' on " + "the receiver '%s'.",
              connectionId,
              bMessage.messageId,
              this.name
            );
            await bMessage.complete();
          } catch (completeError) {
            const translatedError = translate(completeError);
            log.error(
              "[%s] An error occurred while completing the message with id '%s' on the " +
                "receiver '%s': %O.",
              connectionId,
              bMessage.messageId,
              this.name,
              translatedError
            );
            this._notifyError(translatedError);
          }
        }
      };
      // setting the "message" event listener.
      this._receiver.on(ReceiverEvents.message, onSessionMessage);
      // adding credit
      this._receiver!.setCreditWindow(this.maxConcurrentCallsPerSession);
      this._receiver!.addCredit(this.maxConcurrentCallsPerSession);
    } else {
      this._isReceivingMessages = false;
      const msg =
        `MessageSession with sessionId '${this.sessionId}' and name '${this.name}' ` +
        `has either not been created or is not open.`;
      log.error("[%s] %s", this._context.namespace.connectionId, msg);
      this._notifyError(new Error(msg));
    }
  }

  /**
   * Returns a batch of messages based on given count and timeout over an AMQP receiver link
   * from a Queue/Subscription.
   *
   * @param maxMessageCount      The maximum number of messages to receive from Queue/Subscription.
   * @param idleTimeoutInSeconds The maximum wait time in seconds for which the Receiver
   * should wait to receive the first message. If no message is received by this time,
   * the returned promise gets resolved to an empty array.
   * - **Default**: `60` seconds.
   * @returns Promise<ServiceBusMessage[]> A promise that resolves with an array of Message objects.
   */
  async receiveBatch(
    maxMessageCount: number,
    idleTimeoutInSeconds?: number
  ): Promise<ServiceBusMessage[]> {
    if (this._isReceivingMessages) {
      throw new Error(
        `MessageSession '${this.name}' with sessionId '${this.sessionId}' is ` +
          `already receiving messages.`
      );
    }

    if (!maxMessageCount || (maxMessageCount && typeof maxMessageCount !== "number")) {
      throw new Error(
        "'maxMessageCount' is a required parameter of type number with a value " + "greater than 0."
      );
    }

    if (idleTimeoutInSeconds == undefined) {
      idleTimeoutInSeconds = Constants.defaultOperationTimeoutInSeconds;
    }

    const brokeredMessages: ServiceBusMessage[] = [];
    this._isReceivingMessages = true;

    return new Promise<ServiceBusMessage[]>((resolve, reject) => {
      let onReceiveMessage: OnAmqpEventAsPromise;
      let onReceiveDrain: OnAmqpEvent;
      let firstMessageWaitTimer: any;
      let actionAfterWaitTimeout: Func<void, void>;

      const setnewMessageWaitTimeoutInSeconds = (value?: number) => {
        this.newMessageWaitTimeoutInSeconds = value;
      };

      setnewMessageWaitTimeoutInSeconds(1);

      this._onError = (error: MessagingError | Error) => {
        this._isReceivingMessages = false;
        // Resetting the newMessageWaitTimeoutInSeconds to undefined since we are done receiving
        // a batch of messages.
        setnewMessageWaitTimeoutInSeconds();
        if (firstMessageWaitTimer) {
          clearTimeout(firstMessageWaitTimer);
        }
        // Removing listeners, so that the next receiveBatch() call can set them again.
        if (this._receiver) {
          this._receiver.removeListener(ReceiverEvents.message, onReceiveMessage);
          this._receiver.removeListener(ReceiverEvents.receiverDrained, onReceiveDrain);
        }
        reject(error);
      };

      // Final action to be performed after maxMessageCount is reached or the maxWaitTime is over.
      const finalAction = () => {
        if (this._newMessageReceivedTimer) {
          clearTimeout(this._newMessageReceivedTimer);
        }
        if (firstMessageWaitTimer) {
          clearTimeout(firstMessageWaitTimer);
        }

        // Unsetting the newMessageWaitTimeoutInSeconds to undefined since we are done receiving
        // a batch of messages.
        setnewMessageWaitTimeoutInSeconds();

        // Removing listeners, so that the next receiveBatch() call can set them again.
        if (this._receiver) {
          this._receiver.removeListener(ReceiverEvents.message, onReceiveMessage);
        }

        if (this._receiver && this._receiver.credit > 0) {
          log.messageSession(
            "[%s] Receiver '%s': Draining leftover credits(%d).",
            this._context.namespace.connectionId,
            this.name,
            this._receiver.credit
          );

          // Setting drain must be accompanied by a flow call (aliased to addCredit in this case).
          this._receiver.drain = true;
          this._receiver.addCredit(1);
        } else {
          if (this._receiver) {
            this._receiver.removeListener(ReceiverEvents.receiverDrained, onReceiveDrain);
          }

          this._isReceivingMessages = false;
          log.messageSession(
            "[%s] Receiver '%s': Resolving receiveBatch() with %d messages.",
            this._context.namespace.connectionId,
            this.name,
            brokeredMessages.length
          );
          resolve(brokeredMessages);
        }
      };

      /**
       * Resets the timer when a new message is received. If no messages were received for
       * `newMessageWaitTimeoutInSeconds`, the messages received till now are returned. The
       * receiver link stays open for the next receive call, but doesnt receive messages until then
       * @ignore
       */
      const resetTimerOnNewMessageReceived = () => {
        if (this._newMessageReceivedTimer) clearTimeout(this._newMessageReceivedTimer);
        if (this.newMessageWaitTimeoutInSeconds) {
          this._newMessageReceivedTimer = setTimeout(async () => {
            const msg =
              `MessageSession '${this.sessionId}' with name '${this.name}' did not receive ` +
              `any messages in the last ${
                this.newMessageWaitTimeoutInSeconds
              } seconds. Hence closing it.`;
            log.error("[%s] %s", this._context.namespace.connectionId, msg);
            finalAction();
            if (this.callee === Callee.sessionManager) {
              await this.close();
            }
          }, this.newMessageWaitTimeoutInSeconds * 1000);
        }
      };

      // Action to be performed after the max wait time is over.
      actionAfterWaitTimeout = () => {
        log.batching(
          "[%s] Batching Receiver '%s'  max wait time in seconds %d over.",
          this._context.namespace.connectionId,
          this.name,
          idleTimeoutInSeconds
        );
        return finalAction();
      };

      // Action to be performed on the "receiver_drained" event.
      onReceiveDrain = (context: EventContext) => {
        this._receiver!.removeListener(ReceiverEvents.receiverDrained, onReceiveDrain);
        this._receiver!.drain = false;

        this._isReceivingMessages = false;

        log.messageSession(
          "[%s] Receiver '%s' drained. Resolving receiveBatch() with %d messages.",
          this._context.namespace.connectionId,
          this.name,
          brokeredMessages.length
        );

        resolve(brokeredMessages);
      };

      // Action to be performed on the "message" event.
      onReceiveMessage = async (context: EventContext) => {
        if (firstMessageWaitTimer) {
          clearTimeout(firstMessageWaitTimer);
          firstMessageWaitTimer = undefined;
        }
        resetTimerOnNewMessageReceived();
        try {
          const data: ServiceBusMessage = new ServiceBusMessage(
            this._context,
            context.message!,
            context.delivery!
          );
          if (brokeredMessages.length < maxMessageCount) {
            brokeredMessages.push(data);
          }
        } catch (err) {
          // Removing listeners, so that the next receiveBatch() call can set them again.
          if (this._receiver) {
            this._receiver.removeListener(ReceiverEvents.message, onReceiveMessage);
            this._receiver.removeListener(ReceiverEvents.receiverDrained, onReceiveDrain);
          }
          reject(`Error while converting AmqpMessage to ReceivedSBMessage: ${err}`);
        }
        if (brokeredMessages.length === maxMessageCount) {
          finalAction();
        }
      };

      const addCreditAndSetTimer = (reuse?: boolean) => {
        log.batching(
          "[%s] Receiver '%s', adding credit for receiving %d messages.",
          this._context.namespace.connectionId,
          this.name,
          maxMessageCount
        );
        // By adding credit here, we let the service know that at max we can handle `maxMessageCount`
        // number of messages concurrently. We will return the user an array of messages that can
        // be of size upto maxMessageCount. Then the user needs to accordingly dispose
        // (complete,/abandon/defer/deadletter) the messages from the array.
        this._receiver!.addCredit(maxMessageCount);
        let msg: string = "[%s] Setting the wait timer for %d seconds for receiver '%s'.";
        if (reuse) msg += " Receiver link already present, hence reusing it.";
        log.batching(msg, this._context.namespace.connectionId, idleTimeoutInSeconds, this.name);
        firstMessageWaitTimer = setTimeout(
          actionAfterWaitTimeout,
          (idleTimeoutInSeconds as number) * 1000
        );
      };

      if (this.isOpen()) {
        this._receiver!.on(ReceiverEvents.message, onReceiveMessage);
        this._receiver!.on(ReceiverEvents.receiverDrained, onReceiveDrain);
        addCreditAndSetTimer(true);
      } else {
        const msg =
          `MessageSession "${this.name}" with sessionId "${this.sessionId}", ` +
          `is already closed. Hence cannot receive messages in a batch.`;
        log.error("[%s] %s", this._context.namespace.connectionId, msg);
        reject(new Error(msg));
      }
    });
  }

  /**
   * Settles the message with the specified disposition.
   * @param message The ServiceBus Message that needs to be settled.
   * @param operation The disposition type.
   * @param options Optional parameters that can be provided while disposing the message.
   */
  async settleMessage(
    message: ServiceBusMessage,
    operation: DispositionType,
    options?: DispositionOptions
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!options) options = {};
      if (operation.match(/^(complete|abandon|defer|deadletter)$/) == undefined) {
        return reject(new Error(`operation: '${operation}' is not a valid operation.`));
      }
      const delivery = message.delivery;
      const timer = setTimeout(() => {
        this._deliveryDispositionMap.delete(delivery.id);
        log.receiver(
          "[%s] Disposition for delivery id: %d, did not complete in %d milliseconds. " +
            "Hence resolving the promise.",
          this._context.namespace.connectionId,
          delivery.id,
          messageDispositionTimeout
        );
        return resolve();
      }, messageDispositionTimeout);
      this._deliveryDispositionMap.set(delivery.id, {
        resolve: resolve,
        reject: reject,
        timer: timer
      });
      if (operation === DispositionType.complete) {
        delivery.accept();
      } else if (operation === DispositionType.abandon) {
        const params: any = {
          undeliverable_here: false
        };
        if (options.propertiesToModify) params.message_annotations = options.propertiesToModify;
        delivery.modified(params);
      } else if (operation === DispositionType.defer) {
        const params: any = {
          undeliverable_here: true
        };
        if (options.propertiesToModify) params.message_annotations = options.propertiesToModify;
        delivery.modified(params);
      } else if (operation === DispositionType.deadletter) {
        delivery.reject(options.error || {});
      }
    });
  }

  /**
   * Renews the lock for the Session.
   * @returns Promise<Date> New lock token expiry date and time in UTC format.
   */
  async renewLock(): Promise<Date> {
    this.sessionLockedUntilUtc = await this._context.managementClient!.renewSessionLock(
      this.sessionId!
    );
    return this.sessionLockedUntilUtc;
  }

  /**
   * Sets the state of the MessageSession.
   * @param state The state that needs to be set.
   */
  async setState(state: any): Promise<void> {
    return this._context.managementClient!.setSessionState(this.sessionId!, state);
  }

  /**
   * Gets the state of the MessageSession.
   * @returns Promise<any> The state of that session
   */
  async getState(): Promise<any> {
    return this._context.managementClient!.getSessionState(this.sessionId!);
  }

  /**
   * Fetches the next batch of active messages in the current MessageSession. The first call to
   * `peek()` fetches the first active message for this client. Each subsequent call fetches the
   * subsequent message in the entity.
   *
   * Unlike a `received` message, `peeked` message will not have lock token associated with it,
   * and hence it cannot be `Completed/Abandoned/Deferred/Deadlettered/Renewed`. Also, unlike
   * `receive() | receiveBatch()` this method will also fetch `Deferred` messages, but
   * **NOT** `Deadlettered` messages.
   *
   * It is especially important to keep in mind when attempting to recover deferred messages from
   * the queue. A message for which the `expiresAtUtc` instant has passed is no longer eligible for
   * regular retrieval by any other means, even when it's being returned by `peek()`. Returning
   * these messages is deliberate, since `peek()` is a diagnostics tool reflecting the current
   * state of the log.
   *
   * @param messageCount The number of messages to retrieve. Default value `1`.
   * @returns Promise<ReceivedMessageInfo[]>
   */
  async peek(messageCount?: number): Promise<ReceivedMessageInfo[]> {
    return this._context.managementClient!.peekMessagesBySession(this.sessionId!, messageCount);
  }

  /**
   * Peeks the desired number of messages in the MessageSession from the specified sequence number.
   * @param fromSequenceNumber The sequence number from where to read the message.
   * @param messageCount The number of messages to retrieve. Default value `1`.
   * @returns Promise<ReceivedMessageInfo[]>
   */
  async peekBySequenceNumber(
    fromSequenceNumber: Long,
    messageCount?: number
  ): Promise<ReceivedMessageInfo[]> {
    return this._context.managementClient!.peekBySequenceNumber(fromSequenceNumber, {
      sessionId: this.sessionId!,
      messageCount: messageCount
    });
  }

  /**
   * Receives a deferred message identified by the given `sequenceNumber`.
   * @param sequenceNumber The sequence number of the message that will be received.
   * @returns Promise<ServiceBusMessage | undefined>
   * - Returns `Message` identified by sequence number.
   * - Returns `undefined` if no such message is found.
   * - Throws an error if the message has not been deferred.
   */
  async receiveDeferredMessage(sequenceNumber: Long): Promise<ServiceBusMessage | undefined> {
    if (this.receiveMode !== ReceiveMode.peekLock) {
      throw new Error("The operation is only supported in 'PeekLock' receive mode.");
    }
    return this._context.managementClient!.receiveDeferredMessage(
      sequenceNumber,
      this.receiveMode,
      this.sessionId
    );
  }

  /**
   * Receives a list of deferred messages identified by given `sequenceNumbers`.
   * @param sequenceNumbers A list containing the sequence numbers to receive.
   * @returns Promise<ServiceBusMessage[]>
   * - Returns a list of messages identified by the given sequenceNumbers.
   * - Returns an empty list if no messages are found.
   * - Throws an error if the messages have not been deferred.
   */
  async receiveDeferredMessages(sequenceNumbers: Long[]): Promise<ServiceBusMessage[]> {
    if (this.receiveMode !== ReceiveMode.peekLock) {
      throw new Error("The operation is only supported in 'PeekLock' receive mode.");
    }
    return this._context.managementClient!.receiveDeferredMessages(
      sequenceNumbers,
      this.receiveMode,
      this.sessionId
    );
  }

  /**
   * Deletes the MessageSession from the internal cache.
   * @ignore
   */
  private _deleteFromCache(): void {
    this._receiver = undefined;
    delete this._context.messageSessions[this.sessionId!];
    log.error(
      "[%s] Deleted the receiver '%s' with sessionId '%s' from the client cache.",
      this._context.namespace.connectionId,
      this.name,
      this.sessionId
    );
  }

  /**
   * Creates a new AMQP receiver under a new AMQP session.
   * @ignore
   */
  private async _init(): Promise<void> {
    const connectionId = this._context.namespace.connectionId;
    try {
      if (!this.isOpen() && !this.isConnecting) {
        log.error(
          "[%s] The receiver '%s' with address '%s' is not open and is not currently " +
            "establishing itself. Hence let's try to connect.",
          connectionId,
          this.name,
          this.address
        );
        this.isConnecting = true;
        await this._negotiateClaim();

        const options = this._createMessageSessionOptions();

        log.error(
          "[%s] Trying to create receiver '%s' with options %O",
          connectionId,
          this.name,
          options
        );

        this._receiver = await this._context.namespace.connection.createReceiver(options);
        this.isConnecting = false;
        const receivedSessionId =
          this._receiver.source &&
          this._receiver.source.filter &&
          this._receiver.source.filter[Constants.sessionFilterName];
        let errorMessage: string = "";
        // SB allows a sessionId with empty string value :)
        if (receivedSessionId == undefined) {
          errorMessage =
            `Received an incorrect sessionId '${receivedSessionId}' while creating ` +
            `the receiver '${this.name}'.`;
        }
        if (this.sessionId != undefined && receivedSessionId !== this.sessionId) {
          errorMessage =
            `Received sessionId '${receivedSessionId}' does not match the provided ` +
            `sessionId '${this.sessionId}' while creating the receiver '${this.name}'.`;
        }
        if (errorMessage) {
          const error = translate({
            description: errorMessage,
            condition: ErrorNameConditionMapper.SessionCannotBeLockedError
          });
          log.error("[%s] %O", this._context.namespace.connectionId, error);
          throw error;
        }
        if (this.sessionId == undefined) this.sessionId = receivedSessionId;
        this.sessionLockedUntilUtc = convertTicksToDate(
          this._receiver.properties["com.microsoft:locked-until-utc"]
        );
        log.messageSession(
          "[%s] Session with id '%s' is locked until: '%s'.",
          connectionId,
          this.sessionId,
          this.sessionLockedUntilUtc.toISOString()
        );
        log.error(
          "[%s] Receiver '%s' for sessionId '%s' has established itself.",
          connectionId,
          this.name,
          this.sessionId
        );
        log.messageSession(
          "Promise to create the receiver resolved. " + "Created receiver with name: ",
          this.name
        );
        log.messageSession(
          "[%s] Receiver '%s' created with receiver options: %O",
          connectionId,
          this.name,
          options
        );
        if (!this._context.messageSessions[this.sessionId!]) {
          this._context.messageSessions[this.sessionId!] = this;
        }
        this._totalAutoLockRenewDuration = Date.now() + this.maxAutoRenewDurationInSeconds * 1000;
        await this._ensureTokenRenewal();
        await this._ensureSessionLockRenewal();
      } else {
        log.error(
          "[%s] The receiver '%s' for sessionId '%s' is open -> %s and is connecting " +
            "-> %s. Hence not reconnecting.",
          connectionId,
          this.name,
          this.sessionId,
          this.isOpen(),
          this.isConnecting
        );
      }
    } catch (err) {
      this.isConnecting = false;
      err = translate(err);
      log.error(
        "[%s] An error occured while creating the receiver '%s': %O",
        this._context.namespace.connectionId,
        this.name,
        err
      );
      throw err;
    }
  }

  /**
   * Creates the options that need to be specified while creating an AMQP receiver link.
   * @ignore
   */
  private _createMessageSessionOptions(): ReceiverOptions {
    const rcvrOptions: ReceiverOptions = {
      name: this.name,
      autoaccept: false,
      // receiveAndDelete -> first(0), peekLock -> second (1)
      rcv_settle_mode: this.receiveMode === ReceiveMode.receiveAndDelete ? 0 : 1,
      // receiveAndDelete -> settled (1), peekLock -> unsettled (0)
      snd_settle_mode: this.receiveMode === ReceiveMode.receiveAndDelete ? 1 : 0,
      source: {
        address: this.address,
        filter: {}
      },
      credit_window: 0,
      onClose: (context) =>
        this._onAmqpClose(context).catch(() => {
          /* */
        }),
      onSessionClose: (context) =>
        this._onSessionClose(context).catch(() => {
          /* */
        }),
      onError: this._onAmqpError,
      onSessionError: this._onSessionError,
      onSettled: this._onSettled
    };
    (rcvrOptions.source as any).filter[Constants.sessionFilterName] = this.sessionId;
    return rcvrOptions;
  }

  /**
   * Ensures that the session lock is renewed before it expires. The lock will not be renewed for
   * more than the configured totalAutoLockRenewDuration.
   * @ignore
   */
  private _ensureSessionLockRenewal(): void {
    if (this.autoRenewLock && Date.now() < this._totalAutoLockRenewDuration && this.isOpen()) {
      const connectionId = this._context.namespace.connectionId;
      const nextRenewalTimeout = calculateRenewAfterDuration(this.sessionLockedUntilUtc!);
      this._sessionLockRenewalTimer = setTimeout(async () => {
        try {
          log.messageSession(
            "[%s] Attempting to renew the session lock for MessageSession '%s' " +
              "with name '%s'.",
            connectionId,
            this.sessionId,
            this.name
          );
          this.sessionLockedUntilUtc = await this._context.managementClient!.renewSessionLock(
            this.sessionId!,
            {
              delayInSeconds: 0,
              timeoutInSeconds: 10,
              times: 4
            }
          );
          log.receiver(
            "[%s] Successfully renewed the session lock for MessageSession '%s' " +
              "with name '%s'.",
            connectionId,
            this.sessionId,
            this.name
          );
          log.receiver(
            "[%s] Calling _ensureSessionLockRenewal() again for MessageSession '%s'.",
            connectionId,
            this.sessionId
          );
          this._ensureSessionLockRenewal();
        } catch (err) {
          log.error(
            "[%s] An error occurred while renewing the session lock for MessageSession " +
              "'%s' with name '%s': %O",
            this._context.namespace.connectionId,
            this.sessionId,
            this.name,
            err
          );
        }
      }, nextRenewalTimeout);
      log.messageSession(
        "[%s] MessageSession '%s' with name '%s', has next session lock renewal " +
          "in %d seconds @(%s).",
        this._context.namespace.connectionId,
        this.sessionId,
        this.name,
        nextRenewalTimeout / 1000,
        new Date(Date.now() + nextRenewalTimeout).toString()
      );
    }
  }

  /**
   * Creates a new instance of the MessageSession based on the provided parameters.
   * @param context The client entity context
   * @param options Options that can be provided while creating the MessageSession.
   */
  static async create(
    context: ClientEntityContext,
    options?: MessageSessionOptions
  ): Promise<SessionReceiver> {
    const messageSession = new SessionReceiver(context, options);
    await messageSession._init();
    return messageSession;
  }
}
