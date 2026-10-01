/** Serialize operations on an AFF object, including its related files and metadata. */
export type ObjectAccess = <T>(uri: string, operation: () => Promise<T>) => Promise<T>;

export function createObjectAccess(): ObjectAccess {
  const tails = new Map<string, Promise<void>>();
  return <T>(uri: string, operation: () => Promise<T>): Promise<T> => {
    // Repotree gives each object a directory containing its main file and includes.
    const key = uri.slice(0, uri.lastIndexOf('/') + 1);
    const run = (tails.get(key) ?? Promise.resolve()).then(operation);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}
