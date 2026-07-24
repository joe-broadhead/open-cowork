import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANNEL_ADAPTER_CAPABILITY_KEYS,
  DUAL_STACK_OVERLAP_PROVIDERS,
} from "@open-cowork/shared";
import {
  assertMonorepoProviderCapabilities,
  reportMonorepoProviderCapabilities,
  type ChannelCapabilities,
} from "@open-cowork/gateway-channel";

function sampleTelegramCaps(): ChannelCapabilities {
  return {
    threads: true,
    messageEditing: true,
    inlineButtons: true,
    fileUploads: true,
    fileDownloads: true,
    typingIndicator: true,
    maxTextLength: 4096,
    preferredParseMode: "plain",
    parseModes: ["plain"],
    editSemantics: "message",
  };
}

test("shared dual-stack contract keys cover Durable adapter categories", () => {
  assert.equal(CHANNEL_ADAPTER_CAPABILITY_KEYS.length, 12);
  assert.ok(CHANNEL_ADAPTER_CAPABILITY_KEYS.includes("richText"));
  assert.ok(CHANNEL_ADAPTER_CAPABILITY_KEYS.includes("fallbackBehavior"));
  assert.deepEqual([...DUAL_STACK_OVERLAP_PROVIDERS], ["telegram", "whatsapp", "discord"]);
});

test("monorepo capability snapshots map to complete adapter categories", () => {
  const report = reportMonorepoProviderCapabilities("telegram", sampleTelegramCaps());
  assert.equal(report.ok, true, report.violations.join("; "));
  assert.equal(report.categoryMap.threading, "supported");
  assert.equal(report.categoryMap.filesMedia, "supported");
  assert.equal(report.categoryMap.inlineActions, "partial");
  assert.equal(report.categoryMap.edits, "supported");
  assertMonorepoProviderCapabilities("telegram", sampleTelegramCaps());
});

test("monorepo capability contract fails closed on incomplete snapshots", () => {
  assert.throws(
    () =>
      assertMonorepoProviderCapabilities("broken", {
        threads: true,
        messageEditing: false,
        inlineButtons: false,
        fileUploads: false,
        fileDownloads: false,
        typingIndicator: false,
        maxTextLength: 0,
        preferredParseMode: "plain",
      }),
    /maxTextLength|missing monorepo capability/,
  );
});
