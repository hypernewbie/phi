/**
 * jsdom unit tests for src/pet-view.ts: pure chain helpers (pickNextKind,
 * pick, planMove) + the initPet state machine (ended transitions, the
 * drag-stall fix, drag delta reporting). Deterministic Math.random is
 * injected via opts.rng so the chain picks are exact.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTS,
  CLICKS,
  IDLE,
  TURN,
  initPet,
  pick,
  pickNextKind,
  planMove,
  randomBetween,
} from '../src/pet-view.js';
import type { TerritoryBounds } from '../src/pet-bridge.js';

function buildDom() {
  const root = document.createElement('div');
  root.id = 'pet-root';
  const stage = document.createElement('div');
  stage.id = 'pet-stage';
  const videoA = document.createElement('video');
  videoA.id = 'pet-video-a';
  videoA.className = 'is-front';
  const videoB = document.createElement('video');
  videoB.id = 'pet-video-b';
  const hit = document.createElement('div');
  hit.id = 'pet-hit';
  stage.append(videoA, videoB, hit);
  root.append(stage);
  document.body.replaceChildren(root);
  return { root, stage, videoA, videoB, hit };
}

function makeBridge() {
  return {
    sendHit: vi.fn(),
    sendMove: vi.fn(),
    reportStageLayout: vi.fn(),
    onTerritoryBounds: vi.fn((_listener: (bounds: TerritoryBounds) => void) => () => {}),
  };
}

function ready(video: HTMLVideoElement): void {
  video.dispatchEvent(new Event('loadeddata'));
}

function mockStageRect(stage: HTMLElement, rect = { x: 12, y: 34, width: 200, height: 112.5 }): void {
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height, toJSON: () => ({}) } as DOMRect);
}

const fixedRng = (value: number) => () => value;

beforeEach(() => {
  document.body.replaceChildren();
});

describe('pickNextKind (chain distribution thresholds)', () => {
  it('maps roll < 0.3 → IDLE, < 0.4 → TURN, < 0.8 → ACTS, else MOVE', () => {
    expect(pickNextKind(0.0)).toBe('IDLE');
    expect(pickNextKind(0.29)).toBe('IDLE');
    expect(pickNextKind(0.3)).toBe('TURN');
    expect(pickNextKind(0.39)).toBe('TURN');
    expect(pickNextKind(0.4)).toBe('ACTS');
    expect(pickNextKind(0.79)).toBe('ACTS');
    expect(pickNextKind(0.8)).toBe('MOVE');
    expect(pickNextKind(0.99)).toBe('MOVE');
  });
});

describe('pick + randomBetween', () => {
  it('picks the element at rng()*len with an exclude filter', () => {
    const rng = vi.fn().mockReturnValue(0.5);
    expect(pick(['a', 'b'], null, rng)).toBe('b'); // floor(0.5*2)=1
    expect(pick(['a', 'b', 'c'], 'b', rng)).toBe('c'); // filtered ['a','c'], floor(0.5*2)=1 → 'c'
  });
  it('randomBetween returns [min,max) via floor(min + rng*(max-min))', () => {
    expect(randomBetween(60, 240, () => 0.0)).toBe(60);
    expect(randomBetween(60, 240, () => 0.999)).toBe(239);
  });

  it('ACTS holds exactly 42 unique act names', () => {
    expect(ACTS.length).toBe(42);
    expect(new Set(ACTS).size).toBe(42);
    // Every act must have a matching webm on disk (the catalog is
    // hardcoded upstream client.js:108-152; drift breaks playback).
    for (const name of ACTS) {
      expect(typeof name).toBe('string');
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe('planMove (bounds check + ratio plan)', () => {
  it('rejects a target left of the safe margin', () => {
    expect(
      planMove({ cx: 256, cy: 200, W: 1024, H: 768, halfW: 256, facing: 'left', turning: false, distance: 100 }),
    ).toBeNull();
  });
  it('accepts an in-bounds target and plans the ratios', () => {
    const plan = planMove({ cx: 256, cy: 200, W: 1024, H: 768, halfW: 256, facing: 'right', turning: false, distance: 100 });
    expect(plan?.dir).toBe(1);
    expect(plan?.startRatio).toBe(256 / 1024);
    expect(plan?.targetRatio).toBe(356 / 1024);
  });
  it('inverts the direction when a TURN just ended (facing is about to flip)', () => {
    const plan = planMove({ cx: 600, cy: 200, W: 1024, H: 768, halfW: 256, facing: 'left', turning: true, distance: 100 });
    // facing left + turning → actual facing right → dir +1
    expect(plan?.dir).toBe(1);
  });
});

describe('initPet state machine', () => {
  it('starts idle, one-shot, facing left', () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({ ...dom, bridge, rng: () => 0.5, raf: () => 0, caf: () => {} });
    expect(pet.getState()).toMatchObject({ anim: IDLE, once: true, facing: 'left' });
  });

  it('advances the chain on ended (IDLE → TURN at roll 0.35)', () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({ ...dom, bridge, rng: fixedRng(0.35), raf: () => 0, caf: () => {} });
    ready(dom.videoB);
    dom.videoB.dispatchEvent(new Event('ended'));
    expect(pet.getState().anim).toBe(TURN);
  });

  it('flips facing after TURN ends', () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const rng = vi.fn().mockReturnValueOnce(0.35).mockReturnValueOnce(0.0);
    const pet = initPet({ ...dom, bridge, rng, raf: () => 0, caf: () => {} });
    ready(dom.videoB);
    dom.videoB.dispatchEvent(new Event('ended')); // → TURN
    ready(dom.videoA);
    dom.videoA.dispatchEvent(new Event('ended')); // TURN ends → flip + next
    expect(pet.getState().facing).toBe('right');
    expect(pet.getState().anim).toBe(IDLE);
  });

  it('returns to idle (buffer) after a click animation ends', () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({ ...dom, bridge, rng: fixedRng(0.5), raf: () => 0, caf: () => {} });
    ready(dom.videoB);
    dom.hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(CLICKS).toContain(pet.getState().anim);
    ready(dom.videoA);
    dom.videoA.dispatchEvent(new Event('ended')); // click ends → IDLE buffer
    expect(pet.getState().anim).toBe(IDLE);
    expect(pet.getState().once).toBe(true);
  });

  it('resumes the chain after drag release with once=true (drag-stall fix) and reports the delta', () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    const pet = initPet({ ...dom, bridge, rng: fixedRng(0.5), raf: () => 0, caf: () => {} });
    dom.hit.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    dom.hit.dispatchEvent(new MouseEvent('pointermove', { clientX: 140, clientY: 100, bubbles: true }));
    dom.hit.dispatchEvent(new MouseEvent('pointerup', { clientX: 140, clientY: 100, bubbles: true }));
    expect(pet.getState().anim).toBe(IDLE);
    expect(pet.getState().once).toBe(true); // was false upstream (client.js:577 bug)
    expect(bridge.sendMove).toHaveBeenCalledWith(expect.objectContaining({ dx: 40, dy: 0, stage: { x: 12, y: 34, width: 200, height: 112.5 } }));
  });

  it('subscribes before the first layout report and keeps preview inside returned territory', () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let listener: ((bounds: { minStageX: number; maxStageX: number; minStageY: number; maxStageY: number }) => void) | undefined;
    bridge.onTerritoryBounds.mockImplementation((next) => { listener = next; return () => {}; });
    initPet({ ...dom, bridge, rng: fixedRng(0.5), raf: () => 0, caf: () => {} });
    expect(bridge.onTerritoryBounds.mock.invocationCallOrder[0]).toBeLessThan(bridge.reportStageLayout.mock.invocationCallOrder[0]);
    listener?.({ minStageX: 100, maxStageX: 110, minStageY: 24, maxStageY: 24 });
    dom.hit.dispatchEvent(new MouseEvent('pointerdown', { clientX: 100, clientY: 100, bubbles: true }));
    dom.hit.dispatchEvent(new MouseEvent('pointermove', { clientX: 600, clientY: 500, bubbles: true }));
    expect(dom.root.style.transform).toBe('translate(110px, 0px)');
  });

  it('cancels a drag without sending a move', () => {
    const dom = buildDom(); const bridge = makeBridge();
    initPet({ ...dom, bridge, rng: fixedRng(0.5), raf: () => 0, caf: () => {} });
    dom.hit.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));
    dom.hit.dispatchEvent(new MouseEvent('pointermove', { clientX: 30, clientY: 10, bubbles: true }));
    dom.hit.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }));
    expect(bridge.sendMove).not.toHaveBeenCalled();
  });

  it('reports recomputed layout on resize and ignores ended events from an outgoing buffer', () => {
    const dom = buildDom(); const bridge = makeBridge();
    const pet = initPet({ ...dom, bridge, rng: fixedRng(0.35), raf: () => 0, caf: () => {} });
    ready(dom.videoB);
    dom.hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    ready(dom.videoA);
    dom.videoB.dispatchEvent(new Event('ended'));
    expect(CLICKS).toContain(pet.getState().anim);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));
    expect(dom.root.style.width).toBe('400px');
    expect(bridge.reportStageLayout).toHaveBeenCalledTimes(2);
    dom.videoA.dispatchEvent(new Event('ended'));
    expect(pet.getState().anim).toBe(IDLE);
  });
});
