// AgentDesk wrapper around Agent HUD's procedural bot engine (jazzenchen/agent-hud-open, Apache-2.0,
// commit 557615f). The engine files under bots/ are bundled unchanged; this file replaces the React
// BotMark component with a plain DOM mount, and loads AgentDesk's own copies of the provider artwork.
// Clawd's sprite sheet (Anthropic artwork, not covered by that licence) is never loaded or included.
import { BotActor } from "agent-hud-open/src/packages/hud/src/bots/bot-actor";
import { botState } from "agent-hud-open/src/packages/hud/src/bots/bot-state";
import { makeForm } from "agent-hud-open/src/packages/hud/src/bots/bot-form";
import { clock, paintMark } from "agent-hud-open/src/packages/hud/src/bots/mark-painter";

// Tints as Agent HUD applies them: OpenAI's brand green; template marks take the foreground colour.
function tintFor(key: string, light: boolean): string | null {
  if (key === "openai") return "#10a37f";
  if (key === "grok") return light ? "#1d1d1f" : "#ffffff";
  return null;
}

const images = new Map<string, Promise<HTMLImageElement>>();
function loadArtwork(url: string, key: string, light: boolean): Promise<HTMLCanvasElement> {
  let loading = images.get(url);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("artwork " + key));
      image.src = url;
    });
    images.set(url, loading);
  }
  return loading.then((image) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0, 256, 256);
    const tint = tintFor(key, light);
    if (tint) {
      context.globalCompositeOperation = "source-in";
      context.fillStyle = tint;
      context.fillRect(0, 0, 256, 256);
      context.globalCompositeOperation = "source-over";
    }
    return canvas;
  });
}

export interface MountOptions {
  key: string; url: string; size: number; light: boolean;
  state: Record<string, unknown>; still?: boolean;
}

export function mount(host: HTMLElement, options: MountOptions) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none";
  canvas.style.visibility = "hidden";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  const actor = new BotActor(botState(options.state as never), clock(), {});
  const props = { current: { size: options.size, enabled: !options.still, outline: 0 } };
  const localAim = { current: [0, 0] as readonly [number, number] };
  let painter: ReturnType<typeof paintMark> | undefined;
  let disposed = false;
  loadArtwork(options.url, options.key, options.light).then((artwork) => {
    if (disposed) return;
    const form = makeForm(options.key, artwork, options.light);
    if (form) actor.fit(form);
    painter = paintMark(canvas, ctx, {
      actor, key: options.key, light: options.light, artwork, form, sheet: null, props, localAim,
      onReady: () => { canvas.style.visibility = ""; host.dataset.ready = "1"; },
    });
  }).catch(() => { host.dataset.failed = "1"; });
  const aim = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    localAim.current = [clamp((event.clientX - rect.x - rect.width / 2) / Math.max(1, rect.width)),
      clamp((event.clientY - rect.y - rect.height / 2) / Math.max(1, rect.height))];
    painter?.wake(true);
  };
  const enter = () => { actor.set(botState({ ...(options.state as object), hovered: true } as never), clock()); painter?.wake(); };
  const leave = () => { actor.set(botState(options.state as never), clock()); painter?.wake(); };
  if (!options.still) {
    host.addEventListener("pointermove", aim);
    host.addEventListener("pointerenter", enter);
    host.addEventListener("pointerleave", leave);
  }
  return {
    set(state: Record<string, unknown>, cue?: { event: string; at: number }) {
      options.state = state;
      const now = clock();
      const changed = actor.set(botState(state as never), now);
      const played = cue ? actor.playCue(cue as never, now) : false;
      if (changed || played) painter?.wake();
    },
    clock,
    dispose() {
      disposed = true;
      painter?.dispose();
      host.removeEventListener("pointermove", aim);
      host.removeEventListener("pointerenter", enter);
      host.removeEventListener("pointerleave", leave);
      canvas.remove();
    },
  };
}
