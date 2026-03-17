import type { Context, NextFunction } from 'grammy';
import { logDebug, logWarn } from '../logging/logger.js';

export function ownerOnly(ownerId: number) {
  logDebug(`[auth] ownerOnly middleware created for ownerId=${ownerId}`);
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (ctx.from?.id !== ownerId) {
      logWarn(`[auth] Unauthorized access attempt from userId=${ctx.from?.id}`);
      // Silent drop -- do not reveal bot existence to unauthorized users
      return;
    }
    await next();
  };
}
