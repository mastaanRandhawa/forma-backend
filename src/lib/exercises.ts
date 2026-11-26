import { prisma } from "../prisma.js";
import { badRequest } from "./errors.js";

/** Library rows a user may see: the shared catalogue plus their own custom exercises. */
export const visibleTo = (userId: string) => ({ OR: [{ ownerUserId: null }, { ownerUserId: userId }] });

/** Throws unless every id is a visible exercise (shared, or the caller's own). */
export async function assertExercisesVisible(userId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await prisma.exercise.count({ where: { id: { in: unique }, ...visibleTo(userId) } });
  if (found !== unique.length) throw badRequest("Unknown exercise");
}

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "exercise";

/** Guess the kind of a media link from its extension (the owner can still override it). */
export function mediaKindOf(url: string): "image" | "gif" | "video" {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".gif")) return "gif";
  if (/\.(mp4|mov|webm|m4v)$/.test(path)) return "video";
  return "image";
}
