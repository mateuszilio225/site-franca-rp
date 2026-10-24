/**
 * Gera data/live.json com o status ao vivo de cada streamer.
 *
 * Rodado pelo GitHub Actions a cada poucos minutos (ou manualmente com `node scripts/update-live.mjs`).
 *
 * Fontes:
 *  - Kick:   API pública não oficial usada pelo próprio site da Kick.
 *  - Twitch: API oficial Helix (precisa de TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET).
 *  - X:      sem API pública acessível, então entra apenas como link.
 */

import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TIMEOUT_MS = 20000;

const execFileAsync = promisify(execFile);

/**
 * A Kick fica atrás da Cloudflare, que bloqueia o fingerprint TLS do fetch do Node (403).
 * O curl passa normalmente, então é ele quem faz as requisições para a Kick.
 */
async function curlJson(url, extraHeaders = {}) {
  const args = ["-sS", "--fail", "--compressed", "--max-time", "25"];
  args.push("-H", `User-Agent: ${UA}`);
  args.push("-H", "Accept: application/json");
  args.push("-H", "Accept-Language: pt-BR,pt;q=0.9,en;q=0.8");
  for (const [key, value] of Object.entries(extraHeaders)) {
    args.push("-H", `${key}: ${value}`);
  }
  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });

  return JSON.parse(stdout);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Converte "2026-10-23 17:15:06" (UTC) em ISO. */
function toIso(value) {
  if (!value) return null;
  const normalized = String(value).replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function fetchKick(slug) {
  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`;
  let data;

  try {
    data = await curlJson(url);
  } catch (error) {
    // Plano B: fetch nativo (funciona quando não há bloqueio de fingerprint).
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Kick respondeu ${res.status} (${error.message})`);
    data = await res.json();
  }

  const live = data?.livestream;

  return {
    plataforma: "kick",
    aoVivo: Boolean(live),
    espectadores: Number(live?.viewer_count ?? 0),
    titulo: live?.session_title ?? "",
    categoria: live?.categories?.[0]?.name ?? "",
    iniciadoEm: toIso(live?.start_time),
    thumb: live?.thumbnail?.url ?? "",
    seguidores: Number(data?.followers_count ?? 0),
    avatar: data?.user?.profile_pic ?? "",
  };
}

async function getTwitchToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Twitch token respondeu ${res.status}`);
  const data = await res.json();
  return data.access_token ?? null;
}

async function fetchTwitchStreams(logins, token) {
  if (!token || logins.length === 0) return new Map();

  const params = new URLSearchParams();
  for (const login of logins) params.append("user_login", login);

  const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: {
      "Client-ID": process.env.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Twitch Helix respondeu ${res.status}`);

  const data = await res.json();
  const map = new Map();

  for (const stream of data?.data ?? []) {
    map.set(String(stream.user_login).toLowerCase(), {
      plataforma: "twitch",
      aoVivo: true,
      espectadores: Number(stream.viewer_count ?? 0),
      titulo: stream.title ?? "",
      categoria: stream.game_name ?? "",
      iniciadoEm: stream.started_at ?? null,
      thumb: (stream.thumbnail_url ?? "").replace("{width}", "640").replace("{height}", "360"),
      seguidores: null,
      avatar: null,
    });
  }

  return map;
}

async function main() {
  const config = await readJson(path.join(DATA_DIR, "streamers.json"));
  if (!config?.streamers?.length) {
    console.error("data/streamers.json não encontrado ou vazio.");
    return;
  }

  const previous = (await readJson(path.join(DATA_DIR, "live.json"), {})).streamers ?? {};
  const result = {};

  const kickStreamers = config.streamers.filter(
    (s) => s.plataforma === "kick" && s.aoVivoSuportado !== false
  );
  const twitchStreamers = config.streamers.filter(
    (s) => s.plataforma === "twitch" && s.aoVivoSuportado !== false
  );

  // ---- Kick ----
  for (const streamer of kickStreamers) {
    const slug = streamer.slug || streamer.id;
    try {
      result[streamer.id] = await fetchKick(slug);
      console.log(`[kick] ${slug}: ${result[streamer.id].aoVivo ? "AO VIVO" : "offline"}`);
    } catch (error) {
      // Mantém o último estado conhecido para não "piscar" no site.
      result[streamer.id] = previous[streamer.id] ?? {
        plataforma: "kick",
        aoVivo: false,
        espectadores: 0,
      };
      console.warn(`[kick] ${slug}: falhou (${error.message}) — usando estado anterior`);
    }
  }

  // ---- Twitch ----
  if (twitchStreamers.length) {
    try {
      const token = await getTwitchToken();
      if (!token) {
        console.log("[twitch] credenciais ausentes — pulando Twitch");
      } else {
        const live = await fetchTwitchStreams(
          twitchStreamers.map((s) => s.slug || s.id),
          token
        );
        for (const streamer of twitchStreamers) {
          const key = String(streamer.slug || streamer.id).toLowerCase();
          result[streamer.id] = live.get(key) ?? {
            plataforma: "twitch",
            aoVivo: false,
            espectadores: 0,
            titulo: "",
            categoria: "",
            iniciadoEm: null,
            thumb: "",
          };
          console.log(`[twitch] ${key}: ${result[streamer.id].aoVivo ? "AO VIVO" : "offline"}`);
        }
      }
    } catch (error) {
      console.warn(`[twitch] falhou: ${error.message}`);
      for (const streamer of twitchStreamers) {
        result[streamer.id] = previous[streamer.id] ?? {
          plataforma: "twitch",
          aoVivo: false,
          espectadores: 0,
        };
      }
    }
  }

  // ---- Plataformas sem status ao vivo (X) ----
  for (const streamer of config.streamers) {
    if (result[streamer.id]) continue;
    result[streamer.id] = {
      plataforma: streamer.plataforma,
      aoVivo: false,
      espectadores: 0,
      semStatusAoVivo: true,
    };
  }

  const payload = {
    geradoEm: new Date().toISOString(),
    streamers: result,
  };

  await writeFile(
    path.join(DATA_DIR, "live.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );

  const aoVivo = Object.values(result).filter((s) => s.aoVivo);
  console.log(`\nOK — ${aoVivo.length} ao vivo de ${config.streamers.length} streamers.`);
}

main().catch((error) => {
  console.error("Falha ao atualizar o status:", error);
  process.exitCode = 1;
});
