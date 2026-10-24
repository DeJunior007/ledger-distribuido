import { z } from 'zod';

export const houseAccountRowSchema = z.object({
  id: z.string(),
  currency: z.string(),
  purpose: z.string(),
  created_at: z.string(),
});

export type HouseAccountRow = z.infer<typeof houseAccountRowSchema>;
