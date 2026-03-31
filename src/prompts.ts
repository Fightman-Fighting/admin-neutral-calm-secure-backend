import { z } from "zod";

export const PROMPT_PURPOSE_REWRITE = "rewrite" as const;
export const PROMPT_AUDIENCES = ["child", "ex-partner", "solicitor"] as const;
export type PromptAudience = (typeof PROMPT_AUDIENCES)[number];

export const promptComponentsSchema = z
  .object({
    system: z.string().min(1),
    userWrapper: z.string().optional(),
    defaults: z.unknown().optional(),
  })
  .strict();

export type PromptComponents = z.infer<typeof promptComponentsSchema>;
