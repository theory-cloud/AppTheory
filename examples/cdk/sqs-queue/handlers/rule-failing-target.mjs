/**
 * Always fails so the local EventBridge deliverer proves its retry policy and
 * dead-letter queue on the real path.
 */
export const handler = async () => {
  throw new Error("rule target failure");
};
