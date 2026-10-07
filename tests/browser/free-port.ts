import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Returns a port that was free a moment ago; the number is not reserved, so the caller must bind
 * it immediately.
 */
export async function findFreePort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', resolve);
	});
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}
