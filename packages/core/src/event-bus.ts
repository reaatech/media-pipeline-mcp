export type EventHandler<E> = (event: E) => void | Promise<void>;

export interface EventBus<E extends { kind: string }> {
  on<K extends E['kind']>(kind: K, handler: EventHandler<Extract<E, { kind: K }>>): () => void;
  emit(event: E): void;
  await<K extends E['kind']>(
    kind: K,
    predicate?: (e: Extract<E, { kind: K }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<E, { kind: K }>>;
}

export function createEventBus<E extends { kind: string }>(): EventBus<E> {
  const handlers = new Map<E['kind'], Set<EventHandler<E>>>();

  function on<K extends E['kind']>(
    kind: K,
    handler: EventHandler<Extract<E, { kind: K }>>,
  ): () => void {
    if (!handlers.has(kind)) {
      handlers.set(kind, new Set());
    }
    handlers.get(kind)?.add(handler as EventHandler<E>);

    return () => {
      handlers.get(kind)?.delete(handler as EventHandler<E>);
    };
  }

  function emit(event: E): void {
    const kindHandlers = handlers.get(event.kind);
    if (kindHandlers) {
      for (const handler of kindHandlers) {
        const result = handler(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error(`EventBus handler error for ${event.kind}:`, err);
          });
        }
      }
    }
  }

  function awaitEvent<K extends E['kind']>(
    kind: K,
    predicate?: (e: Extract<E, { kind: K }>) => boolean,
    timeoutMs?: number,
  ): Promise<Extract<E, { kind: K }>> {
    return new Promise<Extract<E, { kind: K }>>((resolve, reject) => {
      let disposer: () => void = () => {};

      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(() => {
              disposer();
              reject(new Error(`await(${kind}) timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;

      const removeHandler = on(kind, (event) => {
        const match = predicate ? predicate(event as Extract<E, { kind: K }>) : true;
        if (match) {
          if (timer) clearTimeout(timer);
          removeHandler();
          resolve(event as Extract<E, { kind: K }>);
        }
      });

      disposer = () => {
        if (timer) clearTimeout(timer);
        removeHandler();
      };
    });
  }

  return {
    on,
    emit,
    await: awaitEvent,
  };
}
