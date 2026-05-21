import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../event-bus.js';

// Discriminated union so Extract<E, { kind: K }> resolves to a concrete shape
// per kind. The previous flat-interface form collapsed to `never` once the
// event-bus generics tightened, which broke `await(...)` typing in this file.
type TestEvent =
  | { kind: 'user_created'; userId: string; name?: string }
  | { kind: 'user_updated'; userId: string }
  | { kind: 'pipeline_started' };

describe('EventBus', () => {
  it('should emit and handle events via on/emit', () => {
    const bus = createEventBus<TestEvent>();
    const handler = vi.fn();

    bus.on('user_created', handler);
    bus.emit({ kind: 'user_created', userId: 'u1', name: 'Alice' });

    expect(handler).toHaveBeenCalledWith({ kind: 'user_created', userId: 'u1', name: 'Alice' });
  });

  it('should handle multiple handlers for the same event kind', () => {
    const bus = createEventBus<TestEvent>();
    const h1 = vi.fn();
    const h2 = vi.fn();

    bus.on('user_created', h1);
    bus.on('user_created', h2);
    bus.emit({ kind: 'user_created', userId: 'u1' });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should not call handlers for different event kinds', () => {
    const bus = createEventBus<TestEvent>();
    const handler = vi.fn();

    bus.on('user_created', handler);
    bus.emit({ kind: 'pipeline_started' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should handle errors in handlers gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createEventBus<TestEvent>();

    bus.on('user_created', async () => {
      throw new Error('handler error');
    });
    bus.emit({ kind: 'user_created', userId: 'u1' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(consoleSpy).toHaveBeenCalledWith(
      'EventBus handler error for user_created:',
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it('should support unsubscribe via returned disposer', () => {
    const bus = createEventBus<TestEvent>();
    const handler = vi.fn();

    const dispose = bus.on('user_created', handler);
    dispose();
    bus.emit({ kind: 'user_created', userId: 'u1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should be idempotent on multiple dispose calls', () => {
    const bus = createEventBus<TestEvent>();
    const handler = vi.fn();

    const dispose = bus.on('user_created', handler);
    dispose();
    dispose();
    bus.emit({ kind: 'user_created', userId: 'u1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should await a specific event', async () => {
    const bus = createEventBus<TestEvent>();

    setTimeout(() => {
      bus.emit({ kind: 'user_created', userId: 'u2', name: 'Bob' });
    }, 10);

    const event = await bus.await('user_created');
    expect(event.userId).toBe('u2');
    expect(event.name).toBe('Bob');
  });

  it('should await with predicate', async () => {
    const bus = createEventBus<TestEvent>();

    setTimeout(() => {
      bus.emit({ kind: 'user_created', userId: 'u1', name: 'Alice' });
      bus.emit({ kind: 'user_created', userId: 'u2', name: 'Bob' });
    }, 10);

    const event = await bus.await('user_created', (e) => e.userId === 'u2');
    expect(event.userId).toBe('u2');
  });

  it('should timeout when event does not arrive', async () => {
    const bus = createEventBus<TestEvent>();

    await expect(bus.await('user_created', undefined, 50)).rejects.toThrow('timed out');
  });

  it('should not timeout when timeoutMs is 0', async () => {
    const bus = createEventBus<TestEvent>();

    setTimeout(() => {
      bus.emit({ kind: 'user_created', userId: 'u1' });
    }, 10);

    const event = await bus.await('user_created', undefined, 0);
    expect(event.userId).toBe('u1');
  });

  it('should handle async handlers properly', async () => {
    const bus = createEventBus<TestEvent>();
    const order: string[] = [];

    bus.on('user_created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('async');
    });

    bus.on('user_created', () => {
      order.push('sync');
    });

    bus.emit({ kind: 'user_created', userId: 'u1' });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toContain('sync');
    expect(order).toContain('async');
  });
});
