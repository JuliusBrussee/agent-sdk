/** Race caller work against cancellation while observing any late settlement. */
export function abortable<T>(
  work: PromiseLike<T> | T,
  signal: AbortSignal | undefined,
  aborted: () => Error,
): Promise<T> {
  const promise = Promise.resolve(work);
  if (signal === undefined) return promise;
  if (signal.aborted) {
    void promise.then(() => undefined, () => undefined);
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
