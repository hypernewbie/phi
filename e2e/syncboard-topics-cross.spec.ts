import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { startPhi, type PhiServer } from "./_server.js";
import {
  readTopicsObserver,
  seedTopicsPi,
  startTopicsProvider,
  TOPICS_KEY,
  TOPICS_LARGE,
  TOPICS_MARKER,
  type TopicsProvider,
} from "./_pi-syncboard-topics.js";

const PEER = "sync-f1";
const SECRET = "a".repeat(64);

function allowPeerSetup(dir: string) {
  appendFileSync(
    join(dir, "home", ".phi", "config.toml"),
    `\n[sync_topics_allowed_peers]\n"${PEER}" = "${SECRET}"\n`,
  );
}

async function spawnPi(request: APIRequestContext, owner: PhiServer) {
  const response = await request.post(`${owner.url}/api/terminals`, {
    data: { coder: "pi", cwd: realpathSync(owner.dir), title: "Topics Pi" },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { pane_id: string }).pane_id;
}

async function waitForSubscribe(
  request: APIRequestContext,
  owner: PhiServer,
  paneID: string,
) {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${owner.url}/api/terminals`);
        const tabs = (await r.json()) as Array<{
          id: string;
          pi_bridge?: { capabilities?: string[] };
        }>;
        return tabs.find((tab) => tab.id === paneID)?.pi_bridge?.capabilities;
      },
      { timeout: 30_000 },
    )
    .toEqual(
      expect.arrayContaining([
        "pi.syncboard.topics.v1",
        "pi.syncboard.push.v1",
      ]),
    );
}

async function waitForPeer(request: APIRequestContext, follower: PhiServer) {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${follower.url}/api/sync/topics/status`);
        if (!r.ok()) return false;
        return ((await r.json()) as { peer_connected?: boolean })
          .peer_connected;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test("coordinator post reaches a follower Pi subscriber", async ({
  request,
}) => {
  test.setTimeout(180_000);
  let coordinator: PhiServer | undefined;
  let follower: PhiServer | undefined;
  let provider: TopicsProvider | undefined;
  try {
    coordinator = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
      },
      setup: allowPeerSetup,
    });
    provider = await startTopicsProvider();
    let fixture: ReturnType<typeof seedTopicsPi> | undefined;
    follower = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_coordinator: coordinator.url,
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
      },
      env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      setup(dir) {
        allowPeerSetup(dir);
        fixture = seedTopicsPi(dir, provider!.port);
      },
    });
    if (!fixture) throw new Error("topics Pi fixture was not seeded");
    await waitForPeer(request, follower);
    const paneID = await spawnPi(request, follower);
    await waitForSubscribe(request, follower, paneID);
    await expect
      .poll(() => readTopicsObserver(fixture!.observerPath), {
        timeout: 30_000,
      })
      .toContainEqual(expect.objectContaining({ available: true }));

    const prompt = await request.post(
      `${follower.url}/api/terminals/${paneID}/input`,
      {
        data: {
          text: `Subscribe to topic ${TOPICS_KEY}. Do not call another tool after the subscribe result.`,
        },
      },
    );
    expect(prompt.status()).toBe(204);
    await provider.waitForRequestCount(2, 30_000);
    await provider.waitForResult(30_000);
    expect(provider.resultChecked()).toBe(true);
    expect(provider.error()).toBe("");

    const posted = await request.post(`${coordinator.url}/api/sync/messages`, {
      data: {
        key: TOPICS_KEY,
        value: {
          marker: TOPICS_MARKER,
          text: TOPICS_LARGE,
          cross: "cross-c-f",
        },
      },
    });
    expect(posted.ok()).toBe(true);
    await provider.waitForRequestCount(3, 30_000);
    await expect
      .poll(() => provider!.deliveryChecked(), { timeout: 30_000 })
      .toBe(true);
    expect(provider.error()).toBe("");
    expect(provider.bodies()[2]).toContain("cross-c-f");
  } finally {
    await follower?.stop();
    await coordinator?.stop();
    await provider?.close();
  }
});

test("follower REST post is forwarded to the coordinator subscriber", async ({
  request,
}) => {
  test.setTimeout(180_000);
  let coordinator: PhiServer | undefined;
  let follower: PhiServer | undefined;
  let provider: TopicsProvider | undefined;
  try {
    provider = await startTopicsProvider();
    let fixture: ReturnType<typeof seedTopicsPi> | undefined;
    coordinator = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
      },
      env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      setup(dir) {
        allowPeerSetup(dir);
        fixture = seedTopicsPi(dir, provider!.port);
      },
    });
    follower = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_coordinator: coordinator.url,
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
      },
      setup: allowPeerSetup,
    });
    if (!fixture) throw new Error("topics Pi fixture was not seeded");
    const paneID = await spawnPi(request, coordinator);
    await waitForSubscribe(request, coordinator, paneID);
    await expect
      .poll(() => readTopicsObserver(fixture!.observerPath), {
        timeout: 30_000,
      })
      .toContainEqual(expect.objectContaining({ available: true }));

    const prompt = await request.post(
      `${coordinator.url}/api/terminals/${paneID}/input`,
      {
        data: {
          text: `Subscribe to topic ${TOPICS_KEY}. Do not call another tool after the subscribe result.`,
        },
      },
    );
    expect(prompt.status()).toBe(204);
    await provider.waitForRequestCount(2, 30_000);
    await provider.waitForResult(30_000);
    expect(provider.resultChecked()).toBe(true);

    const posted = await request.post(`${follower.url}/api/sync/messages`, {
      data: {
        key: TOPICS_KEY,
        value: {
          marker: TOPICS_MARKER,
          text: TOPICS_LARGE,
          cross: "cross-f-c",
        },
      },
    });
    expect(posted.ok()).toBe(true);
    await provider.waitForRequestCount(3, 30_000);
    await expect
      .poll(() => provider!.deliveryChecked(), { timeout: 30_000 })
      .toBe(true);
    expect(provider.error()).toBe("");
    expect(provider.bodies()[2]).toContain("cross-f-c");
  } finally {
    await follower?.stop();
    await coordinator?.stop();
    await provider?.close();
  }
});

test("follower Pi resubscribes after the coordinator epoch changes", async ({
  request,
}) => {
  test.setTimeout(180_000);
  let coordinator: PhiServer | undefined;
  let follower: PhiServer | undefined;
  let provider: TopicsProvider | undefined;
  try {
    coordinator = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
      },
      setup: allowPeerSetup,
    });
    provider = await startTopicsProvider();
    let fixture: ReturnType<typeof seedTopicsPi> | undefined;
    follower = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_coordinator: coordinator.url,
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
      },
      env: { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      setup(dir) {
        allowPeerSetup(dir);
        fixture = seedTopicsPi(dir, provider!.port);
      },
    });
    if (!fixture) throw new Error("topics Pi fixture was not seeded");
    await waitForPeer(request, follower);
    const paneID = await spawnPi(request, follower);
    await waitForSubscribe(request, follower, paneID);
    const prompt = await request.post(
      `${follower.url}/api/terminals/${paneID}/input`,
      {
        data: {
          text: `Subscribe to topic ${TOPICS_KEY}. Do not call another tool after the subscribe result.`,
        },
      },
    );
    expect(prompt.status()).toBe(204);
    await provider.waitForRequestCount(2, 30_000);
    await provider.waitForResult(30_000);
    expect(provider.resultChecked()).toBe(true);

    const firstPost = await request.post(
      `${coordinator.url}/api/sync/messages`,
      {
        data: {
          key: TOPICS_KEY,
          value: { marker: TOPICS_MARKER, text: TOPICS_LARGE },
        },
      },
    );
    expect(firstPost.ok()).toBe(true);
    await provider.waitForRequestCount(3, 30_000);
    await expect
      .poll(() => provider!.deliveryCount(), { timeout: 30_000 })
      .toBe(1);

    await coordinator.restart();
    await waitForPeer(request, follower);
    const secondPrompt = await request.post(
      `${follower.url}/api/terminals/${paneID}/input`,
      {
        data: {
          text: `Subscribe to topic ${TOPICS_KEY} again. Do not call another tool after the subscribe result.`,
        },
      },
    );
    expect(secondPrompt.status()).toBe(204);
    await provider.waitForRequestCount(5, 30_000);
    const secondPost = await request.post(
      `${coordinator.url}/api/sync/messages`,
      {
        data: {
          key: TOPICS_KEY,
          value: { marker: TOPICS_MARKER, text: TOPICS_LARGE },
        },
      },
    );
    expect(secondPost.ok()).toBe(true);
    await provider.waitForRequestCount(6, 30_000);
    await expect
      .poll(() => provider!.deliveryCount(), { timeout: 30_000 })
      .toBe(2);
    expect(provider.error()).toBe("");
  } finally {
    await follower?.stop();
    await coordinator?.stop();
    await provider?.close();
  }
});
