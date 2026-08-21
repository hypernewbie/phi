/**
 * Pet renderer state machine — a vanilla-DOM port of dsh-pet's
 * media catalog, dual-buffer playback, click/drag interaction, and zoom
 * handling. Media loads through relative file:// URLs under the page's own
 * directory.
 */
import type {
  PetApi,
  PetDragPosition,
  PetStageLayout,
  PetZoomState,
  StageRect,
} from "./pet-bridge.js";

/** The sentinel "show the static maid image" state — never a webm filename. */
export const STATIC = "STATIC";
/** The drag feedback animation (played while the pointer drags). */
export const DRAG = "被鼠标拖拽悬空反馈";
/** The stationary act pool. */
export const ACTS = [
  "悠闲哼歌",
  "超大伸懒腰",
  "原地专心玩魔方",
  "原地敲击桌面互动",
  "原地重力下蹲压缩",
  "哈欠连天",
  "原地小憩沉眠",
  "原地蹲下玩玩具汽车",
  "鲸鱼吐泡泡特效",
  "女仆屈膝礼仪",
  "被吓一跳（炸毛）",
  "原地跳跃抓碎头顶物品",
  "小幅度原地 360 度旋转展示",
  "偷吃零食被抓住",
  "玩游戏气急败坏",
  "用鲸鱼尾巴拍打地面",
  "打瞌睡被惊醒",
  "玩水枪",
  "小提琴演奏",
  "蓝鲸现世",
  "吃白饭",
  "照镜子",
  "优雅女仆舞",
  "轻快摇摆舞",
  "可爱宅舞",
  "整体换装试色",
  "大口吃零食",
  "吹气球",
  "动物环绕",
  "深度思考碎碎念",
  "轻快记录",
  "写代码",
  "吃Token",
  "吃早餐",
  "吃午餐",
  "吃晚餐",
  "放风筝",
  "摇扇纳凉",
  "吃冰淇淋融化",
  "被落叶淹没",
  "中秋赏月吃月饼",
  "堆雪人",
];
/** The click-reaction pool. */
export const CLICKS = [
  "点击回应 - 开心跃动",
  "点击回应 - 害羞惊讶",
  "点击回应 - 傲娇生气（侧身展示）",
];
/** Pointer distance at which a click becomes a drag. */
export const DRAG_THRESHOLD = 5;

export const PET_ZOOM_MIN_PERCENT = 50;
export const PET_ZOOM_MAX_PERCENT = 300;
export const PET_ZOOM_DEFAULT_PERCENT = 100;
export const PET_ZOOM_STEP_PERCENT = 25;
export const PET_BASE_VISUAL_WIDTH_DIP = 192;

const strictDecimal = (value: string | null): number | null => {
  if (value === null || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function queryZoomConfig(): {
  percent: number;
  minPercent: number;
  maxPercent: number;
  defaultPercent: number;
  stepPercent: number;
  baseVisualWidth: number;
} {
  const fallback = {
    percent: PET_ZOOM_DEFAULT_PERCENT,
    minPercent: PET_ZOOM_MIN_PERCENT,
    maxPercent: PET_ZOOM_MAX_PERCENT,
    defaultPercent: PET_ZOOM_DEFAULT_PERCENT,
    stepPercent: PET_ZOOM_STEP_PERCENT,
    baseVisualWidth: PET_BASE_VISUAL_WIDTH_DIP,
  };
  const values = [
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomMinPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomMaxPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomDefaultPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petZoomStepPercent"),
    ),
    strictDecimal(
      new URLSearchParams(window.location.search).get("petBaseVisualWidth"),
    ),
  ];
  if (values.some((value) => value === null)) return fallback;
  const [
    percent,
    minPercent,
    maxPercent,
    defaultPercent,
    stepPercent,
    baseVisualWidth,
  ] = values as number[];
  if (
    !Number.isInteger(percent) ||
    !Number.isInteger(minPercent) ||
    !Number.isInteger(maxPercent) ||
    !Number.isInteger(defaultPercent) ||
    !Number.isInteger(stepPercent) ||
    minPercent > maxPercent ||
    defaultPercent < minPercent ||
    defaultPercent > maxPercent ||
    percent < minPercent ||
    percent > maxPercent ||
    stepPercent <= 0 ||
    (percent - minPercent) % stepPercent !== 0 ||
    (defaultPercent - minPercent) % stepPercent !== 0 ||
    baseVisualWidth <= 0
  )
    return fallback;
  return {
    percent,
    minPercent,
    maxPercent,
    defaultPercent,
    stepPercent,
    baseVisualWidth,
  };
}

/** The media directory under the package root (dist/ → ../assets/thumb/). */
const MEDIA_PREFIX = "../assets/thumb/";

/** The chain decision for a given random roll. */

/** Equal-probability pool pick with an optional exclude. */
export function pick(
  pool: readonly string[],
  exclude: string | null,
  rng: () => number,
): string {
  const entries = exclude === null ? pool : pool.filter((n) => n !== exclude);
  return entries[Math.floor(rng() * entries.length)] ?? pool[0] ?? "";
}

/** The injected DOM + bridge the controller drives. */
export interface PetInitOptions {
  root: HTMLElement;
  stage: HTMLElement;
  videoA: HTMLVideoElement;
  videoB: HTMLVideoElement;
  staticImg: HTMLImageElement;
  hit: HTMLElement;
  bridge: PetApi;
  rng?: () => number;
  raf?: (cb: FrameRequestCallback) => number;
  caf?: (id: number) => void;
}

export interface PetState {
  anim: string;
  once: boolean;
  facing: "left" | "right";
  dragging: boolean;
}

export interface PetController {
  getState(): PetState;
  destroy(): void;
}

export function initPet(opts: PetInitOptions): PetController {
  const { root, stage, videoA, videoB, staticImg, hit, bridge } = opts;
  const rng = opts.rng ?? Math.random;
  const raf =
    opts.raf ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((id: number) => cancelAnimationFrame(id));
  const zoomConfig = queryZoomConfig();
  const validDwellSeconds = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 3600;
  const queryDwell = (): number => {
    const value = Number(
      new URLSearchParams(window.location.search).get("petIdleDwellSeconds"),
    );
    return validDwellSeconds(value) ? value : 10;
  };
  let dwellSeconds = queryDwell(); // canonical seconds (1..3600) for the next rest
  let zoomPercent = zoomConfig.percent;
  let desiredZoomPercent = zoomPercent;
  let zoomRequestInFlight: number | null = null;
  let wheelRemainder = 0;
  let stageWidth = 0;
  let stageHeight = 0;

  const layout = (): void => {
    stageWidth = Math.floor((zoomConfig.baseVisualWidth * zoomPercent) / 100);
    stageHeight = Math.floor((stageWidth * 9) / 16);
    root.style.width = `${stageWidth}px`;
    root.style.height = `${stageHeight}px`;
    root.style.transform = "none";
    stage.style.width = `${stageWidth}px`;
    stage.style.height = `${stageHeight}px`;
    stage.style.transform = "none";
    hit.style.inset = "0px";
  };

  let anim = STATIC;
  let once = false;
  const facing: "left" | "right" = "left";
  let dragging = false;

  let front = 0; // 0 = videoA front, 1 = videoB front
  let pending: {
    anim: string;
    once: boolean;
    gen: number;
  } | null = null;
  let gen = 0;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  const clearRestTimer = (): void => {
    if (restTimer !== null) clearTimeout(restTimer);
    restTimer = null;
  };

  let drag = { active: false, dragging: false, sx: 0, sy: 0 };
  let justDragged = false;
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStageRect: StageRect | null = null;
  let pendingDragPosition: PetDragPosition | null = null;
  let pendingDragFrame: number | null = null;

  const setAnim = (next: string, nextOnce: boolean): void => {
    anim = next;
    once = nextOnce;
    switchTo(anim, once);
  };

  const startStatic = (): void => {
    anim = STATIC;
    once = false;
    staticImg.src = MEDIA_PREFIX + "maid-static.png";
    staticImg.classList.add("is-front");
    videoA.classList.remove("is-front");
    videoB.classList.remove("is-front");
    clearRestTimer();
    restTimer = setTimeout(playRandomAct, dwellSeconds * 1000);
  };

  const handleEnded = (): void => {
    if (drag.active) return;
    startStatic();
  };

  const playRandomAct = (): void => {
    switchTo(pick(ACTS, null, rng), true);
  };

  const switchTo = (next: string, nextOnce: boolean): void => {
    if (pending && pending.anim === next && pending.once === nextOnce) return;
    clearRestTimer();
    anim = next;
    once = nextOnce;
    const currentGen = ++gen;
    pending = { anim: next, once: nextOnce, gen: currentGen };

    const el = front === 0 ? videoB : videoA;
    el.src = MEDIA_PREFIX + encodeURIComponent(next) + ".webm";
    el.loop = !nextOnce;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.onended = null;
    const onError = (): void => {
      el.removeEventListener("error", onError);
      if (pending?.gen === currentGen) startStatic();
    };
    el.addEventListener("error", onError);
    el.load();

    const onReady = (): void => {
      el.removeEventListener("loadeddata", onReady);
      el.removeEventListener("error", onError);
      if (pending?.gen !== currentGen) return;
      const old = front === 0 ? videoA : videoB;
      if (old && old !== el) {
        old.onended = null;
        old.pause();
        old.classList.remove("is-front");
      }
      staticImg.classList.remove("is-front");
      el.classList.add("is-front");
      front = front === 0 ? 1 : 0;
      pending = null;
      el.onended = nextOnce
        ? () => {
            // Clear the one-shot callback before transitioning so duplicate
            // ended notifications cannot re-enter startStatic.
            el.onended = null;
            handleEnded();
          }
        : null;
      el.style.transform = "";
      void Promise.resolve(el.play()).catch(() => {
        if (gen === currentGen) startStatic();
      });
    };
    el.addEventListener("loadeddata", onReady);
    if (el.readyState >= 2) onReady();
  };

  const captureDragAnchor = (e: PointerEvent): void => {
    const rect = stage.getBoundingClientRect();
    dragStageRect = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
    dragAnchor = { x: e.clientX - rect.x, y: e.clientY - rect.y };
  };

  const scheduleDragPosition = (): void => {
    if (pendingDragFrame !== null) return;
    pendingDragFrame = raf(() => {
      pendingDragFrame = null;
      const position = pendingDragPosition;
      pendingDragPosition = null;
      if (position) bridge.sendDragPosition(position);
    });
  };

  const flushDragPosition = (): void => {
    if (pendingDragFrame !== null) {
      caf(pendingDragFrame);
      pendingDragFrame = null;
    }
    const position = pendingDragPosition;
    pendingDragPosition = null;
    if (position) bridge.sendDragPosition(position);
  };

  const clearDrag = (): void => {
    drag.active = false;
    drag.dragging = false;
    hit.classList.remove("dragging");
    dragging = false;
    dragAnchor = null;
    dragStageRect = null;
  };

  const handlePointerDown = (e: PointerEvent): void => {
    hit.classList.add("dragging");
    if (typeof hit.setPointerCapture === "function")
      hit.setPointerCapture(e.pointerId);
    drag = {
      active: true,
      dragging: false,
      sx: e.clientX,
      sy: e.clientY,
    };
  };

  const handlePointerMove = (e: PointerEvent): void => {
    if (!drag.active) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.dragging = true;
      dragging = true;
      captureDragAnchor(e);
      setAnim(DRAG, true);
    }
    if (!dragAnchor || !dragStageRect) return;
    pendingDragPosition = {
      phase: "move",
      screenX: e.screenX,
      screenY: e.screenY,
      anchorX: dragAnchor.x,
      anchorY: dragAnchor.y,
      stage: dragStageRect,
    };
    scheduleDragPosition();
  };

  const handlePointerUp = (e: PointerEvent): void => {
    if (!drag.active) return;
    const wasDragging = drag.dragging;
    if (wasDragging && dragAnchor && dragStageRect) {
      const finalPosition: PetDragPosition = {
        phase: "move",
        screenX: e.screenX,
        screenY: e.screenY,
        anchorX: dragAnchor.x,
        anchorY: dragAnchor.y,
        stage: dragStageRect,
      };
      pendingDragPosition = finalPosition;
      flushDragPosition();
      bridge.sendDragPosition({ ...finalPosition, phase: "end" });
    }
    clearDrag();
    if (!wasDragging) return;
    justDragged = true;
    setTimeout(() => {
      justDragged = false;
    }, 100);
    startStatic();
  };

  const handlePointerCancel = (): void => {
    if (!drag.active) return;
    const wasDragging = drag.dragging;
    if (pendingDragFrame !== null) {
      caf(pendingDragFrame);
      pendingDragFrame = null;
    }
    pendingDragPosition = null;
    if (wasDragging && dragStageRect && dragAnchor) {
      bridge.sendDragPosition({
        phase: "cancel",
        screenX: 0,
        screenY: 0,
        anchorX: dragAnchor.x,
        anchorY: dragAnchor.y,
        stage: dragStageRect,
      });
    }
    clearDrag();
    if (wasDragging) startStatic();
  };

  const handleClick = (): void => {
    if (drag.active || drag.dragging || justDragged) return;
    setAnim(pick(CLICKS, null, rng), true);
  };

  hit.addEventListener("pointerdown", handlePointerDown);
  hit.addEventListener("pointermove", handlePointerMove);
  hit.addEventListener("pointerup", handlePointerUp);
  hit.addEventListener("pointercancel", handlePointerCancel);
  hit.addEventListener("click", handleClick);

  // Verify mode: log once the first video actually starts playing, or once
  // the static image loads (whichever happens first — the new STATIC initial
  // state means no <video> plays for 30s).
  if (new URLSearchParams(window.location.search).get("verify") === "1") {
    let verified = false;
    const verifyLog = (source: string, detail: string): void => {
      if (verified) return;
      verified = true;
      console.log(`pet-verify-ok ${source} ${detail}`);
    };
    const onPlaying = (el: HTMLVideoElement): void => {
      verifyLog("video-readyState", String(el.readyState));
    };
    videoA.addEventListener("playing", () => onPlaying(videoA));
    videoB.addEventListener("playing", () => onPlaying(videoB));
    staticImg.addEventListener("load", () => verifyLog("static", "loaded"));
  }

  const reportLayout = (): void => {
    const rect = stage.getBoundingClientRect();
    const payload: PetStageLayout = {
      stage: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
    bridge.reportStageLayout(payload);
  };

  const requestZoom = (): void => {
    if (zoomRequestInFlight !== null || desiredZoomPercent === zoomPercent)
      return;
    zoomRequestInFlight = desiredZoomPercent;
    bridge.requestZoomPercent({ percent: desiredZoomPercent });
  };

  const applyZoomState = (state: PetZoomState): void => {
    if (
      !Number.isInteger(state.percent) ||
      state.percent < zoomConfig.minPercent ||
      state.percent > zoomConfig.maxPercent ||
      (state.percent - zoomConfig.minPercent) % zoomConfig.stepPercent !== 0 ||
      typeof state.accepted !== "boolean"
    )
      return;
    const responseMatchesWheelRequest =
      zoomRequestInFlight !== null && state.percent === zoomRequestInFlight;
    zoomRequestInFlight = null;
    if (!state.accepted || !responseMatchesWheelRequest) {
      desiredZoomPercent = state.percent;
      wheelRemainder = 0;
    }
    zoomPercent = state.percent;
    layout();
    reportLayout();
    if (
      state.accepted &&
      responseMatchesWheelRequest &&
      desiredZoomPercent !== zoomPercent
    )
      requestZoom();
  };

  const handleWheel = (event: WheelEvent): void => {
    if (
      drag.active ||
      dragging ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * window.innerHeight
          : event.deltaY;
    if (!Number.isFinite(delta) || delta === 0) return;
    event.preventDefault();
    wheelRemainder += delta;
    const steps =
      wheelRemainder > 0
        ? Math.floor(wheelRemainder / 100)
        : Math.ceil(wheelRemainder / 100);
    wheelRemainder -= steps * 100;
    if (steps === 0) return;
    desiredZoomPercent = Math.min(
      Math.max(
        desiredZoomPercent - steps * zoomConfig.stepPercent,
        zoomConfig.minPercent,
      ),
      zoomConfig.maxPercent,
    );
    requestZoom();
  };

  // Subscribe before reporting the first layout so the initial main-process
  // response cannot be missed.
  const removeZoomListener = bridge.onZoomState(applyZoomState);
  const removeDwellListener =
    bridge.onIdleDwellState?.((state) => {
      if (
        Number.isInteger(state.dwellSeconds) &&
        (state.dwellSeconds as unknown as number) >= 1 && (state.dwellSeconds as unknown as number) <= 3600
      )
        dwellSeconds = state.dwellSeconds;
    }) ?? (() => {});
  hit.addEventListener("wheel", handleWheel, { passive: false });
  const onResize = (): void => {
    layout();
    reportLayout();
  };
  window.addEventListener("resize", onResize);
  layout();
  reportLayout();
  startStatic();

  const destroy = (): void => {
    hit.removeEventListener("pointerdown", handlePointerDown);
    hit.removeEventListener("pointermove", handlePointerMove);
    hit.removeEventListener("pointerup", handlePointerUp);
    hit.removeEventListener("pointercancel", handlePointerCancel);
    hit.removeEventListener("click", handleClick);
    hit.removeEventListener("wheel", handleWheel);
    window.removeEventListener("resize", onResize);
    removeZoomListener();
    removeDwellListener();
    clearRestTimer();
    if (pendingDragFrame !== null) caf(pendingDragFrame);
    pendingDragFrame = null;
    pendingDragPosition = null;
  };

  return {
    getState: () => ({ anim, once, facing, dragging }),
    destroy,
  };
}

// Self-bootstrap when the pet page is loaded (not in unit tests, where the
// vitest jsdom document has no #pet-root).
const bootRoot = document.getElementById("pet-root");
if (bootRoot) {
  initPet({
    root: bootRoot,
    stage: document.getElementById("pet-stage") as HTMLElement,
    videoA: document.getElementById("pet-video-a") as HTMLVideoElement,
    videoB: document.getElementById("pet-video-b") as HTMLVideoElement,
    staticImg: document.getElementById("pet-static") as HTMLImageElement,
    hit: document.getElementById("pet-hit") as HTMLElement,
    bridge: window.pet,
  });
}
