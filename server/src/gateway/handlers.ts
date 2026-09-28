// Hub dispatch for `gateway.*` requests (kept out of hub.ts).
import type { GatewayRequest } from './types.js';
import type { GatewayService } from './service.js';

export const isGatewayRequest = (req: { kind: string }): req is GatewayRequest => req.kind.startsWith('gateway.');

export async function handleGatewayRequest(gw: GatewayService, req: GatewayRequest): Promise<unknown> {
  switch (req.kind) {
    case 'gateway.status':
      return gw.status();
    case 'gateway.set':
      await gw.setEnabled(!!req.enabled);
      return gw.status();
    case 'gateway.revealKey':
      return gw.revealKey();
    case 'gateway.regenerateKey':
      await gw.regenerateKey();
      return gw.status();
    case 'gateway.groups.upsert':
      return gw.upsertGroup(req.group);
    case 'gateway.groups.remove':
      await gw.removeGroup(req.id);
      return null;
    case 'gateway.reset':
      gw.reset(req.groupId, req.providerId);
      return gw.status();
    case 'gateway.test':
      return gw.test(req.groupId, req.protocol);
  }
  throw new Error(`unknown request ${(req as { kind: string }).kind}`);
}
