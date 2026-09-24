import { z } from 'zod';
export const plainText = (max, min = 0) => z.string().trim().min(min).max(max).refine(v => !/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v), 'Use plain text without markup or control characters.');
export const metadataSchema = z.object({ displayName:plainText(150,1), description:plainText(1000,1), category:plainText(80,1), helpText:plainText(500) }).strict();
export const auditQuerySchema = z.object({
  page:z.coerce.number().int().min(1).max(10000).default(1), pageSize:z.coerce.number().int().min(1).max(100).default(25),
  siteId:z.string().uuid().optional(), action:z.string().regex(/^[A-Z_]{1,50}$/).optional(),
  actorId:z.string().uuid().optional(), from:z.iso.datetime().optional(), to:z.iso.datetime().optional(),
}).strict();
