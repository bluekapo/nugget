import type { Context, NextFunction } from 'grammy';

export function ownerOnly(ownerId: number) {
  return async (ctx: Context, next: NextFunction): Promise<void> => {
    if (ctx.from?.id !== ownerId) {
      // Silent drop -- do not reveal bot existence to unauthorized users
      return;
    }
    await next();
  };
}
