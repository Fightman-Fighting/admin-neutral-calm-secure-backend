import { Request, Response, NextFunction } from "express";
import { supabaseAdmin, supabaseAnon } from "./supabase";
import { env } from "./config";

export interface AdminRequest extends Request {
  adminUserId?: string;
  adminViaKey?: boolean;
}

export async function requireAdmin(req: AdminRequest, res: Response, next: NextFunction) {
  const key = req.header("x-admin-key");
  if (env.ADMIN_API_KEY && key && key === env.ADMIN_API_KEY) {
    req.adminViaKey = true;
    return next();
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Admin authentication required" });
  }

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError || !profile || profile.role !== "admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  req.adminUserId = data.user.id;
  next();
}
