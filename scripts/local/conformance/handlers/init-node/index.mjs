/**
 * Initialization-failure fixture: module loading throws, so the runtime calls
 * the initialization error API and exits immediately.
 * https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
 */
throw new Error("node init failure");

export const handler = async () => ({ ok: true });
