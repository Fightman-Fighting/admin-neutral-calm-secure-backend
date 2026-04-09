import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { z } from "zod";
import { env } from "./config";
import { requireAdmin } from "./adminAuth";
import { supabaseAdmin } from "./supabase";
import { PROMPT_PURPOSE_REWRITE, promptComponentsSchema } from "./prompts";

const app = express();
const port = Number(env.PORT) || 4001;

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
      audience: z.string().optional(),
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
      audience: z.string().min(1),
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
      audience: z.string().min(1),
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

// ── Audiences CRUD ──

app.get("/admin/audiences", requireAdmin, async (_req, res) => {
  const startedAt = Date.now();
  const { data, error } = await supabaseAdmin
    .from("audiences")
    .select("code, label, icon, color, aliases, sort_order, is_active")
    .order("sort_order", { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ audiences: data || [], meta: { durationMs: Date.now() - startedAt } });
});

app.post("/admin/audiences", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const body = z
    .object({
      code: z.string().min(1).max(40),
      label: z.string().min(1),
      icon: z.string().default("Users"),
      color: z.string().default("slate"),
      aliases: z.array(z.string()).default([]),
      sort_order: z.number().int().default(0),
      is_active: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request body" });

  const { data, error } = await supabaseAdmin
    .from("audiences")
    .insert(body.data)
    .select("code, label, icon, color, aliases, sort_order, is_active")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ audience: data, meta: { durationMs: Date.now() - startedAt } });
});

app.patch("/admin/audiences/:code", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const code = req.params.code;
  if (!code) return res.status(400).json({ error: "Missing audience code" });

  const body = z
    .object({
      label: z.string().min(1).optional(),
      icon: z.string().optional(),
      color: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      sort_order: z.number().int().optional(),
      is_active: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request body" });

  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body.data)) {
    if (v !== undefined) updates[k] = v;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabaseAdmin
    .from("audiences")
    .update(updates)
    .eq("code", code)
    .select("code, label, icon, color, aliases, sort_order, is_active")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Audience not found" });
  res.json({ audience: data, meta: { durationMs: Date.now() - startedAt } });
});

app.delete("/admin/audiences/:code", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const code = req.params.code;
  if (!code) return res.status(400).json({ error: "Missing audience code" });

  const { error } = await supabaseAdmin.from("audiences").delete().eq("code", code);
  if (error) return res.status(400).json({ error: error.message });
  res.setHeader("x-operation-duration-ms", String(Date.now() - startedAt));
  res.status(204).send();
});

// ── Countries CRUD ──

app.get("/admin/countries", requireAdmin, async (_req, res) => {
  const startedAt = Date.now();
  const { data, error } = await supabaseAdmin
    .from("countries")
    .select("code, label, aliases, sort_order, is_active")
    .order("sort_order", { ascending: true });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ countries: data || [], meta: { durationMs: Date.now() - startedAt } });
});

app.post("/admin/countries", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const body = z
    .object({
      code: z.string().min(2).max(20),
      label: z.string().min(1),
      aliases: z.array(z.string()).default([]),
      sort_order: z.number().int().default(0),
      is_active: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request body" });

  const { data, error } = await supabaseAdmin
    .from("countries")
    .insert(body.data)
    .select("code, label, aliases, sort_order, is_active")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json({ country: data, meta: { durationMs: Date.now() - startedAt } });
});

app.patch("/admin/countries/:code", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const code = req.params.code;
  if (!code) return res.status(400).json({ error: "Missing country code" });

  const body = z
    .object({
      label: z.string().min(1).optional(),
      aliases: z.array(z.string()).optional(),
      sort_order: z.number().int().optional(),
      is_active: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Invalid request body" });

  const updates: Record<string, unknown> = {};
  if (body.data.label !== undefined) updates.label = body.data.label;
  if (body.data.aliases !== undefined) updates.aliases = body.data.aliases;
  if (body.data.sort_order !== undefined) updates.sort_order = body.data.sort_order;
  if (body.data.is_active !== undefined) updates.is_active = body.data.is_active;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  const { data, error } = await supabaseAdmin
    .from("countries")
    .update(updates)
    .eq("code", code)
    .select("code, label, aliases, sort_order, is_active")
    .single();
  if (error) return res.status(400).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Country not found" });
  res.json({ country: data, meta: { durationMs: Date.now() - startedAt } });
});

app.delete("/admin/countries/:code", requireAdmin, async (req, res) => {
  const startedAt = Date.now();
  const code = req.params.code;
  if (!code) return res.status(400).json({ error: "Missing country code" });

  const { error } = await supabaseAdmin.from("countries").delete().eq("code", code);
  if (error) return res.status(400).json({ error: error.message });
  res.setHeader("x-operation-duration-ms", String(Date.now() - startedAt));
  res.status(204).send();
});

// ── Prompts ──

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
