import { z } from 'zod'

/** Omitted PATCH fields must not receive the defaults used when creating rows. */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [
    key,
    // The first branch short-circuits inner defaults/transforms for undefined;
    // optional also preserves absent keys for empty-patch checks.
    z.union([z.undefined(), field]).optional(),
  ])) as { [K in keyof T]: z.ZodOptional<z.ZodUnion<[z.ZodUndefined, T[K]]>> }
  return schema.extend(shape)
}
