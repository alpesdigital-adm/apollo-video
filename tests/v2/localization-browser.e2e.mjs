import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrismaClient } from "../../generated/prisma-v2/index.js";
import { assertIsolatedDatabase } from "./helpers/capture-journey.mjs";
import { createLocalizationPgFixture } from "./helpers/localization-pg.mjs";

const enabled = process.env.APOLLO_LOCALIZATION_BROWSER_E2E === "1";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}
async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Next production server exited with ${child.exitCode}`);
    try {
      if (
        (
          await fetch(`${url}/v1/health`, {
            signal: AbortSignal.timeout(1_000),
          })
        ).ok
      )
        return;
    } catch {}
    await delay(250);
  }
  throw new Error(
    "Next production server did not become ready within 30 seconds",
  );
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  child.kill("SIGTERM");
  let timer;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  clearTimeout(timer);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    let killTimer;
    const killed = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        killTimer = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    clearTimeout(killTimer);
    if (!killed)
      throw new Error(
        `Next production server PID ${child.pid} ignored SIGKILL`,
      );
  }
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`Next production server PID ${child.pid} did not stop`);
}

test(
  "localization UI creates a distinct locale profile and variant and exposes provider preflight refusal",
  { skip: !enabled, timeout: 70_000 },
  async () => {
    assertIsolatedDatabase();
    const { createUiPasswordHash } =
      await import("../../src/v2/infrastructure/security/ui-session.ts");
    const prisma = new PrismaClient({
        datasources: { db: { url: process.env.V2_DATABASE_URL } },
      }),
      root = await mkdtemp(join(tmpdir(), "apollo-localization-browser-"));
    let fixture, browser, server, testFailure;
    const cleanupErrors = [];
    try {
      fixture = await createLocalizationPgFixture(prisma);
      const original = await prisma.v2MediaArtifact.findUniqueOrThrow({
        where: { id: fixture.artifactId },
        select: { sha256: true, byteSize: true },
      });
      const username = `locale-ui-${fixture.suffix}`,
        password = `Localization-${fixture.suffix}-secure`,
        port = await freePort(),
        baseUrl = `http://127.0.0.1:${port}`;
      let serverLogs = "";
      server = spawn(
        process.execPath,
        ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "production",
            __NEXT_PROCESSED_ENV: "true",
            APOLLO_API_ENVIRONMENT: "production",
            APOLLO_AUTH_MODE: "bootstrap",
            APOLLO_ALLOW_BOOTSTRAP_AUTH: "true",
            APOLLO_UI_BOOTSTRAP_ROLE: "operator",
            APOLLO_UI_USERNAME: username,
            APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(
              password,
              `locale-salt-${fixture.suffix}`,
            ),
            APOLLO_UI_SESSION_SECRET: `locale-session-${fixture.suffix}-at-least-32-bytes`,
            APOLLO_UI_API_CLIENT_ID: fixture.issued.client.id,
            APOLLO_V2_ARTIFACT_ROOT: root,
            APOLLO_V2_ARTIFACT_STORAGE_DRIVER: "local",
            APOLLO_LOCALIZATION_PROVIDER_BASE_URL: "",
            APOLLO_LOCALIZATION_PROVIDER_API_KEY: "",
            APOLLO_LOCALIZATION_PROVIDER_MODEL: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      server.stdout.on("data", (chunk) => {
        serverLogs += String(chunk);
      });
      server.stderr.on("data", (chunk) => {
        serverLogs += String(chunk);
      });
      await waitForServer(baseUrl, server);
      const executablePath = [
        process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
      ].find((candidate) => candidate && existsSync(candidate));
      assert.ok(
        executablePath,
        "set PLAYWRIGHT_CHROME_EXECUTABLE to a Chromium executable",
      );
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath, headless: true });
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1200 },
      });
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(20_000);
      const page = await context.newPage();
      const apiResponses = [];
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.origin !== baseUrl || !url.pathname.startsWith("/v1/")) return;
        const entry = {
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        };
        apiResponses.push(entry);
        if (apiResponses.length > 50) apiResponses.shift();
        if (response.status() >= 400)
          void response
            .json()
            .then((body) => {
              entry.code = body?.error?.code;
            })
            .catch((error) => {
              entry.code = `response-body-unavailable:${error instanceof Error ? error.name : "unknown"}`;
            });
      });
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        if (url.origin !== baseUrl || !url.pathname.startsWith("/v1/")) return;
        apiResponses.push({
          method: request.method(),
          path: url.pathname,
          status: "request-failed",
          code: request.failure()?.errorText,
        });
      });
      await page.goto(
        `${baseUrl}/login?next=${encodeURIComponent("/localization")}`,
      );
      await page.locator('input[name="username"]').fill(username);
      await page.locator('input[name="password"]').fill(password);
      await page.getByRole("button", { name: "Entrar no Apollo" }).click();
      await page.waitForURL("**/localization**");
      await page.getByRole("heading", { name: "Localização" }).waitFor();
      await page.getByLabel("Novo locale").fill("x");
      const invalidProfileResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/v1/localization-profiles"),
      );
      await page.getByTestId("create-localization-profile").click();
      const invalidProfile = await invalidProfileResponse;
      const invalidText = await invalidProfile.text();
      assert.equal(invalidProfile.status(), 422);
      let invalidBody;
      try {
        invalidBody = JSON.parse(invalidText);
      } catch {
        assert.fail(
          `invalid locale returned non-JSON: ${invalidText.slice(0, 500)}\n${serverLogs.slice(-2_000)}`,
        );
      }
      assert.equal(
        invalidBody.error.code,
        "INVALID_ARGUMENT",
        `${invalidText}\n${serverLogs.slice(-2_000)}`,
      );
      assert.equal(
        await prisma.v2LocalizationProfile.count({
          where: { workspaceId: fixture.workspaceId, targetLocale: "x" },
        }),
        0,
      );
      await page.getByLabel("Novo locale").fill("fr-FR");
      await page.getByLabel("Mercado", { exact: true }).fill("FR");
      const createdProfileResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/v1/localization-profiles"),
      );
      await page.getByTestId("create-localization-profile").click();
      const createdProfile = await createdProfileResponse;
      assert.ok(
        [200, 201].includes(createdProfile.status()),
        `profile POST returned ${createdProfile.status()}: ${(await createdProfile.text()).slice(0, 500)}\n${serverLogs.slice(-2_000)}`,
      );
      try {
        await page
          .getByLabel("Perfil de idioma e mercado")
          .selectOption({ label: "fr-FR · FR" });
      } catch (error) {
        const pageText = await page
          .locator("body")
          .innerText()
          .catch(
            (bodyError) =>
              `<page body unavailable: ${bodyError instanceof Error ? bodyError.message : String(bodyError)}>`,
          );
        throw new Error(
          `created profile was not selectable\nAPI responses: ${JSON.stringify(apiResponses)}\nPage: ${pageText.slice(-3_000)}\nServer: ${serverLogs.slice(-3_000)}`,
          { cause: error },
        );
      }
      const profile = await prisma.v2LocalizationProfile.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspaceId,
          targetLocale: "fr-FR",
          market: "FR",
        },
      });
      assert.notEqual(profile.id, fixture.profile.id);
      await page.getByRole("button", { name: "Criar variante" }).click();
      await page.getByRole("button", { name: /fr-FR/ }).waitFor();
      const variant = await prisma.v2LocalizationVariantHead.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          profileId: profile.id,
        },
      });
      assert.notEqual(variant.id, fixture.variant.id);
      const preflightResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .includes(
              `/localization-variants/${variant.id}/translation-preflight`,
            ),
      );
      await page.getByTestId("translation-preflight-required").click();
      const refused = await preflightResponse;
      assert.ok(
        refused.status() >= 400,
        `missing provider config unexpectedly returned ${refused.status()}`,
      );
      const refusal = await refused.json();
      assert.equal(refusal.error.code, "PERSISTENCE_NOT_CONFIGURED");
      await page
        .getByText(/configurad|provider|tradução/i)
        .last()
        .waitFor();
      assert.equal(
        await prisma.v2LocalizationTranslationPreflight.count({
          where: {
            workspaceId: fixture.workspaceId,
            variantId: variant.id,
          },
        }),
        0,
      );
      const preserved = await prisma.v2MediaArtifact.findUniqueOrThrow({
        where: { id: fixture.artifactId },
        select: { sha256: true, byteSize: true },
      });
      assert.deepEqual(preserved, original);
      assert.equal(
        await prisma.v2ProjectMediaAsset.count({
          where: {
            workspaceId: fixture.workspaceId,
            projectId: fixture.projectId,
            artifactId: fixture.artifactId,
          },
        }),
        1,
      );
      console.log(
        `localization-browser profile=${profile.id} variant=${variant.id} preflight=${refused.status()} ${refusal.error.code} serverPid=${server.pid}`,
      );
    } catch (error) {
      testFailure = error;
      throw error;
    } finally {
      if (browser)
        try {
          await browser.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      try {
        await stopChild(server);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (fixture) {
        try {
          await prisma.v2UiSession.deleteMany({
            where: { workspaceId: fixture.workspaceId },
          });
          await prisma.v2WorkspaceUiPrincipal.deleteMany({
            where: { workspaceId: fixture.workspaceId },
          });
          await fixture.cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await prisma.$disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          testFailure ? [testFailure, ...cleanupErrors] : cleanupErrors,
          "Localization browser E2E cleanup failed",
        );
    }
  },
);
