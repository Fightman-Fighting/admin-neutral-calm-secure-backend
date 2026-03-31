import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { z } from "zod";
import { env } from "./config";
import { requireAdmin } from "./adminAuth";
import { supabaseAdmin } from "./supabase";
import { PROMPT_AUDIENCES, PROMPT_PURPOSE_REWRITE, promptComponentsSchema } from "./prompts";

const app = express();
const port = Number(env.PORT) || 4001;
const AUDIENCE_FILTER_OPTIONS = ["all", ...PROMPT_AUDIENCES] as const;

app.use(
  cors({
    origin: env.CORS_ORIGIN || "http://localhost:3001",
    credentials: true,
  })
);
app.use(express.json());
app.use((req, res, next) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
    res.setHeader("x-response-time-ms", String(Date.now() - startedAt));
    return originalWriteHead(...args);
  }) as typeof res.writeHead;
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "admin-neutral-calm-secure-backend" });
});

app.get("/admin/prompts", requireAdmin, async (req, res) => {
  const query = z
    .object({
      purpose: z.string().optional(),
      activeOnly: z.coerce.boolean().optional(),
      activeState: z.enum(["all", "active", "deactive"]).optional(),
      audience: z.enum(AUDIENCE_FILTER_OPTIONS).optional(),
      search: z.string().optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
      sortDir: z.enum(["asc", "desc"]).optional(),
    })
    .safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: "Invalid query params" });

  const purpose = query.data.purpose || PROMPT_PURPOSE_REWRITE;
  const page = query.data.page ?? 1;
  const pageSize = query.data.pageSize ?? 10;
  const sortDir = query.data.sortDir ?? "desc";
  const activeState =
    query.data.activeState ?? (query.data.activeOnly ? "active" : "all");
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const startedAt = Date.now();
  let q = supabaseAdmin
    .from("prompt_versions")
    .select("id, purpose, audience, name, components, is_active, created_at", { count: "exact" })
    .eq("purpose", purpose)
    .order("created_at", { ascending: sortDir === "asc" })
    .range(from, to);

  if (activeState === "active") q = q.eq("is_active", true);
  if (activeState === "deactive") q = q.eq("is_active", false);
  if (query.data.audience && query.data.audience !== "all") q = q.eq("audience", query.data.audience);
  if (query.data.search?.trim()) {
    const term = query.data.search.trim().replace(/[%_]/g, "");
    q = q.or(`name.ilike.%${term}%,components->>system.ilike.%${term}%`);
  }

  const { data, error, count } = await q;
  if (error) return res.status(400).json({ error: error.message });
  res.json({
    prompt_versions: data || [],
    total: count ?? 0,
    page,
    pageSize,
    meta: { durationMs: Date.now() - startedAt },
  });
});

app.post("/admin/prompts", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const body = z
    .object({
      purpose: z.string().default(PROMPT_PURPOSE_REWRITE),
      audience: z.enum(PROMPT_AUDIENCES),
      name: z.string().min(1),
      system: z.string().min(1),
      is_active: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request body" });

  const parsedComponents = promptComponentsSchema.safeParse({
    system: body.data.system,
  });
  if (!parsedComponents.success) {
    return res.status(400).json({ error: parsedComponents.error.message });
  }

  if (body.data.is_active) {
    const { error } = await supabaseAdmin
      .from("prompt_versions")
      .update({ is_active: false })
      .eq("purpose", body.data.purpose)
      .eq("audience", body.data.audience)
      .eq("is_active", true);
    if (error) return res.status(400).json({ error: error.message });
  }

  const { data, error } = await supabaseAdmin
    .from("prompt_versions")
    .insert({
      purpose: body.data.purpose,
      audience: body.data.audience,
      name: body.data.name,
      components: parsedComponents.data,
      is_active: Boolean(body.data.is_active),
    })
    .select("id, purpose, audience, name, components, is_active, created_at")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ prompt_version: data, meta: { durationMs: Date.now() - startedAt } });
});

app.post("/admin/prompts/:id/activate", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid prompt id" });

  const { data: target, error: targetError } = await supabaseAdmin
    .from("prompt_versions")
    .select("id, purpose, audience")
    .eq("id", params.data.id)
    .single();
  if (targetError || !target) return res.status(404).json({ error: "Prompt version not found" });

  const { error: clearError } = await supabaseAdmin
    .from("prompt_versions")
    .update({ is_active: false })
    .eq("purpose", target.purpose)
    .eq("audience", target.audience)
    .eq("is_active", true);
  if (clearError) return res.status(400).json({ error: clearError.message });

  const { data, error } = await supabaseAdmin
    .from("prompt_versions")
    .update({ is_active: true })
    .eq("id", target.id)
    .select("id, purpose, audience, name, components, is_active, created_at")
    .single();
  if (error) return res.status(400).json({ error: error.message });

  res.json({ prompt_version: data, meta: { durationMs: Date.now() - startedAt } });
});

app.patch("/admin/prompts/:id", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid prompt id" });

  const body = z
    .object({
      name: z.string().min(1),
      system: z.string().min(1),
      audience: z.enum(PROMPT_AUDIENCES),
      is_active: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request body" });

  const parsedComponents = promptComponentsSchema.safeParse({ system: body.data.system });
  if (!parsedComponents.success) {
    return res.status(400).json({ error: parsedComponents.error.message });
  }

  const { data: current, error: currentError } = await supabaseAdmin
    .from("prompt_versions")
    .select("id, purpose, audience, is_active")
    .eq("id", params.data.id)
    .single();
  if (currentError || !current) return res.status(404).json({ error: "Prompt version not found" });

  const shouldBeActive = body.data.is_active ?? current.is_active;
  if (shouldBeActive) {
    const { error: clearError } = await supabaseAdmin
      .from("prompt_versions")
      .update({ is_active: false })
      .eq("purpose", current.purpose)
      .eq("audience", body.data.audience)
      .eq("is_active", true)
      .neq("id", current.id);
    if (clearError) return res.status(400).json({ error: clearError.message });
  }

  const { data, error } = await supabaseAdmin
    .from("prompt_versions")
    .update({
      name: body.data.name,
      audience: body.data.audience,
      components: parsedComponents.data,
      is_active: shouldBeActive,
    })
    .eq("id", params.data.id)
    .select("id, purpose, audience, name, components, is_active, created_at")
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ prompt_version: data, meta: { durationMs: Date.now() - startedAt } });
});

app.delete("/admin/prompts/:id", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  if (!params.success) return res.status(400).json({ error: "Invalid prompt id" });

  const { error } = await supabaseAdmin.from("prompt_versions").delete().eq("id", params.data.id);
  if (error) return res.status(400).json({ error: error.message });
  res.setHeader("x-operation-duration-ms", String(Date.now() - startedAt));
  res.status(204).send();
});

export { app };
export default app;

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Admin API listening on http://localhost:${port}`);
  });
}
