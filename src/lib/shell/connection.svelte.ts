/** Why the live connection is gone for good, as long as it is: the banner says it, and the reconnect takes it away. */
export const connection = $state<{ lost: 'offline' | 'expired' | null }>({ lost: null });
