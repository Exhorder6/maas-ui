import { eventChannel } from "redux-saga";
import {
  all,
  call,
  put,
  take,
  takeEvery,
  takeLatest,
  race,
} from "redux-saga/effects";

import { WebSocketMessageType } from "../../../websocket-client";
import { fileContextStore } from "app/base/file-context";

let loadedEndpoints = [];

// A map of request ids to action creators. This is used to dispatch actions
// when a response is received.
const nextActions = new Map();
export const getNextActions = (id) => nextActions.get(id);
export const setNextActions = (id, actionCreator) =>
  nextActions.set(id, actionCreator);
export const deleteNextActions = (id) => {
  nextActions.delete(id);
};

// A store of websocket requests that need to be called to fetch the next batch
// of data. The map is between request id and redux action object.
const batchRequests = new Map();
export const getBatchRequest = (id) => batchRequests.get(id);
export const setBatchRequest = (id, action) => batchRequests.set(id, action);
export const deleteBatchRequest = (id) => {
  batchRequests.delete(id);
};

// A store of websocket requests that need to store their responses in the file
// context. The map is between request id and redux action object.
const fileContextRequests = new Map();
export const getFileContextRequest = (id) => fileContextRequests.get(id);
export const setFileContextRequest = (id, action) =>
  fileContextRequests.set(id, action);
export const deleteFileContextRequest = (id) => {
  fileContextRequests.delete(id);
};

/**
 * Whether the data is fetching or has been fetched into state.
 *
 * @param endpoint - root redux model and method (e.g. 'users.list')
 * @returns - has data been fetched?
 */
const isLoaded = (endpoint) => {
  return loadedEndpoints.includes(endpoint);
};

/**
 * Mark a model as having been fetched into state.
 *
 * @param endpoint - root redux state model and method (e.g. 'users.list')
 */
const setLoaded = (endpoint) => {
  if (!isLoaded(endpoint)) {
    loadedEndpoints.push(endpoint);
  }
};
/**
 * Reset the list of loaded endpoints.
 *
 */
const resetLoaded = () => {
  loadedEndpoints = [];
};

/**
 * Create a WebSocket connection via the client.
 */
export function createConnection(websocketClient) {
  // As the socket automatically tries to reconnect we don't reject this
  // promise, but rather wait for it to eventually connect.
  return new Promise((resolve, reject) => {
    const readyState = (websocketClient.socket || {}).readyState;
    if (readyState === WebSocket.OPEN) {
      resolve(websocketClient);
      return;
    } else if (
      !websocketClient.socket ||
      [WebSocket.CLOSED, WebSocket.CLOSING].includes(readyState)
    ) {
      try {
        // Check that the csrftoken etc. exist to create the connection. The
        // check is done here because we don't want to reject errors when
        // connecting so that the reconnecting websocket can keep trying.
        websocketClient.buildURL();
      } catch (error) {
        reject(error);
      }
      websocketClient.connect();
    }
    websocketClient.socket.onopen = () => {
      resolve(websocketClient);
    };
  });
}

/**
 * Create a channel to handle WebSocket messages.
 */
export function watchMessages(socketClient) {
  return eventChannel((emit) => {
    socketClient.socket.onmessage = (event) => {
      const response = JSON.parse(event.data);
      emit(response);
    };
    socketClient.socket.onopen = (event) => {
      emit(event);
    };
    socketClient.socket.onerror = (event) => {
      emit(event);
    };
    socketClient.socket.onclose = (event) => {
      emit(event);
    };
    return () => {
      socketClient.socket.close();
    };
  });
}

/**
 * Handle incoming notify messages.
 *
 * Notify messages have an action and a payload:
 * {"type": 2,
 *  "name": "config",
 *  "action": "update",
 *  "data": {"name": "maas_name", "value": "maas-hysteria"}}
 *
 * Although we receive a corresponding response for each websocket requests,
 * the store is only updated once a notify message has been received.
 */
export function* handleNotifyMessage({ action, name, data }) {
  yield put({
    type: `${name}/${action}Notify`,
    payload: data,
  });
}

/**
 * Store batch requests, if this is a batch action.
 *
 * @param {Object} action - A Redux action.
 * @param {Array} requestIDs - A list of ids for the requests associated with
 * this action.
 */
function queueBatch(action, requestIDs) {
  // If the action has a limit then it is a batch request. An action can send
  // multiple requests so each one needs to be mapped to the action.
  if (action?.payload?.params?.limit && action?.meta?.batch) {
    requestIDs.forEach((id) => {
      setBatchRequest(id, action);
    });
  }
}

/**
 * Handle sending the next batch request, if required.
 *
 * @param {Object} response - A websocket response.
 */
export function* handleBatch({ request_id, result }) {
  const batchRequest = yield call(getBatchRequest, request_id);
  if (batchRequest) {
    // This is a batch request so check if we received a full batch, if so
    // then send another request.
    if (batchRequest.payload.params.limit === result.length) {
      // Clean up the previous request.
      deleteBatchRequest(request_id);
      // Set the next batch to start at the last id we received.
      let nextBatch = { ...batchRequest };
      // If the action has a subsequentLimit then we need to raise the limit
      // after the first request.
      if (nextBatch?.meta?.subsequentLimit) {
        // Set the limit to the subsequentLimit value.
        batchRequest.payload.params.limit = nextBatch.meta.subsequentLimit;
        // Remove the subsequentLimit attribute as we've already raised the
        // limit and further actions should remain at this value.
        delete nextBatch.meta.subsequentLimit;
      }
      nextBatch.payload.params.start = result[result.length - 1].id;
      // Send the new request.
      yield put(nextBatch);
    } else {
      yield put({ type: `${batchRequest.type}Complete` });
    }
  }
}

/**
 * Store the actions to dispatch when the response is received.
 *
 * @param {Object} action - A Redux action.
 * @param {Array} requestIDs - A list of ids for the requests associated with
 * this action.
 */
function* storeNextActions(nextActionCreators, requestIDs) {
  if (nextActionCreators) {
    for (let id of requestIDs) {
      yield call(setNextActions, id, nextActionCreators);
    }
  }
}

/**
 * Handle dispatching the next actions, if required.
 *
 * @param {Object} response - A websocket response.
 */
export function* handleNextActions(response) {
  const { request_id, result } = response;
  const actionCreators = yield call(getNextActions, request_id);
  if (actionCreators && actionCreators.length) {
    for (let actionCreator of actionCreators) {
      // Generate the action object using the result from the response.
      const action = yield call(actionCreator, result);
      // Dispatch the action.
      yield put(action);
    }
    // Clean up the stored action creators.
    yield call(deleteNextActions, request_id);
  }
}

/**
 * Store the actions that need to store files in the file context.
 *
 * @param {Object} action - A Redux action.
 * @param {Array} requestIDs - A list of ids for the requests associated with
 * this action.
 */
export function storeFileContextActions(action, requestIDs) {
  if (action?.meta?.useFileContext) {
    requestIDs.forEach((id) => {
      setFileContextRequest(id, action);
    });
  }
}

/**
 * Handle storing a file in the file context store, if required.
 *
 * @param {Object} response - A websocket response.
 */
export function* handleFileContextRequest({ request_id, result }) {
  const fileContextRequest = yield call(getFileContextRequest, request_id);
  if (fileContextRequest) {
    fileContextStore.add(fileContextRequest.meta.fileContextKey, result);
    // Clean up the previous request.
    deleteBatchRequest(request_id);
  }
  return !!fileContextRequest;
}

/**
 * Handle messages received over the WebSocket.
 */
export function* handleMessage(socketChannel, socketClient) {
  while (true) {
    const response = yield take(socketChannel);
    if (response.type === WebSocketMessageType.NOTIFY) {
      yield call(handleNotifyMessage, response);
    } else if (response.type === "error") {
      yield put({
        error: true,
        payload: response.message,
        type: "status/websocketError",
      });
    } else if (response.type === "close") {
      yield put({ type: "status/websocketDisconnected" });
    } else if (response.type === "open") {
      yield put({ type: "status/websocketConnected" });
      resetLoaded();
    } else {
      // This is a response message, fetch the corresponding action for the
      // message that was sent.
      const action = yield call(
        [socketClient, socketClient.getRequest],
        response.request_id
      );
      // Handle file context requests, if required.
      const isFileContextRequest = yield call(
        handleFileContextRequest,
        response
      );
      // Depending on the action the parameters might be contained in the
      // `params` parameter.
      const item = action.payload?.params || action.payload;
      let error;
      let result;
      if (response.error) {
        try {
          error = JSON.parse(response.error);
        } catch {
          // the API doesn't consistently return JSON, so we fallback
          // to directly assign the error.
          //
          // https://bugs.launchpad.net/maas/+bug/1840887
          error = response.error;
        }
      } else {
        if (isFileContextRequest) {
          // If this uses the file context then don't dispatch the response
          // payload.
          result = null;
        } else if (action.meta?.jsonResponse) {
          try {
            result = JSON.parse(response.result);
          } catch {
            error = "Error parsing API response";
          }
        } else {
          result = response.result;
        }
      }
      if (error) {
        yield put({
          meta: { item },
          type: `${action.type}Error`,
          error: true,
          payload: error,
        });
      } else {
        yield put({
          meta: { item },
          type: `${action.type}Success`,
          payload: result,
        });
        // Handle batching, if required.
        yield call(handleBatch, response);
        // Handle dispatching next actions, if required.
        yield call(handleNextActions, response);
      }
    }
  }
}

/**
 * An action containing an RPC method is a websocket request action.
 * @param {Object} action.
 * @returns {Bool} - action is a request action.
 */
const isWebsocketRequestAction = (action) => action.meta && action.meta.method;

/**
 * Build a message for websocket requests.
 * @param {Object} meta - action meta object.
 * @param {Object} params - param object (optional).
 * @returns {Object} message - serialisable websocket message.
 */
const buildMessage = (meta, params) => {
  const message = {
    method: `${meta.model}.${meta.method}`,
    type: WebSocketMessageType.REQUEST,
  };
  if (params) {
    message.params = params;
  }
  return message;
};

/**
 * Send WebSocket messages via the client.
 */
export function* sendMessage(socketClient, action, nextActionCreators) {
  const { meta, payload, type } = action;
  let params = payload ? payload.params : null;
  const { cache, method, model, nocache } = meta;
  const endpoint = `${model}.${method}`;
  // If method is 'list' and data has loaded/is loading, do not fetch again
  // unless this is fetching a new batch, unless 'nocache' is specified
  if (
    cache ||
    (method.endsWith("list") && (!params || !params.start) && !nocache)
  ) {
    if (isLoaded(endpoint)) {
      return;
    }
    setLoaded(endpoint);
  }
  yield put({ meta: { item: params || payload }, type: `${type}Start` });
  let requestIDs = [];
  try {
    if (params && Array.isArray(params)) {
      // We deliberately do not yield in parallel here with 'all'
      // to avoid races for dependant config.
      for (let param of params) {
        let id = yield call(
          [socketClient, socketClient.send],
          action,
          buildMessage(meta, param)
        );
        requestIDs.push(id);
        // Ensure server has synced before sending next message,
        // important for dependant config like commissioning_distro_series
        // and default_min_hwe_kernel.
        // There is an edge case where a different CLI or server event could
        // dispatch a NOTIFY of the same type which is received before our expected NOTIFY,
        // but this _probably_ does not matter in practice.
        yield take(`${type}Notify`);
      }
    } else {
      let id = yield call(
        [socketClient, socketClient.send],
        action,
        buildMessage(meta, params)
      );
      requestIDs.push(id);
    }
    // Store the actions to dispatch when the response is received.
    yield call(storeNextActions, nextActionCreators, requestIDs);
    // Queue batching, if required.
    yield call(queueBatch, action, requestIDs);
    // Store the actions that need to use the file context.
    yield call(storeFileContextActions, action, requestIDs);
  } catch (error) {
    yield put({
      meta: { item: params || payload },
      type: `${type}Error`,
      error: true,
      payload: error,
    });
  }
}

/**
 * Connect to the WebSocket and watch for message.
 * @param {Array} messageHandlers - Sagas that should handle specific messages
 * via the websocket channel.
 */
export function* setupWebSocket(websocketClient, messageHandlers = []) {
  try {
    const socketClient = yield call(createConnection, websocketClient);
    yield put({ type: "status/websocketConnected" });
    // Set up the list of models that have been loaded.
    resetLoaded();
    const socketChannel = yield call(watchMessages, socketClient);
    while (true) {
      let { cancel } = yield race({
        task: all(
          [
            call(handleMessage, socketChannel, socketClient),
            // Using takeEvery() instead of call() here to get around this issue:
            // https://github.com/canonical-web-and-design/maas-ui/issues/172
            takeEvery(
              (action) => isWebsocketRequestAction(action),
              sendMessage,
              socketClient
            ),
          ].concat(
            // Attach the additional actions that should be taken by the
            // websocket channel.
            messageHandlers.map(({ action, method }) =>
              takeEvery(action, method, socketClient, sendMessage)
            )
          )
        ),
        cancel: take("status/websocketDisconnect"),
      });
      if (cancel) {
        socketChannel.close();
        yield put({ type: "status/websocketDisconnected" });
      }
    }
  } catch (error) {
    yield put({
      type: "status/websocketError",
      error: true,
      payload: error.message,
    });
  }
}

/**
 * Set up websocket connections when requested.
 * @param {Array} messageHandlers - Additional sagas to be handled by the
 * websocket channel.
 */
export function* watchWebSockets(websocketClient, messageHandlers) {
  yield takeLatest(
    "status/websocketConnect",
    setupWebSocket,
    websocketClient,
    messageHandlers
  );
}
