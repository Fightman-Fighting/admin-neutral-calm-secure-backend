import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_ANON_KEY: z.string().min(20),
  CORS_ORIGIN: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
});

export const env = envSchema.parse(process.env);
