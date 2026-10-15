if (process.env.TTG_PROJECTION_TRACE === '1'
  && process.env.FUNCTIONS_EMULATOR === 'true'
  && typeof process.env.FUNCTION_TARGET === 'string') {
  const Module = require('node:module');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const invocationContext = new AsyncLocalStorage();
  const originalModuleLoad = Module._load;
  Module._load = function traceFirestoreTriggerLoad(request, parent, isMain) {
    const loaded = originalModuleLoad.call(this, request, parent, isMain);
    if (request !== 'firebase-functions/v2/firestore' || typeof loaded?.onDocumentWritten !== 'function') return loaded;

    const tracedExports = Object.create(loaded);
    tracedExports.onDocumentWritten = (...args) => {
      const handlerIndex = args.findLastIndex(value => typeof value === 'function');
      if (handlerIndex < 0) return loaded.onDocumentWritten(...args);
      const options = args.find(value => value && typeof value.document === 'string') ?? {};
      const originalHandler = args[handlerIndex];
      args[handlerIndex] = async event => {
        const uid = event?.params?.uid;
        const isPrivateLocationEvent = options.document === 'privateLocations/{uid}';
        const sourceLocation = isPrivateLocationEvent ? event?.data?.after?.data?.() : undefined;
        const eventId = typeof event?.id === 'string' ? event.id : undefined;
        const common = {
          triggerDocument: options.document,
          eventId,
          uid: typeof uid === 'string' ? uid : undefined,
          sourceLocationUpdatedAt: safeValue(sourceLocation?.updatedAt),
          sourceUpdateTime: safeValue(isPrivateLocationEvent ? event?.data?.after?.updateTime : undefined),
        };
        return invocationContext.run(common, async () => {
          const startedAt = Date.now();
          trace('trigger-start', common);
          try {
            return await originalHandler(event);
          } finally {
            trace('trigger-end', { ...common, elapsedMs: Date.now() - startedAt });
          }
        });
      };
      return loaded.onDocumentWritten(...args);
    };
    return tracedExports;
  };

  const { Firestore, Transaction } = require(require.resolve('firebase-admin/firestore', {
    paths: [process.env.TTG_FUNCTIONS_ROOT],
  }));
  const transactionTrace = new WeakMap();
  let transactionSequence = 0;
  const safeFields = [
    'gameSessionId', 'sessionSchemaVersion', 'sessionStartedAt', 'status', 'team',
    'updatedAt', 'sourceLocationUpdatedAt', 'safetyStatus', 'expiresAt',
  ];

  function safeValue(value) {
    if (value && typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    return undefined;
  }

  function safeDocumentData(value) {
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    for (const field of safeFields) {
      if (Object.hasOwn(value, field)) result[field] = safeValue(value[field]);
    }
    return result;
  }

  function pathOf(reference) {
    return typeof reference?.path === 'string' ? reference.path : '<query-or-unknown>';
  }

  function trace(event, data = {}) {
    process.stderr.write(`PROJECTION_TRACE ${JSON.stringify({
      pid: process.pid,
      functionTarget: process.env.FUNCTION_TARGET,
      ...invocationContext.getStore(),
      atMs: Date.now(),
      event,
      ...data,
    })}\n`);
  }

  const originalRunTransaction = Firestore.prototype.runTransaction;
  Firestore.prototype.runTransaction = function tracedRunTransaction(updateFunction, options) {
    const traceId = ++transactionSequence;
    let attempts = 0;
    return originalRunTransaction.call(this, async transaction => {
      attempts += 1;
      transactionTrace.set(transaction, { traceId, attempt: attempts, writeCount: 0 });
      trace('transaction-attempt-start', { traceId, attempt: attempts });
      try {
        const result = await updateFunction(transaction);
        trace('transaction-callback-complete', {
          traceId,
          attempt: attempts,
          writeCount: transactionTrace.get(transaction)?.writeCount ?? 0,
        });
        return result;
      } catch (error) {
        trace('transaction-callback-error', {
          traceId,
          attempt: attempts,
          code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : undefined,
        });
        throw error;
      }
    }, options).then(result => {
      trace('transaction-committed', { traceId, attempts });
      return result;
    }, error => {
      trace('transaction-failed', {
        traceId,
        attempts,
        code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : undefined,
      });
      throw error;
    });
  };

  const originalGet = Transaction.prototype.get;
  Transaction.prototype.get = async function tracedGet(reference, ...args) {
    const context = transactionTrace.get(this);
    const path = pathOf(reference);
    trace('read-start', { traceId: context?.traceId, attempt: context?.attempt, path });
    try {
      const snapshot = await originalGet.call(this, reference, ...args);
      const details = snapshot?.exists
        ? safeDocumentData(typeof snapshot.data === 'function' ? snapshot.data() : undefined)
        : undefined;
      trace('read-complete', {
        traceId: context?.traceId,
        attempt: context?.attempt,
        path,
        exists: snapshot?.exists === true,
        fields: details,
      });
      return snapshot;
    } catch (error) {
      trace('read-error', {
        traceId: context?.traceId,
        attempt: context?.attempt,
        path,
        code: typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : undefined,
      });
      throw error;
    }
  };

  for (const method of ['set', 'create', 'update', 'delete']) {
    const original = Transaction.prototype[method];
    Transaction.prototype[method] = function tracedWrite(reference, data, ...args) {
      const context = transactionTrace.get(this);
      if (context) context.writeCount += 1;
      trace('write-queued', {
        traceId: context?.traceId,
        attempt: context?.attempt,
        method,
        path: pathOf(reference),
        fields: safeDocumentData(data),
      });
      return original.call(this, reference, data, ...args);
    };
  }
}
