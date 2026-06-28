export function handleError(err: unknown): Error {
  if (err instanceof Error) {
    console.error(err);
    return err;
  }

  const wrapped = new Error('Unknown error', { cause: err });
  console.error(wrapped);
  return wrapped;
}
