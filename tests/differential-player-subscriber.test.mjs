import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDifferentialPlayerSubscriber } from '../src/infrastructure/differentialPlayerSubscriber.ts';

function createHarness(options = {}) {
  const activeListeners = new Map();
  const subscribeCalls = [];
  const unsubscribeCalls = [];
  const published = [];
  const errors = [];

  const subscriber = createDifferentialPlayerSubscriber({
    subscribePlayer: (playerId, onNext, onFailure) => {
      subscribeCalls.push(playerId);
      activeListeners.set(playerId, { onNext, onFailure });
      return () => {
        unsubscribeCalls.push(playerId);
        activeListeners.delete(playerId);
      };
    },
    onPublish: values => {
      published.push(Object.fromEntries(values.entries()));
    },
    onError: error => {
      errors.push(error);
    },
    ...options,
  });

  return { subscriber, activeListeners, subscribeCalls, unsubscribeCalls, published, errors };
}

describe('Differential per-player subscriber', () => {
  test('subscribes differentially when playerIds change and unsubscribes removed players', () => {
    const { subscriber, activeListeners, subscribeCalls, unsubscribeCalls, published } = createHarness();

    subscriber.setPlayerIds(['p1', 'p2']);
    assert.deepEqual(subscribeCalls, ['p1', 'p2']);
    assert.deepEqual(unsubscribeCalls, []);

    activeListeners.get('p1').onNext({ lat: 35.1 });
    activeListeners.get('p2').onNext({ lat: 35.2 });
    assert.deepEqual(published.at(-1), { p1: { lat: 35.1 }, p2: { lat: 35.2 } });

    // Keeping p1 and replacing p2 with p3 must not re-subscribe p1
    subscriber.setPlayerIds(['p1', 'p3']);
    assert.deepEqual(subscribeCalls, ['p1', 'p2', 'p3']);
    assert.deepEqual(unsubscribeCalls, ['p2']);
    assert.deepEqual(published.at(-1), { p1: { lat: 35.1 } });

    activeListeners.get('p3').onNext({ lat: 35.3 });
    assert.deepEqual(published.at(-1), { p1: { lat: 35.1 }, p3: { lat: 35.3 } });

    subscriber.dispose();
    assert.deepEqual(unsubscribeCalls, ['p2', 'p1', 'p3']);
  });

  test('clears value and suppresses onError on permission-denied while forwarding other errors', () => {
    const { subscriber, activeListeners, published, errors } = createHarness();

    subscriber.setPlayerIds(['p1']);
    activeListeners.get('p1').onNext({ lat: 35.1 });
    assert.deepEqual(published.at(-1), { p1: { lat: 35.1 } });

    const permError = Object.assign(new Error('Missing permissions'), { code: 'permission-denied' });
    activeListeners.get('p1').onFailure(permError);
    assert.deepEqual(published.at(-1), {});
    assert.equal(errors.length, 0);

    const networkError = Object.assign(new Error('Unavailable'), { code: 'unavailable' });
    activeListeners.get('p1').onFailure(networkError);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'Unavailable');

    subscriber.dispose();
  });

  test('re-subscribes failed player when setPlayerIds is called again', () => {
    const { subscriber, activeListeners, subscribeCalls, published, errors } = createHarness();

    subscriber.setPlayerIds(['p1']);
    assert.deepEqual(subscribeCalls, ['p1']);

    const permError = Object.assign(new Error('Missing permissions'), { code: 'permission-denied' });
    activeListeners.get('p1').onFailure(permError);
    assert.equal(errors.length, 0);

    // Calling setPlayerIds again with p1 must re-subscribe because failure cleared active subscription
    subscriber.setPlayerIds(['p1']);
    assert.deepEqual(subscribeCalls, ['p1', 'p1']);

    activeListeners.get('p1').onNext({ lat: 35.68 });
    assert.deepEqual(published.at(-1), { p1: { lat: 35.68 } });

    subscriber.dispose();
  });

  test('ignores updates and setPlayerIds after dispose', () => {
    const { subscriber, activeListeners, subscribeCalls, published } = createHarness();

    subscriber.setPlayerIds(['p1']);
    const listener = activeListeners.get('p1');
    const publishedCountBeforeDispose = published.length;

    subscriber.dispose();
    subscriber.setPlayerIds(['p2']);
    listener.onNext({ lat: 35.9 });

    assert.deepEqual(subscribeCalls, ['p1']);
    assert.equal(published.length, publishedCountBeforeDispose);
  });

  test('automatically retries permission-denied subscriptions with backoff and recovers on next snapshot', async () => {
    const { subscriber, activeListeners, subscribeCalls, published, errors } = createHarness({
      retryBaseDelayMs: 15,
      maxRetryDelayMs: 60,
    });

    subscriber.setPlayerIds(['p1']);
    assert.deepEqual(subscribeCalls, ['p1']);

    const permError = Object.assign(new Error('Missing permissions'), { code: 'permission-denied' });
    activeListeners.get('p1').onFailure(permError);
    assert.equal(errors.length, 0);

    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(subscribeCalls, ['p1', 'p1']);

    activeListeners.get('p1').onNext({ lat: 35.69 });
    assert.deepEqual(published.at(-1), { p1: { lat: 35.69 } });

    subscriber.dispose();
  });

  test('cancels pending permission-denied retry timer when player is removed or disposed', async () => {
    const { subscriber, activeListeners, subscribeCalls } = createHarness({
      retryBaseDelayMs: 25,
      maxRetryDelayMs: 100,
    });

    subscriber.setPlayerIds(['p1']);
    const permError = Object.assign(new Error('Missing permissions'), { code: 'permission-denied' });
    activeListeners.get('p1').onFailure(permError);

    subscriber.setPlayerIds([]);
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.deepEqual(subscribeCalls, ['p1']);

    subscriber.setPlayerIds(['p2']);
    activeListeners.get('p2').onFailure(permError);
    subscriber.dispose();
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.deepEqual(subscribeCalls, ['p1', 'p2']);
  });
});
