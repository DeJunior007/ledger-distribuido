import { z } from 'zod';

export const reversedRowsSchema = z.tuple([z.object({ reversed: z.boolean() })]);

export const processedWinRowsSchema = z.tuple([z.object({ found: z.boolean() })]);
