import { z } from 'zod';

export const insertedInboxMessageRowsSchema = z.array(z.object({ message_id: z.string() }));
