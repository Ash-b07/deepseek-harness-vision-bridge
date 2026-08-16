#!/usr/bin/env node
/**
 * 对 DSH 0.1.0-rc.6 的 api-proxy 做最小、可验证、可回滚的视觉增强补丁：
 * 1. 视觉增强开启时，纯文本主模型也允许会话接收图片；
 * 2. 模型目录额外返回 inputModalities，供独立视觉选择器过滤。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MARKER = 'vision-bridge-v2 host integration';
const mode = process.argv[2];
const targets = process.argv.slice(3).map((path) => resolve(path));

if (!['--apply', '--check', '--revert'].includes(mode) || targets.length === 0) {
  console.error('用法: node host-patch.mjs --apply|--check|--revert <dsh-host-apiproxy/lib/index.js> [...]');
  process.exit(2);
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function patched(text) {
  return text.includes(MARKER);
}

function applyPatch(path) {
  const original = readFileSync(path, 'utf8');
  if (patched(original)) {
    const legacyLookup = 'return ctx.get("settings")?.get("vision-bridge")?.enabled === true;';
    const injectNeedle = '\t\t"llm",\n\t\t"sessions",';
    const exposureNeedle = '\t"web-search-deepseek"\n];';
    let upgraded = original.replace(
      legacyLookup,
      'return ctx.settings?.get("vision-bridge")?.enabled === true;',
    );
    if (!upgraded.includes('\t\t"settings",\n\t\t"sessions",')) {
      upgraded = upgraded.replace(injectNeedle, '\t\t"llm",\n\t\t"settings",\n\t\t"sessions",');
    }
    if (!upgraded.includes('\t"vision-bridge"\n];')) {
      upgraded = upgraded.replace(
        exposureNeedle,
        '\t"web-search-deepseek",\n\t"vision-bridge"\n];',
      );
    }
    if (upgraded !== original) {
      writeFileSync(path, upgraded, 'utf8');
      console.log(`[已升级] ${path}`);
      return;
    }
    console.log(`[已安装] ${path}`);
    return;
  }

  const schemaNeedle = '\treasoning: modelReasoningSchema.optional()\n});';
  const schemaReplacement =
    '\treasoning: modelReasoningSchema.optional(),\n' +
    '\tinputModalities: z$1.array(z$1.string()).optional()\n' +
    '});';
  const catalogNeedle =
    '\t\t\t\t\t...model.description === void 0 ? {} : { description: model.description },\n' +
    '\t\t\t\t\t...reasoning === void 0 ? {} : { reasoning }';
  const catalogReplacement =
    '\t\t\t\t\t...model.description === void 0 ? {} : { description: model.description },\n' +
    '\t\t\t\t\t...reasoning === void 0 ? {} : { reasoning },\n' +
    '\t\t\t\t\t...resolved.inputModalities === void 0 ? {} : { inputModalities: [...resolved.inputModalities] }';
  const helperAnchor = '/** Wrap an error result echoing the request\'s rpcId. */';
  const helper =
    `/** ${MARKER}: the plugin owns the setting; api-proxy only consults it at admission time. */\n` +
    'function visionBridgeAllowsImages(ctx) {\n' +
    '\treturn ctx.settings?.get("vision-bridge")?.enabled === true;\n' +
    '}\n';
  const gateInfo = 'if (info.inputModalities !== void 0 && !info.inputModalities.includes("image")) return err(request, {';
  const gateModelInfo = 'if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {';
  const injectNeedle = '\t\t"llm",\n\t\t"sessions",';
  const exposureNeedle = '\t"web-search-deepseek"\n];';

  const requirements = [
    [schemaNeedle, 1, 'model catalog schema'],
    [catalogNeedle, 1, 'model catalog projection'],
    [helperAnchor, 1, 'helper anchor'],
    [gateInfo, 1, 'session model-switch admission'],
    [gateModelInfo, 1, 'prompt image admission'],
    [injectNeedle, 1, 'api-proxy settings injection'],
    [exposureNeedle, 1, 'web settings exposure list'],
  ];
  for (const [needle, expected, label] of requirements) {
    const actual = count(original, needle);
    if (actual !== expected) {
      throw new Error(`${path}: ${label} 签名不匹配（期望 ${expected}，实际 ${actual}）；未写入。宿主版本可能已变化。`);
    }
  }

  let next = original
    .replace(schemaNeedle, schemaReplacement)
    .replace(catalogNeedle, catalogReplacement)
    .replace(helperAnchor, `${helper}${helperAnchor}`)
    .replace(injectNeedle, '\t\t"llm",\n\t\t"settings",\n\t\t"sessions",')
    .replace(exposureNeedle, '\t"web-search-deepseek",\n\t"vision-bridge"\n];')
    .replace(gateInfo, `if (!visionBridgeAllowsImages(ctx) && info.inputModalities !== void 0 && !info.inputModalities.includes("image")) return err(request, {`)
    .replace(gateModelInfo, `if (!visionBridgeAllowsImages(ctx) && modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {`);

  const backup = `${path}.vision-bridge-v2.original`;
  if (!existsSync(backup)) copyFileSync(path, backup);
  writeFileSync(path, next, 'utf8');
  console.log(`[已安装] ${path}`);
  console.log(`[原始备份] ${backup}`);
}

function revert(path) {
  const backup = `${path}.vision-bridge-v2.original`;
  if (!existsSync(backup)) throw new Error(`${path}: 未找到备份 ${backup}`);
  copyFileSync(backup, path);
  console.log(`[已回滚] ${path}`);
}

let failed = false;
for (const target of targets) {
  try {
    if (!existsSync(target)) {
      console.log(`[跳过] 不存在: ${target}`);
      continue;
    }
    if (mode === '--apply') applyPatch(target);
    else if (mode === '--revert') revert(target);
    else {
      const ok = patched(readFileSync(target, 'utf8'));
      console.log(`[${ok ? '已安装' : '未安装'}] ${target}`);
      if (!ok) failed = true;
    }
  } catch (error) {
    failed = true;
    console.error(`[失败] ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) process.exit(1);
