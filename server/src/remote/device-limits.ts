// What a paired device (a phone on the LAN listener, another computer joined through federation) may not do, whatever
// it asks (security-audit SEC-06): a device token is close to full control, but it must not be able to mint more of
// itself (a new pairing code), lock the computer's owner out (revoke / rename devices, turn the listener off) or read
// the secrets this computer keeps (environment variable values, IM pairing codes). Only a window on this computer can.
import type { ClientRequest } from '../protocol.js';
import { tr } from '../i18n/index.js';

const DEVICE_REFUSED = new Set<ClientRequest['kind']>([
  'remote.set', 'remote.pairCode', 'remote.devices.revoke', 'remote.devices.rename',
  'env.reveal', 'im.pairCode', 'secrets.migrate',
]);

/** Why a request from a paired device is refused; null = judged like any other. */
export function refusedFromDevice(req: ClientRequest): string | null {
  return DEVICE_REFUSED.has(req.kind) ? tr('这件事只能在这台电脑上做，配对的设备不行') : null;
}
