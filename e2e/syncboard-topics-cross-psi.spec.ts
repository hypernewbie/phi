import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { startPhi, type PhiServer } from "./_server.js";
import {
  startTopicsProvider,
  TOPICS_KEY,
  TOPICS_LARGE,
  TOPICS_MARKER,
  TOPICS_MODEL,
  TOPICS_PROVIDER,
  type TopicsProvider,
} from "./_pi-syncboard-topics.js";

const PSI_BIN = process.env.PSI_E2E_BIN ?? "";
const PEER = "sync-f1";
const SECRET = "a".repeat(64);

function allowPeerSetup(dir: string) {
  appendFileSync(
    join(dir, "home", ".phi", "config.toml"),
    `\n[sync_topics_allowed_peers]\n"${PEER}" = "${SECRET}"\n`,
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

async function waitForPsi(
  request: APIRequestContext,
  owner: PhiServer,
  pane: string,
) {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${owner.url}/api/terminals`);
        const tabs = (await r.json()) as Array<{
          id: string;
          pi_bridge?: { state?: string; capabilities?: string[] };
        }>;
        return tabs.find((tab) => tab.id === pane)?.pi_bridge;
      },
      { timeout: 30_000 },
    )
    .toMatchObject({
      state: "managed",
      capabilities: expect.arrayContaining([
        "pi.syncboard.topics.v1",
        "pi.syncboard.v1",
      ]),
    });
}

test("follower Psi receives a coordinator topic post", async ({ request }) => {
  test.skip(!PSI_BIN, "PSI_E2E_BIN must name the built psi binary");
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
    follower = await startPhi({
      config: {
        auto_reconnect: "off",
        sync_coordinator: coordinator.url,
        sync_topics_peer_id: PEER,
        sync_topics_peer_secret: SECRET,
        psi_command: PSI_BIN,
      },
      env: (dir) => ({
        PSI_CODING_AGENT_DIR: join(dir, "psi-agent"),
        PI_CODING_AGENT_SESSION_DIR: join(dir, "psi-sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
      }),
      setup(dir) {
        const agent = join(dir, "psi-agent");
        const work = join(dir, "work");
        mkdirSync(agent, { recursive: true });
        mkdirSync(work, { recursive: true });
        writeFileSync(
          join(agent, "settings.json"),
          JSON.stringify({
            defaultProvider: TOPICS_PROVIDER,
            defaultModel: TOPICS_MODEL,
            defaultThinkingLevel: "off",
            defaultProjectTrust: "never",
            quietStartup: true,
            compaction: { enabled: false },
            retry: { enabled: false },
          }),
        );
        writeFileSync(
          join(agent, "models.json"),
          JSON.stringify({
            providers: {
              [TOPICS_PROVIDER]: {
                baseUrl: `http://127.0.0.1:${provider!.port}`,
                api: "anthropic-messages",
                apiKey: "syncboard-topics-psi-fixture-key",
                models: [
                  {
                    id: TOPICS_MODEL,
                    name: "Topics fixture",
                    contextWindow: 64_000,
                    maxTokens: 16384,
                  },
                ],
              },
            },
          }),
        );
      },
    });
    await waitForPeer(request, follower);
    const work = realpathSync(join(follower.dir, "work"));
    const created = await request.post(`${follower.url}/api/terminals`, {
      data: { coder: "pi", pi_psi: true, cwd: work, title: "Topics Psi" },
    });
    expect(created.ok()).toBe(true);
    const pane = ((await created.json()) as { pane_id: string }).pane_id;
    await waitForPsi(request, follower, pane);
    const prompt = await request.post(
      `${follower.url}/api/terminals/${pane}/input`,
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

    const posted = await request.post(`${coordinator.url}/api/sync/messages`, {
      data: {
        key: TOPICS_KEY,
        value: { marker: TOPICS_MARKER, text: TOPICS_LARGE },
      },
    });
    expect(posted.ok()).toBe(true);
    await provider.waitForRequestCount(3, 30_000);
    await expect
      .poll(() => provider!.deliveryChecked(), { timeout: 30_000 })
      .toBe(true);
    expect(provider.error()).toBe("");
  } finally {
    await follower?.stop();
    await coordinator?.stop();
    await provider?.close();
  }
});
